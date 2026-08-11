<h1 align="center">ajar</h1>

<p align="center">Keep your machine awake — <em>lid closed</em> — while your AI agents work.<br>
Cross-platform. Agent-aware. Explicit about what it can and can't do.</p>

<p align="center">
<a href="https://twitter.com/SocketSecurity"><img src="https://img.shields.io/twitter/follow/SocketSecurity?style=social" alt="Follow @SocketSecurity" /></a>
<a href="https://bsky.app/profile/socket.dev"><img src="https://img.shields.io/badge/Follow-@socket.dev-1DA1F2?style=social&logo=bluesky" alt="Follow @socket.dev on Bluesky" /></a>
</p>

---

Close the lid, walk away, let Claude Code / Codex / OpenCode keep running. `ajar`
holds a wake lock **only while a watched agent is actually working** and releases
it the moment they go idle — so your machine isn't awake all night for nothing.

Unlike the Mac-only tools in this space, `ajar` is one Rust core with native
menu-bar / system-tray shells on **macOS, Linux, and Windows**.

## Install

Two pieces: a Rust core and CLI at the repo root, and a SwiftUI menu-bar app
under `macos/AjarMenuBar/`.

```sh
cargo build --release          # the ajar CLI, helper, and hook
open macos/AjarMenuBar/AjarMenuBar.xcodeproj   # the macOS menu-bar shell
```

## Usage

Run the daemon and let it watch for working agents:

```sh
ajar run                       # hold the wake lock while an agent works
ajar run --json                # machine-readable status, what the menu bar reads
ajar status                    # what is held right now, and why
```

`ajar-hook` wires Claude Code up so sessions report their state:

```sh
ajar-hook install              # add the reporter to Claude Code settings
```

## What it does

- ✅ **Agent-aware** — knows when your agents are working vs. idle
- ✅ **Auto-sleeps** when agents go idle (no more all-night wake-for-nothing)
- ✅ **Lifecycle hooks** for Claude Code, Codex & OpenCode — accurate per-session state
- ✅ **Process detection** for the rest (Cursor / Gemini / Aider / Cline)
- ✅ **Finish notifications** — a chime + banner when your agents wrap up
- ✅ **Battery guardrails** + "plugged-in only" mode
- ✅ **Display-off control** to save even more power
- ✅ **Thermal release** — lets the machine cool instead of cooking under a closed lid

### Lifecycle hooks: why they matter

Claude Code, Codex, and OpenCode expose lifecycle hooks — small scripts called
when an agent starts a task, finishes one, or goes idle. `ajar` installs these
automatically and uses them to track **per-session** state: each terminal window
running an agent is tracked independently.

So if you have three Claude Code sessions open — two working, one idle — `ajar`
holds the wake lock for the two that are working and releases it the moment the
last one finishes. A blunt keep-awake tool would stay on until you quit all three.

## Cross-platform — the whole point

| Capability                           | macOS       | Linux      | Windows    |
| ------------------------------------ | ----------- | ---------- | ---------- |
| Lid-closed wake lock                 | ⚠️ Partial¹ | ✅         | ✅         |
| Knows WORKING vs OPEN                | ✅          | ✅         | ✅         |
| Auto-sleep when agents finish        | ✅          | ✅         | ✅         |
| Claude Code / Codex / OpenCode hooks | ✅          | ✅         | ✅         |
| Cursor / Gemini / Aider detection    | ✅ process  | ✅ process | ✅ process |
| Finish notifications                 | ✅          | ✅         | ✅         |
| Battery cut-off · plugged-in only    | ✅          | ✅         | ✅         |
| Display-off while agents run         | ✅          | ✅         | ✅         |

¹ **Honest about limits.** On Apple Silicon, macOS's clamshell (lid) sensor can
still force sleep in some scenarios even with the documented power assertions
held. `ajar` uses the same `IOPMAssertion` + `pmset disablesleep` mechanisms
every tool in this space uses, and tells you plainly when it can't guarantee
staying awake rather than overselling. On Linux (`logind` inhibitors) and
Windows (power-scheme lid action) the lid-closed hold is complete.

## How the wake lock works

The hold is a **lease, never a latch** — a per-OS mechanism engaged only while an
agent is working, and auto-released if `ajar` crashes, quits, or stops renewing,
so your machine can always sleep again.

- **macOS** — `IOPMAssertion` for idle-sleep; a privileged helper flips
  `pmset -a disablesleep 1` for the lid-closed hold, active only while an agent runs.
- **Linux** — `systemd-logind` inhibitor locks (`sleep` + `handle-lid-switch`).
- **Windows** — `SetThreadExecutionState` for idle; the active power scheme's
  lid-close action is set to "do nothing" while agents run, then restored.

## Architecture

```
ajar-core (Rust)          — decisions: agent state, guardrails, wake engine
  ├─ agent   — std-env agent signals + lifecycle-hook + process detection
  ├─ wake    — WakeController trait + macOS / Linux / Windows backends
  ├─ guard   — battery / thermal / power policy (pure, testable)
  ├─ state   — the engine: working + allowed → hold, else release
  └─ runtime — assembles ping server + process scan + engine on a timer
ajar (Rust bin)           — `ajar run --json`: status NDJSON out, control in
native shells             — menu-bar / tray UI (SwiftUI · WinUI · GTK)
```

The core is dependency-light on purpose. Each native shell drives the runtime
as a subprocess (`ajar run --json`) — reading its status stream and forwarding
the platform battery / thermal / power state it reads back down as commands, so
the guardrails apply identically on every OS.

## Roadmap

- **M0** — core: agent detection, wake trait + macOS idle hold, guard + engine ✅
- **M1a** — macOS privileged helper: `pmset disablesleep` as a heartbeat lease (lid-closed hold) + self-renewing `PmsetHelper` backend ✅
- **M1b** — agent registry (per-session Working/Idle) + zero-dep process scan ✅
- **M1b-2** — ping protocol + loopback socket server + `ajar-hook` (report command + Claude Code `settings.json` installer) ✅
- **M2** — Linux (`logind`) + Windows (`powercfg`) wake backends + cross-platform CI ✅
- **M3a** — `ajar run --json` bridge bin + macOS menu-bar shell (SwiftUI, socketeer theme): live status, keep-awake mode picker, working-agent list, IOKit battery/thermal forwarding ✅
- **M3b** — settings tabs (General · Agents · Power & Display · Notifications) + SMAppService helper install + Windows (WinUI) / Linux (GTK) shells ← _next_
- **M4** — display-off control, notification chimes, global shortcut, auto-update

## Development

```sh
pnpm install                   # fleet tooling: hooks, lint, checks
pnpm run check                 # the fleet gate
pnpm run fix                   # autofix what it can
cargo test                     # the Rust suite
```

The Rust workspace lives in `crates/`: `ajar` (CLI), `ajar-core` (wake traits
and the engine), `ajar-helper` (the privileged macOS lease), and `ajar-hook`
(the agent reporter). The macOS shell is SwiftUI plus AppKit for the menu-bar
plumbing.

## License

MIT © Socket
