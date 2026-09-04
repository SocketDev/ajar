//! `ajar` — the runtime binary the native tray shells drive as a subprocess
//! (mirrors depsight's `scan --json` bridge). It owns the [`Runtime`] and:
//!   - emits a status line every second — NDJSON with `--json`, human text
//!     otherwise (the shell parses the JSON);
//!   - accepts control commands on stdin so the shell (which owns the platform
//!     battery/thermal readings + the UI) can steer it, one per line:
//!     `power <0..1> <ac|batt> [lowpower] [hot]`, `mode <agents|always>`, `quit`.
//!
//! The shell reads battery/thermal natively and forwards them here so the wake
//! guardrails (which live in the shared engine) apply uniformly on every OS.

use ajar_core::{Guards, KeepAwake, Power, Runtime, Status};
use std::io::{BufRead, Write};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

enum Cmd {
    Power(Power),
    Mode(KeepAwake),
    Quit,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("run") {
        eprintln!("usage: ajar run [--json]");
        std::process::exit(2);
    }
    run(args.iter().any(|a| a == "--json"));
}

fn run(json: bool) {
    let rt = Runtime::start(KeepAwake::WhileAgentsWork, Guards::default())
        .expect("failed to start ajar runtime");

    // stdin → commands, decoupled from the status loop via a channel so the loop
    // owns the runtime exclusively (no shared-mutability dance).
    let (tx, rx) = mpsc::channel::<Cmd>();
    thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if let Some(cmd) = parse_cmd(line.trim()) {
                let quit = matches!(cmd, Cmd::Quit);
                if tx.send(cmd).is_err() || quit {
                    break;
                }
            }
        }
    });

    loop {
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                Cmd::Power(p) => rt.set_power(p),
                Cmd::Mode(m) => rt.set_mode(m),
                // Returning drops `rt` → Runtime::drop → release. The shell can
                // also just SIGTERM us; the same release runs on drop.
                Cmd::Quit => return,
            }
        }
        emit_status(&rt, json);
        thread::sleep(Duration::from_secs(1));
    }
}

fn parse_cmd(line: &str) -> Option<Cmd> {
    let mut it = line.split_whitespace();
    match it.next()? {
        "power" => {
            let battery: f32 = it.next()?.parse().ok()?;
            let on_ac = matches!(it.next(), Some("ac"));
            let rest: Vec<&str> = it.collect();
            Some(Cmd::Power(Power {
                battery: battery.clamp(0.0, 1.0),
                on_ac,
                low_power_mode: rest.contains(&"lowpower"),
                thermal_hot: rest.contains(&"hot"),
            }))
        }
        "mode" => match it.next()? {
            "always" => Some(Cmd::Mode(KeepAwake::Always)),
            "agents" => Some(Cmd::Mode(KeepAwake::WhileAgentsWork)),
            _ => None,
        },
        "quit" => Some(Cmd::Quit),
        _ => None,
    }
}

fn emit_status(rt: &Runtime, json: bool) {
    let status = rt.status();
    let agents = rt.working_agents();
    if json {
        let (state, reason) = match status {
            Status::Awake => ("awake", ""),
            Status::Idle => ("idle", ""),
            Status::Blocked(b) => ("blocked", b.reason()),
        };
        let agents_json = agents
            .iter()
            .map(|a| format!("{{\"label\":\"{}\",\"working\":true}}", a.label()))
            .collect::<Vec<_>>()
            .join(",");
        println!("{{\"status\":\"{state}\",\"reason\":\"{reason}\",\"agents\":[{agents_json}]}}");
    } else {
        let labels: Vec<&str> = agents.iter().map(|a| a.label()).collect();
        println!("{status:?} · working: {labels:?}");
    }
    let _ = std::io::stdout().flush();
}
