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
    use proptest::prelude::*;

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

    /// A session carrying whitespace does not survive the wire format, and
    /// `\u{b}` is the case that proves the boundary is Unicode-wide rather
    /// than the four ASCII characters one would list by hand. `encode` writes
    /// the session raw into a space-separated line and `parse` splits on
    /// `char::is_whitespace`, so the vertical tab ends the field early and the
    /// value read back is a prefix of the value sent.
    ///
    /// Recorded as a test rather than a proptest regression seed: the
    /// generator can no longer produce this input, so a seed would re-run
    /// something unreachable, while this states the protocol constraint where
    /// a reader will find it.
    #[test]
    fn session_with_unicode_whitespace_does_not_round_trip() {
        let sent = Ping::Working {
            agent: Agent::Claude,
            session: "a\u{b}b".into(),
        };
        let read_back = Ping::parse(sent.encode().trim()).unwrap();
        assert_ne!(read_back, sent);
        assert_eq!(
            read_back,
            Ping::Working {
                agent: Agent::Claude,
                session: "a".into()
            }
        );
    }

    /// A session token that survives the wire format: non-empty, and free of
    /// whitespace. Both bounds are real protocol constraints rather than test
    /// convenience. `encode` writes the session raw into a space-separated
    /// line, so embedded whitespace is read back as a separate field, and an
    /// empty session leaves the third field absent, which `parse` fills with
    /// `"default"`. Either way the value that comes back is not the value that
    /// went in.
    ///
    /// The filter uses `char::is_whitespace`, the same predicate
    /// `str::split_whitespace` applies, rather than a hand-listed character
    /// class. The first draft excluded only space/tab/CR/LF and the property
    /// immediately produced `"\u{b}"` — a vertical tab, which is Unicode
    /// whitespace and splits the line. Naming the predicate instead of
    /// enumerating characters is what keeps the generator honest about the
    /// parser it describes.
    fn wire_session() -> impl Strategy<Value = String> {
        ".{1,32}".prop_filter("session must hold no whitespace", |s: &String| {
            !s.chars().any(char::is_whitespace)
        })
    }

    fn any_agent() -> impl Strategy<Value = Agent> {
        prop::sample::select(Agent::ALL.to_vec())
    }

    proptest! {
        /// The parser sits behind a socket, so its input is arbitrary bytes
        /// from any local process. Every one of them has to come back as an
        /// `Err`, never a panic that takes the connection handler's thread
        /// with it.
        #[test]
        fn parse_never_panics(line in ".*") {
            let _ = Ping::parse(&line);
        }

        /// The same, over strings shaped like the wire format. Plain `.*`
        /// almost never generates three space-separated fields, so it explores
        /// the reject path and not the accept path; this arm reaches the
        /// state-token and slug branches.
        #[test]
        fn parse_never_panics_on_wire_shaped_input(
            state in "[a-zA-Z]{0,12}",
            slug in "[a-z-]{0,16}",
            session in ".{0,32}",
        ) {
            let _ = Ping::parse(&format!("{state} {slug} {session}"));
        }

        /// Round-trip: what the hook encodes is what the server parses. The
        /// two halves live in one file and are edited together, which is
        /// exactly when a format change slips past example-based tests.
        #[test]
        fn parse_of_encode_is_identity(
            agent in any_agent(),
            session in wire_session(),
            which in 0u8..3,
        ) {
            let ping = match which {
                0 => Ping::Working { agent, session },
                1 => Ping::Idle { agent, session },
                _ => Ping::End { agent, session },
            };
            prop_assert_eq!(Ping::parse(ping.encode().trim()).unwrap(), ping);
        }

        /// The state token is matched case-insensitively, so a hook that
        /// upper-cases it still reports.
        #[test]
        fn state_token_is_case_insensitive(
            agent in any_agent(),
            session in wire_session(),
            upper in proptest::bool::ANY,
        ) {
            let state = if upper { "WORKING" } else { "working" };
            let line = format!("{state} {} {session}", agent.slug());
            prop_assert_eq!(
                Ping::parse(&line).unwrap(),
                Ping::Working { agent, session }
            );
        }

        /// Trailing fields are ignored rather than rejected, so a future
        /// sender that appends a field still parses against today's server.
        #[test]
        fn trailing_fields_are_ignored(
            agent in any_agent(),
            session in wire_session(),
            extra in wire_session(),
        ) {
            let line = format!("working {} {session} {extra}", agent.slug());
            prop_assert_eq!(
                Ping::parse(&line).unwrap(),
                Ping::Working { agent, session }
            );
        }

        /// A slug outside the known set is an error, never a silent default.
        /// Reporting an unknown agent as a known one would hold the wake lock
        /// for a session nothing is running.
        #[test]
        fn unknown_slug_is_rejected(slug in "[a-z]{1,16}") {
            prop_assume!(Agent::from_slug(&slug).is_none());
            // Built before the assert: `prop_assert!` expands its argument
            // through `concat!`, and a format string reaching `format_args!`
            // that way cannot capture `slug` implicitly.
            let line = format!("working {slug} s");
            prop_assert!(Ping::parse(&line).is_err());
        }

        /// Folding a parsed ping into the registry never panics, whatever
        /// order the states arrive in. A hook can be killed mid-turn, so `end`
        /// without a preceding `working` is a normal sequence, not a bug.
        #[test]
        fn apply_never_panics_in_any_order(
            agent in any_agent(),
            session in wire_session(),
            order in prop::collection::vec(0u8..3, 0..8),
        ) {
            let mut registry = Registry::new();
            for which in order {
                let ping = match which {
                    0 => Ping::Working { agent, session: session.clone() },
                    1 => Ping::Idle { agent, session: session.clone() },
                    _ => Ping::End { agent, session: session.clone() },
                };
                ping.apply(&mut registry);
            }
        }
    }
}
