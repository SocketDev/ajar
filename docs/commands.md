# Command reference

## `ajar run`

Start the runtime and emit status once per second. Human-readable status is the
default:

```sh
ajar run
```

Use `--json` for newline-delimited JSON status records suitable for a native
shell:

```sh
ajar run --json
```

The process reads control commands from standard input and releases its wake
hold on shutdown.

## `ajar status`

Show whether the wake lock is held and the reason. This command is intended for
checking the current runtime state.

## `ajar-hook install`

Merge ajar lifecycle hooks into the Claude Code user settings:

```sh
ajar-hook install
```

The installer preserves existing user hooks and avoids adding duplicate ajar
entries on repeated runs.

The hook's internal `report <working|idle|end>` command is called by lifecycle
hooks. It reports the current agent session to a running ajar runtime and is
best-effort when no runtime is listening.

## Development

From the repository root:

```sh
pnpm install
pnpm run check
pnpm run fix
cargo test
```

Use `cargo build --release` to build the Rust CLI, helper, and hook. See the
[user guide](guide.md) for runtime behavior and platform-specific details.
