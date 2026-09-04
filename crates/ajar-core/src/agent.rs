//! Agent-awareness: which AI coding agent (if any) is driving, and how ajar
//! tracks whether it is WORKING vs IDLE.
//!
//! Detection mirrors std-env's agent signals — the same set socket-lib
//! re-exports for the fleet's JS tooling — so ajar and everything else agree on
//! "an agent is running". Two tiers, matching the Hold My Lid model:
//!
//! - **Lifecycle hooks** — agents that expose start/stop hooks (Claude Code,
//!   Codex, OpenCode, Gemini, Copilot CLI, Pi, Hermes) report an ACCURATE
//!   per-session Working/Idle signal. ajar installs a tiny hook script that
//!   pings it; each terminal window is tracked independently.
//! - **Process detection** — everything else (Cursor, Cline, Aider) counts as
//!   "working" while its process is alive.
//!
//! This module is the shared vocabulary: the [`Agent`] set + how each is
//! tracked + the env signals a hook script reads to identify its own session.
//! The hook-ping socket and the process scan land in M1.

use std::env;

/// An AI coding agent ajar knows how to watch.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Agent {
    Claude,
    Codex,
    OpenCode,
    Gemini,
    Copilot,
    Pi,
    Hermes,
    Cursor,
    Cline,
    Aider,
    Replit,
    Goose,
    Junie,
    Auggie,
    Devin,
    Kiro,
}

/// How ajar learns an agent's Working/Idle state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Tracking {
    /// A real start/stop lifecycle signal — accurate per session.
    Hook,
    /// "Working while the process is alive" — best-effort.
    Process,
}

impl Agent {
    /// Every agent ajar can watch.
    pub const ALL: &'static [Agent] = &[
        Agent::Claude,
        Agent::Codex,
        Agent::OpenCode,
        Agent::Gemini,
        Agent::Copilot,
        Agent::Pi,
        Agent::Hermes,
        Agent::Cursor,
        Agent::Cline,
        Agent::Aider,
        Agent::Replit,
        Agent::Goose,
        Agent::Junie,
        Agent::Auggie,
        Agent::Devin,
        Agent::Kiro,
    ];

    /// Human-facing name.
    pub fn label(self) -> &'static str {
        match self {
            Agent::Claude => "Claude Code",
            Agent::Codex => "Codex CLI",
            Agent::OpenCode => "OpenCode",
            Agent::Gemini => "Gemini",
            Agent::Copilot => "Copilot CLI",
            Agent::Pi => "Pi",
            Agent::Hermes => "Hermes",
            Agent::Cursor => "Cursor",
            Agent::Cline => "Cline",
            Agent::Aider => "Aider",
            Agent::Replit => "Replit",
            Agent::Goose => "Goose",
            Agent::Junie => "Junie",
            Agent::Auggie => "Auggie",
            Agent::Devin => "Devin",
            Agent::Kiro => "Kiro",
        }
    }

    /// Whether ajar tracks this agent by lifecycle hook or by live process.
    pub fn tracking(self) -> Tracking {
        match self {
            Agent::Claude
            | Agent::Codex
            | Agent::OpenCode
            | Agent::Gemini
            | Agent::Copilot
            | Agent::Pi
            | Agent::Hermes => Tracking::Hook,
            Agent::Cursor | Agent::Cline | Agent::Aider => Tracking::Process,
            // Editor/PATH-signalled agents: presence is the only signal today.
            Agent::Replit
            | Agent::Goose
            | Agent::Junie
            | Agent::Auggie
            | Agent::Devin
            | Agent::Kiro => Tracking::Process,
        }
    }

    /// Executable/binary names the process scan matches (M1 watcher).
    pub fn process_names(self) -> &'static [&'static str] {
        match self {
            Agent::Claude => &["claude"],
            Agent::Codex => &["codex"],
            Agent::OpenCode => &["opencode"],
            Agent::Gemini => &["gemini"],
            Agent::Copilot => &["copilot"],
            Agent::Pi => &["pi"],
            Agent::Hermes => &["hermes"],
            Agent::Cursor => &["cursor-agent"],
            Agent::Cline => &["cline"],
            Agent::Aider => &["aider"],
            Agent::Replit => &[],
            Agent::Goose => &["goose"],
            Agent::Junie => &["junie"],
            Agent::Auggie => &["auggie"],
            Agent::Devin => &[],
            Agent::Kiro => &["kiro"],
        }
    }

    /// Stable lowercase wire slug — used by the ping protocol + hook install.
    pub fn slug(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
            Agent::OpenCode => "opencode",
            Agent::Gemini => "gemini",
            Agent::Copilot => "copilot",
            Agent::Pi => "pi",
            Agent::Hermes => "hermes",
            Agent::Cursor => "cursor",
            Agent::Cline => "cline",
            Agent::Aider => "aider",
            Agent::Replit => "replit",
            Agent::Goose => "goose",
            Agent::Junie => "junie",
            Agent::Auggie => "auggie",
            Agent::Devin => "devin",
            Agent::Kiro => "kiro",
        }
    }

    /// Parse a wire slug back to an agent.
    pub fn from_slug(slug: &str) -> Option<Agent> {
        Agent::ALL.iter().copied().find(|a| a.slug() == slug)
    }
}

/// Return the agent driving THIS process, read from the environment the agent
/// injects. Used by an installed hook script to identify its own session; the
/// tray app itself uses the process scan (M1) since it runs outside any agent.
///
/// Precedence: the cross-agent `AI_AGENT` override, then per-tool signals, then
/// PATH/EDITOR/TERM_PROGRAM heuristics — matching std-env's `detectAgent()`.
pub fn detect_agent_from_env() -> Option<Agent> {
    if let Some(a) = env::var("AI_AGENT")
        .ok()
        .and_then(|v| classify_ai_agent(&v))
    {
        return Some(a);
    }
    if is_set("CLAUDECODE") || is_set("CLAUDE_CODE") {
        return Some(Agent::Claude);
    }
    if is_set("CODEX_SANDBOX") || is_set("CODEX_THREAD_ID") {
        return Some(Agent::Codex);
    }
    if is_set("OPENCODE") {
        return Some(Agent::OpenCode);
    }
    if is_set("GEMINI_CLI") {
        return Some(Agent::Gemini);
    }
    if is_set("CURSOR_AGENT") {
        return Some(Agent::Cursor);
    }
    if is_set("REPL_ID") {
        return Some(Agent::Replit);
    }
    if is_set("AUGMENT_AGENT") {
        return Some(Agent::Auggie);
    }
    if is_set("GOOSE_PROVIDER") {
        return Some(Agent::Goose);
    }
    if is_set("JUNIE_DATA") || is_set("JUNIE_SHIM_PATH") {
        return Some(Agent::Junie);
    }
    if env_contains("PATH", ".pi/agent") || env_contains("PATH", ".pi\\agent") {
        return Some(Agent::Pi);
    }
    if env_contains("EDITOR", "devin") {
        return Some(Agent::Devin);
    }
    if env_contains("TERM_PROGRAM", "kiro") {
        return Some(Agent::Kiro);
    }
    None
}

/// True when any std-env agent signal is present (a plain shell / CI is false).
pub fn is_agent() -> bool {
    detect_agent_from_env().is_some()
}

fn classify_ai_agent(value: &str) -> Option<Agent> {
    let v = value.to_ascii_lowercase();
    for agent in Agent::ALL {
        if v.contains(&agent.label().to_ascii_lowercase().replace(' ', "-"))
            || v.contains(&format!("{:?}", agent).to_ascii_lowercase())
        {
            return Some(*agent);
        }
    }
    // Unknown but explicitly-declared agent: default to Claude's tracking so a
    // future tool still holds the wake lock rather than being ignored.
    if v.is_empty() {
        None
    } else {
        Some(Agent::Claude)
    }
}

fn is_set(key: &str) -> bool {
    env::var_os(key).is_some_and(|v| !v.is_empty())
}

fn env_contains(key: &str, needle: &str) -> bool {
    env::var(key).is_ok_and(|v| v.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_agent_has_a_label() {
        for agent in Agent::ALL {
            assert!(!agent.label().is_empty());
        }
    }

    #[test]
    fn hook_and_process_tiers_are_disjoint_and_total() {
        // Every agent classifies as exactly one tracking tier.
        for agent in Agent::ALL {
            let _ = agent.tracking();
        }
        assert_eq!(Agent::Claude.tracking(), Tracking::Hook);
        assert_eq!(Agent::Cursor.tracking(), Tracking::Process);
    }
}
