//! ajar privileged helper daemon (macOS).
//!
//! Runs as root (a launchd daemon), listens on a unix socket, and flips
//! `pmset -a disablesleep` to match the heartbeat [`Lease`](ajar_helper::Lease):
//! held → sleep disabled (survives a closed lid), lapsed → sleep re-enabled.
//! ajar renews the lease on a timer; if ajar dies the lease expires and the
//! watchdog re-enables sleep, so the Mac can always sleep again.
//!
//! The lease + protocol logic is in the library (unit-tested); this binary is
//! just the socket loop + `pmset` + a poll watchdog.

fn main() {
    #[cfg(target_os = "macos")]
    macos::run();
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("ajar-helper is macOS-only (Linux uses logind, Windows uses powercfg — no privileged helper needed).");
        std::process::exit(0);
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use ajar_helper::{apply, now_ms, Command, Lease};
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::process::Command as Proc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// Fixed socket path. The launchd daemon owns it; ajar (the user app)
    /// connects. World-writable for M1 so the user process can reach the
    /// root-owned socket — M3 tightens this to a peer-credential check.
    const SOCK: &str = "/var/run/com.socketdev.ajar-helper.sock";

    pub fn run() {
        // Crash-safety, two layers:
        //  - AJAR dies → the lease expires (no renewal) → watchdog re-enables sleep.
        //  - THIS DAEMON dies while sleep was disabled → launchd `KeepAlive`
        //    restarts it and this baseline re-enables sleep. So a closed lid can
        //    never be stranded awake by a crash on either side.
        set_disablesleep(false);

        // Fresh socket each start; a stale file blocks bind.
        let _ = std::fs::remove_file(SOCK);
        let listener = match UnixListener::bind(SOCK) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("ajar-helper: cannot bind {SOCK}: {e}");
                std::process::exit(1);
            }
        };
        if let Err(e) = std::fs::set_permissions(SOCK, std::fs::Permissions::from_mode(0o666)) {
            eprintln!("ajar-helper: cannot chmod socket: {e}");
        }

        let lease = Arc::new(Mutex::new(Lease::new()));
        let sleep_disabled = Arc::new(AtomicBool::new(false));

        // Watchdog: reconcile pmset with the lease every second (also catches
        // lease EXPIRY, which no command triggers).
        {
            let lease = Arc::clone(&lease);
            let sleep_disabled = Arc::clone(&sleep_disabled);
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(1));
                let held = lease.lock().unwrap().is_held(now_ms());
                reconcile(held, &sleep_disabled);
            });
        }

        for conn in listener.incoming() {
            match conn {
                Ok(stream) => handle(stream, &lease, &sleep_disabled),
                Err(e) => eprintln!("ajar-helper: accept error: {e}"),
            }
        }
    }

    fn handle(stream: UnixStream, lease: &Arc<Mutex<Lease>>, sleep_disabled: &Arc<AtomicBool>) {
        let mut writer = match stream.try_clone() {
            Ok(w) => w,
            Err(_) => return,
        };
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let reply = match Command::parse(&line) {
                Ok(cmd) => {
                    let now = now_ms();
                    let (reply, held) = {
                        let mut l = lease.lock().unwrap();
                        let reply = apply(&mut l, cmd, now);
                        (reply, l.is_held(now))
                    };
                    // Apply the lease change to pmset immediately (don't wait
                    // for the 1s watchdog on an explicit command).
                    reconcile(held, sleep_disabled);
                    reply
                }
                Err(msg) => ajar_helper::Reply::Err(msg),
            };
            if writer.write_all(reply.encode().as_bytes()).is_err() {
                break;
            }
        }
    }

    /// Flip `pmset` only on the edge (avoid spawning it every poll).
    fn reconcile(held: bool, sleep_disabled: &Arc<AtomicBool>) {
        if held != sleep_disabled.load(Ordering::Relaxed) {
            set_disablesleep(held);
            sleep_disabled.store(held, Ordering::Relaxed);
        }
    }

    fn set_disablesleep(disable: bool) {
        let val = if disable { "1" } else { "0" };
        let status = Proc::new("/usr/bin/pmset").args(["-a", "disablesleep", val]).status();
        if let Err(e) = status {
            eprintln!("ajar-helper: pmset disablesleep {val} failed: {e}");
        }
    }
}
