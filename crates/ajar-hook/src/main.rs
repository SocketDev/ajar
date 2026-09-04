//! `ajar-hook` — the lifecycle-hook command + installer.
//!
//! - `ajar-hook report <working|idle|end>` — invoked BY an installed agent hook.
//!   Reads the agent's hook JSON on stdin (for the session id), detects which
//!   agent from its environment, and pings the running ajar app.
//! - `ajar-hook install` — merges ajar's hooks into the agent's config
//!   (`~/.claude/settings.json` today) so the reports above start flowing.
//!
//! `report` is best-effort: if ajar isn't running there's simply no one to tell.

use ajar_core::{detect_agent_from_env, send_ping, Agent, Ping};
use std::io::Read;
use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("report") => report(args.next().as_deref().unwrap_or("working")),
        Some("install") => install(),
        _ => {
            eprintln!("usage: ajar-hook <report <working|idle|end> | install>");
            std::process::exit(2);
        }
    }
}

/// Send one state report for the current agent + session.
fn report(state: &str) {
    let mut stdin = String::new();
    let _ = std::io::stdin().read_to_string(&mut stdin);
    let session = serde_json::from_str::<serde_json::Value>(&stdin)
        .ok()
        .and_then(|v| {
            v.get("session_id")
                .and_then(|s| s.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "default".to_string());
    // The hook runs inside the agent's process, so its env identifies it.
    let agent = detect_agent_from_env().unwrap_or(Agent::Claude);
    let ping = match state {
        "idle" => Ping::Idle { agent, session },
        "end" => Ping::End { agent, session },
        _ => Ping::Working { agent, session },
    };
    let _ = send_ping(&ping);
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn claude_settings_path() -> PathBuf {
    home().join(".claude").join("settings.json")
}

/// Merge ajar's hooks into the Claude Code settings, idempotently — existing
/// user hooks are preserved and re-running never duplicates ajar's entries.
fn install() {
    let path = claude_settings_path();
    let mut root: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !root.is_object() {
        root = serde_json::json!({});
    }
    let obj = root.as_object_mut().expect("root is an object");
    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));

    // UserPromptSubmit → working, Stop → idle, SessionEnd → end.
    ensure_hook(hooks, "UserPromptSubmit", "ajar-hook report working");
    ensure_hook(hooks, "Stop", "ajar-hook report idle");
    ensure_hook(hooks, "SessionEnd", "ajar-hook report end");

    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match serde_json::to_string_pretty(&root) {
        Ok(text) => {
            if std::fs::write(&path, text + "\n").is_ok() {
                println!("ajar: installed Claude Code hooks → {}", path.display());
            } else {
                eprintln!("ajar: could not write {}", path.display());
            }
        }
        Err(e) => eprintln!("ajar: serialize failed: {e}"),
    }
}

/// Ensure `command` is registered under `event` exactly once.
fn ensure_hook(hooks: &mut serde_json::Value, event: &str, command: &str) {
    let Some(hooks) = hooks.as_object_mut() else {
        return;
    };
    let entries = hooks.entry(event).or_insert_with(|| serde_json::json!([]));
    let Some(entries) = entries.as_array_mut() else {
        return;
    };
    let already = entries.iter().any(|entry| {
        entry
            .get("hooks")
            .and_then(|h| h.as_array())
            .is_some_and(|hs| {
                hs.iter()
                    .any(|h| h.get("command").and_then(|c| c.as_str()) == Some(command))
            })
    });
    if !already {
        entries.push(serde_json::json!({
            "hooks": [ { "type": "command", "command": command } ]
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_hook_is_idempotent_and_preserves_existing() {
        // Start with a user's own hook already present.
        let mut hooks = serde_json::json!({
            "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "user-thing" } ] } ]
        });
        ensure_hook(&mut hooks, "UserPromptSubmit", "ajar-hook report working");
        ensure_hook(&mut hooks, "UserPromptSubmit", "ajar-hook report working"); // twice
        ensure_hook(&mut hooks, "Stop", "ajar-hook report idle");

        let ups = hooks["UserPromptSubmit"].as_array().unwrap();
        // User's hook preserved + ajar added exactly once (no dup on re-run).
        assert_eq!(ups.len(), 2);
        let commands: Vec<&str> = ups
            .iter()
            .filter_map(|e| e["hooks"][0]["command"].as_str())
            .collect();
        assert!(commands.contains(&"user-thing"));
        assert!(commands.contains(&"ajar-hook report working"));
        assert_eq!(hooks["Stop"].as_array().unwrap().len(), 1);
    }
}
