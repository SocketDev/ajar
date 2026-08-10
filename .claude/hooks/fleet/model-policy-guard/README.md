# model-policy-guard

UserPromptSubmit hook. Blocks the turn when the model the session is running has
been taken out of service, or when fast mode is on in any settings layer.

## Why

The model choice is made once and then bills on every turn, so an advisory line
about it scrolls past while the premium keeps charging. Both verdicts derive
from one file, `scripts/fleet/constants/model-pricing.json`, so a ban and a
price can never disagree:

- A model is banned if and only if its entry under `services.*.models` carries
  `suspended: true`. There is no ban list in the hook's code, which means
  clearing the flag in the data clears the ban with no code change.
- Fast mode is banned if and only if the file's top-level `policy.fastMode`
  reads `"banned"`. It bills at twice the base rate, so on a large context it
  multiplies cache-read cost instead of buying throughput.

The block names the substitute the data itself points at: the suspending
service's `notes` carry a quoted `use <model>` directive, and a service with no
directive falls back to naming its models that are still in service.

## Trigger

Every prompt submission. The hook reads no budget figure and no spend history -
those live in machine-local runtime config, named by the pricing data's
`policy.runtimeConfigPath`.

## Threshold

One layer selecting an out-of-service model, or one layer with a fast-mode
switch on, is enough. The payload does not carry the model, so the effective
selection is read from the settings layers in Claude Code's own precedence
order, highest first:

1. the process environment (`ANTHROPIC_MODEL`)
2. `.claude/settings.local.json` in the checkout
3. `.claude/settings.json` in the checkout
4. `~/.claude/settings.json`

The model verdict uses the highest layer that selects one. The fast-mode verdict
scans every layer, because a lower layer turning it on still bills at the
premium - nothing above it turns the switch back off. A model id can also carry
the switch in its own name (`opus[fast]`), and that counts too.

The hook fails open when no layer selects a model: the harness default is in
play, and this hook has nothing to judge. A settings file that is absent or
unparseable is skipped rather than blocking the turn.

## Bypass

Bypass slug: `model-policy`. `_shared/bypass.mts` owns the phrase spelling and
`defineHook` prints the exact wording on the block itself.
