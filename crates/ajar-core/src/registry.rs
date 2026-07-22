//! The agent registry — ajar's per-session Working/Idle brain.
//!
//! Two signal sources feed it, matching the two tracking tiers:
//! - **Hook pings** ([`Registry::report`]): an installed lifecycle hook reports
//!   an exact `(agent, session, state)`. Each terminal window is a distinct
//!   session, tracked independently — so two Claude Code windows working while a
//!   third is idle counts as "working".
//! - **Process scan** ([`Registry::observe_processes`]): for agents without
//!   hooks (Cursor / Cline / Aider), a live process is treated as one working
//!   session.
//!
//! [`Registry::working`] is what the wake engine consumes: the number of
//! *enabled* agents with at least one working session. Only the user's watched
//! (enabled) agents count.

use crate::agent::{Agent, Tracking};
use std::collections::{HashMap, HashSet};

/// A single agent session's activity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Activity {
    Working,
    Idle,
}

/// Per-session, per-agent Working/Idle state.
#[derive(Debug, Default)]
pub struct Registry {
    /// Hook-reported sessions: (agent, session_id) -> activity.
    hooked: HashMap<(Agent, String), Activity>,
    /// Process-scan observation: agents seen alive on the last scan.
    processes: HashSet<Agent>,
    /// Agents the user is watching. Empty = watch all (first-run default).
    enabled: HashSet<Agent>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the watched agents. An empty set means "watch every agent".
    pub fn set_enabled(&mut self, agents: impl IntoIterator<Item = Agent>) {
        self.enabled = agents.into_iter().collect();
    }

    fn is_enabled(&self, agent: Agent) -> bool {
        self.enabled.is_empty() || self.enabled.contains(&agent)
    }

    /// Record a lifecycle-hook ping. `session` distinguishes terminal windows.
    pub fn report(&mut self, agent: Agent, session: impl Into<String>, activity: Activity) {
        self.hooked.insert((agent, session.into()), activity);
    }

    /// A hook told us a session ended (window closed) — drop it entirely so it
    /// stops counting.
    pub fn end_session(&mut self, agent: Agent, session: &str) {
        self.hooked.remove(&(agent, session.to_string()));
    }

    /// Replace the process-scan observation with the agents seen alive now.
    /// Only meaningful for process-tracked agents; a hook-tracked agent's
    /// liveness is ignored here (its hooks are authoritative).
    pub fn observe_processes(&mut self, alive: impl IntoIterator<Item = Agent>) {
        self.processes =
            alive.into_iter().filter(|a| a.tracking() == Tracking::Process).collect();
    }

    /// Whether a specific agent has any working session right now.
    pub fn is_working(&self, agent: Agent) -> bool {
        if !self.is_enabled(agent) {
            return false;
        }
        match agent.tracking() {
            Tracking::Hook => self
                .hooked
                .iter()
                .any(|((a, _), act)| *a == agent && *act == Activity::Working),
            Tracking::Process => self.processes.contains(&agent),
        }
    }

    /// The set of enabled agents currently working (drives the UI list).
    pub fn working_agents(&self) -> Vec<Agent> {
        Agent::ALL.iter().copied().filter(|a| self.is_working(*a)).collect()
    }

    /// Count of enabled agents working — the wake engine's `agents_working`.
    pub fn working(&self) -> usize {
        self.working_agents().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_sessions_track_per_window() {
        let mut r = Registry::new();
        assert_eq!(r.working(), 0);
        r.report(Agent::Claude, "win-1", Activity::Working);
        r.report(Agent::Claude, "win-2", Activity::Idle);
        assert!(r.is_working(Agent::Claude)); // one window working is enough
        assert_eq!(r.working(), 1); // still one agent (Claude), not two
        r.report(Agent::Claude, "win-1", Activity::Idle);
        assert!(!r.is_working(Agent::Claude)); // all Claude windows idle
        assert_eq!(r.working(), 0);
    }

    #[test]
    fn ended_session_stops_counting() {
        let mut r = Registry::new();
        r.report(Agent::Codex, "s1", Activity::Working);
        assert_eq!(r.working(), 1);
        r.end_session(Agent::Codex, "s1");
        assert_eq!(r.working(), 0);
    }

    #[test]
    fn process_scan_counts_hookless_agents() {
        let mut r = Registry::new();
        r.observe_processes([Agent::Cursor, Agent::Claude]);
        // Cursor is process-tracked → counts; Claude is hook-tracked → a bare
        // process observation does NOT count (its hooks are authoritative).
        assert!(r.is_working(Agent::Cursor));
        assert!(!r.is_working(Agent::Claude));
        assert_eq!(r.working(), 1);
    }

    #[test]
    fn enabled_filter_excludes_unwatched() {
        let mut r = Registry::new();
        r.set_enabled([Agent::Claude]);
        r.observe_processes([Agent::Cursor]);
        r.report(Agent::Claude, "s", Activity::Working);
        assert!(!r.is_working(Agent::Cursor)); // not watched
        assert!(r.is_working(Agent::Claude));
        assert_eq!(r.working(), 1);
    }
}
