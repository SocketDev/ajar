//! Agent-state ping protocol + socket server — the accurate per-session signal.
//!
//! An installed lifecycle hook sends one line when its agent starts a turn,
//! finishes one, or the session ends; the [`PingServer`] feeds each into a
//! shared [`Registry`] so every terminal window's Working/Idle is tracked
//! independently. Transport is loopback TCP (works identically on macOS, Linux,
//! and Windows, zero-dep); the ephemeral port is published to a state file the
//! hook reads.
//!
//! Wire line: `<state> <agent-slug> <session-id>` — e.g. `working claude 7f3a`.
//! `state` ∈ `working` | `idle` | `end`.

use crate::agent::Agent;
use crate::registry::{Activity, Registry};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

/// One agent-state report from a hook.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Ping {
    /// The agent began (or is still doing) work in this session.
    Working { agent: Agent, session: String },
    /// The agent's turn finished — this session is idle.
    Idle { agent: Agent, session: String },
    /// The session ended (window closed) — drop it entirely.
    End { agent: Agent, session: String },
}

impl Ping {
    /// Parse one wire line.
    pub fn parse(line: &str) -> Result<Ping, String> {
        let mut parts = line.split_whitespace();
        let state = parts.next().ok_or("empty ping")?;
        let slug = parts.next().ok_or("ping missing agent slug")?;
        let session = parts.next().unwrap_or("default").to_string();
        let agent = Agent::from_slug(slug).ok_or_else(|| format!("unknown agent slug {slug:?}"))?;
        match state.to_ascii_lowercase().as_str() {
            "working" => Ok(Ping::Working { agent, session }),
            "idle" => Ok(Ping::Idle { agent, session }),
            "end" => Ok(Ping::End { agent, session }),
            other => Err(format!("unknown state {other:?}")),
        }
    }

    /// Serialize for the hook-side client.
    pub fn encode(&self) -> String {
        let (state, agent, session) = match self {
            Ping::Working { agent, session } => ("working", agent, session),
            Ping::Idle { agent, session } => ("idle", agent, session),
            Ping::End { agent, session } => ("end", agent, session),
        };
        format!("{state} {} {session}\n", agent.slug())
    }

    /// Fold this ping into the registry.
    pub fn apply(&self, registry: &mut Registry) {
        match self {
            Ping::Working { agent, session } => {
                registry.report(*agent, session.clone(), Activity::Working)
            }
            Ping::Idle { agent, session } => {
                registry.report(*agent, session.clone(), Activity::Idle)
            }
            Ping::End { agent, session } => registry.end_session(*agent, session),
        }
    }
}

/// Where the running server publishes its port for hooks to read.
pub fn port_file() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".ajar").join("ping.port")
}

/// The agent-ping socket server. Binds an ephemeral loopback port, publishes it,
/// and folds every ping into the shared registry.
pub struct PingServer {
    listener: TcpListener,
    port: u16,
}

impl PingServer {
    /// Bind loopback + publish the port to [`port_file`].
    pub fn bind() -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        let path = port_file();
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        fs::write(&path, port.to_string())?;
        Ok(Self { listener, port })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Serve forever, folding each ping into `registry`. Spawn this on a thread.
    pub fn serve(self, registry: Arc<Mutex<Registry>>) {
        for conn in self.listener.incoming() {
            let Ok(stream) = conn else { continue };
            let registry = Arc::clone(&registry);
            thread::spawn(move || handle_conn(stream, &registry));
        }
    }
}

fn handle_conn(stream: TcpStream, registry: &Arc<Mutex<Registry>>) {
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(ping) = Ping::parse(&line) {
            if let Ok(mut reg) = registry.lock() {
                ping.apply(&mut reg);
            }
        }
    }
}

/// Hook-side: read the published port + send one ping. Best-effort — if ajar
/// isn't running there's simply no one to tell.
pub fn send_ping(ping: &Ping) -> std::io::Result<()> {
    let port: u16 = fs::read_to_string(port_file())?
        .trim()
        .parse()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "bad port file"))?;
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))?;
    stream.write_all(ping.encode().as_bytes())?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_encode_roundtrip() {
        for line in [
            "working claude 7f3a",
            "idle codex sess-2",
            "end cursor default",
        ] {
            let ping = Ping::parse(line).unwrap();
            assert_eq!(Ping::parse(ping.encode().trim()).unwrap(), ping);
        }
    }

    #[test]
    fn missing_session_defaults() {
        assert_eq!(
            Ping::parse("working claude").unwrap(),
            Ping::Working {
                agent: Agent::Claude,
                session: "default".into()
            }
        );
    }

    #[test]
    fn rejects_bad_state_or_agent() {
        assert!(Ping::parse("bogus claude s").is_err());
        assert!(Ping::parse("working notanagent s").is_err());
        assert!(Ping::parse("").is_err());
    }

    #[test]
    fn apply_folds_into_registry() {
        let mut reg = Registry::new();
        Ping::parse("working claude w1").unwrap().apply(&mut reg);
        assert!(reg.is_working(Agent::Claude));
        Ping::parse("idle claude w1").unwrap().apply(&mut reg);
        assert!(!reg.is_working(Agent::Claude));
        Ping::parse("working claude w1").unwrap().apply(&mut reg);
        Ping::parse("end claude w1").unwrap().apply(&mut reg);
        assert!(!reg.is_working(Agent::Claude));
    }

    #[test]
    fn server_binds_and_publishes_port() {
        let server = PingServer::bind().unwrap();
        assert!(server.port() > 0);
    }
}
