//! Testable core of the ajar privileged helper: the heartbeat **lease** and the
//! line **protocol**. No I/O here — [`main`](../main.rs) wires these to a unix
//! socket and `pmset`.
//!
//! The lease is the safety guarantee: the helper only keeps sleep disabled while
//! ajar keeps renewing before a deadline. If ajar crashes, quits, or wedges, the
//! lease expires and the helper re-enables sleep — the Mac can always sleep
//! again. Sleep is never latched on; it is *leased*.

use std::time::{SystemTime, UNIX_EPOCH};

/// Monotonic-ish wall-clock millis, for the daemon. Tests pass explicit times.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A heartbeat lease over "sleep is disabled". Engage/renew push a deadline
/// forward; the daemon polls [`Lease::is_held`] and flips `pmset` on the edge.
#[derive(Clone, Copy, Debug, Default)]
pub struct Lease {
    /// Absolute deadline (ms) after which the hold lapses; `None` = released.
    deadline_ms: Option<u64>,
}

impl Lease {
    pub fn new() -> Self {
        Self { deadline_ms: None }
    }

    /// Take/extend the hold: valid until `now + ttl_ms`.
    pub fn engage(&mut self, now_ms: u64, ttl_ms: u64) {
        self.deadline_ms = Some(now_ms.saturating_add(ttl_ms));
    }

    /// Explicitly drop the hold (clean release).
    pub fn release(&mut self) {
        self.deadline_ms = None;
    }

    /// Whether the hold is currently valid (not released, not expired).
    pub fn is_held(&self, now_ms: u64) -> bool {
        self.deadline_ms.is_some_and(|d| now_ms < d)
    }

    /// Millis until expiry, or `None` if released/expired — lets the daemon
    /// sleep exactly until the next state change instead of busy-polling.
    pub fn remaining_ms(&self, now_ms: u64) -> Option<u64> {
        self.deadline_ms.and_then(|d| d.checked_sub(now_ms))
    }
}

/// A command from ajar to the helper. One per line on the socket.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Command {
    /// Take/renew the hold for `ttl_ms` (ajar re-sends well before expiry).
    Engage { ttl_ms: u64 },
    /// Drop the hold now.
    Release,
    /// Liveness probe; helper replies `OK` without touching the lease.
    Ping,
    /// Ask whether the hold is currently active.
    Status,
}

/// A reply from the helper to ajar. One per line.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Reply {
    Ok,
    /// `STATUS` answer: whether the hold is held right now.
    Status { held: bool },
    Err(String),
}

impl Command {
    /// Parse one wire line, e.g. `ENGAGE 15000`, `RELEASE`, `PING`, `STATUS`.
    pub fn parse(line: &str) -> Result<Command, String> {
        let line = line.trim();
        let (verb, rest) = match line.split_once(char::is_whitespace) {
            Some((v, r)) => (v, r.trim()),
            None => (line, ""),
        };
        match verb.to_ascii_uppercase().as_str() {
            "ENGAGE" => {
                let ttl_ms = rest
                    .parse::<u64>()
                    .map_err(|_| format!("ENGAGE needs a ttl_ms integer, got {rest:?}"))?;
                if ttl_ms == 0 {
                    return Err("ENGAGE ttl_ms must be > 0".to_string());
                }
                Ok(Command::Engage { ttl_ms })
            }
            "RELEASE" => Ok(Command::Release),
            "PING" => Ok(Command::Ping),
            "STATUS" => Ok(Command::Status),
            other => Err(format!("unknown command {other:?}")),
        }
    }

    /// Serialize for the ajar-side client.
    pub fn encode(&self) -> String {
        match self {
            Command::Engage { ttl_ms } => format!("ENGAGE {ttl_ms}\n"),
            Command::Release => "RELEASE\n".to_string(),
            Command::Ping => "PING\n".to_string(),
            Command::Status => "STATUS\n".to_string(),
        }
    }
}

impl Reply {
    pub fn encode(&self) -> String {
        match self {
            Reply::Ok => "OK\n".to_string(),
            Reply::Status { held } => format!("STATUS {}\n", if *held { "held" } else { "free" }),
            Reply::Err(msg) => format!("ERR {msg}\n"),
        }
    }
}

/// Apply one command to the lease, returning the reply to send. This is the
/// whole helper policy, isolated from I/O so it is exhaustively testable.
pub fn apply(lease: &mut Lease, cmd: Command, now_ms: u64) -> Reply {
    match cmd {
        Command::Engage { ttl_ms } => {
            lease.engage(now_ms, ttl_ms);
            Reply::Ok
        }
        Command::Release => {
            lease.release();
            Reply::Ok
        }
        Command::Ping => Reply::Ok,
        Command::Status => Reply::Status { held: lease.is_held(now_ms) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_expires_without_renewal() {
        let mut l = Lease::new();
        assert!(!l.is_held(0));
        l.engage(1_000, 5_000);
        assert!(l.is_held(1_000));
        assert!(l.is_held(5_999));
        assert!(!l.is_held(6_000)); // deadline reached → sleep re-enabled
    }

    #[test]
    fn renewal_extends_the_deadline() {
        let mut l = Lease::new();
        l.engage(0, 5_000);
        l.engage(4_000, 5_000); // renew before expiry
        assert!(l.is_held(8_000)); // would have expired at 5_000 without renewal
        assert!(!l.is_held(9_000));
    }

    #[test]
    fn release_drops_immediately() {
        let mut l = Lease::new();
        l.engage(0, 10_000);
        l.release();
        assert!(!l.is_held(1));
        assert_eq!(l.remaining_ms(1), None);
    }

    #[test]
    fn parse_roundtrip() {
        for cmd in [
            Command::Engage { ttl_ms: 15_000 },
            Command::Release,
            Command::Ping,
            Command::Status,
        ] {
            let line = cmd.encode();
            assert_eq!(Command::parse(&line), Ok(cmd));
        }
    }

    #[test]
    fn parse_rejects_bad_input() {
        assert!(Command::parse("ENGAGE").is_err());
        assert!(Command::parse("ENGAGE 0").is_err());
        assert!(Command::parse("ENGAGE abc").is_err());
        assert!(Command::parse("BOGUS").is_err());
    }

    #[test]
    fn apply_drives_the_lease() {
        let mut l = Lease::new();
        assert_eq!(apply(&mut l, Command::Engage { ttl_ms: 5_000 }, 0), Reply::Ok);
        assert_eq!(apply(&mut l, Command::Status, 1_000), Reply::Status { held: true });
        assert_eq!(apply(&mut l, Command::Status, 6_000), Reply::Status { held: false });
        assert_eq!(apply(&mut l, Command::Release, 0), Reply::Ok);
    }
}
