# ajar user guide

`ajar` keeps a machine awake while watched AI agents work and releases the
wake lock when they become idle. The project has a Rust runtime and CLI, plus
native menu-bar or tray shells.

## Setup

Build the CLI, helper, and hook from the repository root:

```sh
cargo build --release
```

The macOS menu-bar application is in `macos/AjarMenuBar/`. Open its Xcode
project to build the native shell. The CLI can also be run without a UI.

## Agent tracking

Lifecycle hooks from Claude Code, Codex, and OpenCode report working, idle,
and ended states per session. Install the Claude Code reporter with:

```sh
ajar-hook install
```

Process detection covers agents without lifecycle hooks, including Cursor,
Gemini, Aider, and Cline. The runtime holds the wake lock while any enabled
agent is working and releases it when all watched agents are idle or ended.

## Wake behavior and platform limits

The wake lock is a lease. The runtime renews it while policy permits and the
agent state requires it; shutdown releases the hold. macOS uses an idle-sleep
assertion and a privileged helper for lid-closed behavior. Apple's clamshell
sensor can still force sleep on some Apple Silicon systems. Linux uses
`systemd-logind` inhibitors. Windows uses `SetThreadExecutionState` and
temporarily changes the active power scheme's lid-close behavior.

## Guardrails

Guardrails can release the hold when battery charge is below the configured
cutoff, the device is on battery in plugged-in-only mode, Low Power Mode is
active, or the system is thermally hot. Defaults use a 25% battery cutoff,
respect Low Power Mode, and release when hot. Platform shells supply power,
battery, and thermal readings to the runtime.

The menu-bar shell also exposes working agents and power settings. Display-off
control and notification behavior depend on the native shell and current
release; check the bundled application for available settings.

## Troubleshooting

- Run `ajar status` to inspect the current hold state and its reason.
- Run `ajar run --json` to inspect the newline-delimited status stream used by
  native shells.
- Confirm the hook installer wrote lifecycle hooks to the intended Claude
  Code settings file.
- Check OS power policy and helper installation when lid-closed behavior is
  unavailable; macOS hardware and policy can impose limits.

See the [command reference](commands.md) for invocation details and
development commands.
