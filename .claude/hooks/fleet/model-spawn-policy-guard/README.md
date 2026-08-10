# model-spawn-policy-guard

PreToolUse hook on `Agent`, `Task`, `Workflow`, and `Bash`. Blocks a spawn that
selects a model the fleet has taken out of service, or that turns fast mode on.

## Why

`model-policy-guard` holds the session to the model-cost policy at the turn
boundary. Without this hook the session could still reach a banned model by
delegating to it: a subagent spawned with that model, or a `claude` process
started from a shell line. Same policy, the other direction.

Both hooks read one derivation
(`../model-policy-guard/model-policy.mts`), which reads one file
(`scripts/fleet/constants/model-pricing.json`). A model is banned if and only if
its entry carries `suspended: true`, and fast mode is banned if and only if
`policy.fastMode` reads `"banned"`. Neither list is restated in this hook.

## Triggers

- An `Agent`, `Task`, or `Workflow` call whose payload carries a `model` key,
  at any depth, naming an out-of-service model. A Workflow declares one model
  per agent, which is why the walk is not limited to the top level.
- An `Agent`, `Task`, or `Workflow` call whose payload turns a fast-mode switch
  on, or whose model id carries the switch in its own name (`opus[fast]`).
- A `Bash` line where a `claude` invocation passes `--model` with an
  out-of-service value, carries a fast-mode flag, or where any segment assigns
  `ANTHROPIC_MODEL` to an out-of-service model or sets a fast-mode environment
  variable.

## Threshold

One selection is enough. Shell lines are read with the shared tokenizer in
`_shared/shell-command.mts`, so a chain, quoting, a wrapper such as `env`, and a
heredoc body are all handled, and a model named inside a quoted string can never
be mistaken for a selection.

Model detection on a spawn payload is keyed on the FIELD NAME, never on the
prose. A brief that discusses an out-of-service model still runs - which is what
keeps the guard usable in a repo whose own documentation names the model. The
hook fails open on anything it cannot resolve: a model held in a shell variable,
a `--model` flag with no value, an unfamiliar payload shape.

## Bypass

Bypass slug: `model-spawn-policy`. `_shared/bypass.mts` owns the phrase spelling
and `defineHook` prints the exact wording on the block itself.
