//! `ajar-core` — the cross-platform wake-lock + agent-awareness engine behind
//! ajar: keep your machine awake, lid closed, only while your AI agents work.
//!
//! Layering: this crate owns the *decisions* (who's working, what the
//! guardrails allow, when to hold the wake lock) and the per-OS wake mechanism
//! behind one trait. The native menu-bar/tray shells (SwiftUI / WinUI / GTK)
//! sit on top and feed it agent + power samples.
//!
//! ```
//! use ajar_core::{Engine, Guards, KeepAwake, Power, Status, wake};
//!
//! let mut engine = Engine::new(wake::controller(), KeepAwake::WhileAgentsWork, Guards::default());
//! let power = Power { battery: 1.0, on_ac: true, low_power_mode: false, thermal_hot: false };
//! // No agent working → let the machine sleep.
//! assert_eq!(engine.tick(0, power), Status::Idle);
//! // An agent starts working → hold the wake lock.
//! assert_eq!(engine.tick(1, power), Status::Awake);
//! ```

pub mod agent;
pub mod guard;
pub mod ping;
pub mod registry;
pub mod runtime;
pub mod scan;
pub mod state;
pub mod wake;

pub use runtime::Runtime;

pub use agent::{detect_agent_from_env, is_agent, Agent, Tracking};
pub use guard::{Blocked, Guards, Power};
pub use ping::{send_ping, Ping, PingServer};
pub use registry::{Activity, Registry};
pub use scan::scan_running;
pub use state::{Engine, KeepAwake, Status};
pub use wake::{controller, LidCapability, WakeController};
