//! Zero-dep process scan — the hookless agent-awareness tier.
//!
//! Lists running process names (via `ps` on unix, `tasklist` on Windows) and
//! matches them against each [`Agent`]'s executable names. Feeds
//! [`Registry::observe_processes`](crate::registry::Registry::observe_processes)
//! for agents that don't emit lifecycle hooks (Cursor / Cline / Aider). Hooked
//! agents ignore this — their hooks are authoritative.

use crate::agent::Agent;
use std::process::Command;

/// Agents whose process is currently alive (matched by executable basename).
pub fn scan_running() -> Vec<Agent> {
    let names = running_process_names();
    Agent::ALL
        .iter()
        .copied()
        .filter(|agent| {
            agent
                .process_names()
                .iter()
                .any(|want| names.iter().any(|got| got == want))
        })
        .collect()
}

fn running_process_names() -> Vec<String> {
    let Ok(output) = process_list_command() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_process_names(&text)
}

#[cfg(unix)]
fn process_list_command() -> std::io::Result<std::process::Output> {
    // `comm=` prints the executable path with no header.
    Command::new("ps").args(["-A", "-o", "comm="]).output()
}

#[cfg(windows)]
fn process_list_command() -> std::io::Result<std::process::Output> {
    // CSV, no header: `"name.exe","pid",...` per line.
    Command::new("tasklist").args(["/FO", "CSV", "/NH"]).output()
}

/// Parse the platform process listing into bare executable names. Split out so
/// the (fiddly) parsing is unit-tested without spawning a real process.
fn parse_process_names(text: &str) -> Vec<String> {
    text.lines().filter_map(exe_basename).collect()
}

/// Extract a bare executable name from one listing line: strips the directory
/// path (`/usr/bin/claude` → `claude`), the Windows CSV quoting
/// (`"claude.exe",...` → `claude.exe`), and a trailing `.exe`.
fn exe_basename(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    // Windows CSV: take the first quoted field.
    let first = if line.starts_with('"') {
        line.trim_start_matches('"').split('"').next().unwrap_or(line)
    } else {
        line
    };
    let base = first.rsplit(['/', '\\']).next().unwrap_or(first);
    let base = base.strip_suffix(".exe").unwrap_or(base);
    if base.is_empty() {
        None
    } else {
        Some(base.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_comm_basename() {
        let out = parse_process_names("/usr/local/bin/claude\n/bin/zsh\ncodex\n");
        assert!(out.contains(&"claude".to_string()));
        assert!(out.contains(&"zsh".to_string()));
        assert!(out.contains(&"codex".to_string()));
    }

    #[test]
    fn windows_csv_basename() {
        let out = parse_process_names("\"cursor-agent.exe\",\"1234\",\"Console\",\"1\",\"12,345 K\"\n\"System Idle Process\",\"0\",\"Services\",\"0\",\"8 K\"\n");
        assert!(out.contains(&"cursor-agent".to_string()));
    }

    #[test]
    fn empty_lines_ignored() {
        assert!(parse_process_names("\n  \n").is_empty());
    }
}
