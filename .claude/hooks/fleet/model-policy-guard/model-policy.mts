/*
 * @file The fleet's model-cost policy, DERIVED from
 *   `scripts/fleet/constants/model-pricing.json`. Both model-policy hooks read
 *   their verdicts from here so there is exactly one interpretation of that
 *   data.
 *
 *   Two verdicts come out of the file and neither is restated in code:
 *     - A model is BANNED iff its entry under `services.*.models` carries
 *       `suspended: true`. There is deliberately no ban list in this module, so
 *       a ban and a price can never disagree and clearing the flag in the data
 *       clears the ban with no code change.
 *     - Fast mode is BANNED iff the file's top-level `policy.fastMode` reads
 *       `"banned"`.
 *
 *   The sanctioned substitute comes out of the same data: the suspending
 *   service's `notes` carry a quoted `use <model>` directive, and a service
 *   carrying none falls back to naming its non-suspended model ids. Either way
 *   a block tells the reader what to switch to.
 *
 *   The JSON is imported statically, the same shape `_shared/fleet-repos.mts`
 *   uses for the roster: the value travels inside the hook bundle, so no hook
 *   touches the filesystem on the prompt path. A pricing refresh reaches the
 *   guards on the next `pnpm run dogfood` bundle rebuild.
 *
 *   No budget figure lives here or in any other committed file. Spend numbers
 *   are machine-local runtime config, named by `policy.runtimeConfigPath`.
 */

import pricingJson from '../../../../scripts/fleet/constants/model-pricing.json' with { type: 'json' }

const PRICING: Readonly<Record<string, unknown>> = pricingJson

/**
 * A model the pricing data has suspended, with everything a block message
 * needs: the canonical id, the short family alias a CLI accepts for it, the
 * service that suspended it, and what to use instead.
 */
export interface BannedModel {
  // The short family token a CLI accepts in place of the full id (`fable` for
  // `claude-fable-5`), or undefined when the id has no such form.
  readonly alias: string | undefined
  // The canonical model id as written in the pricing data.
  readonly id: string
  // The service key under `services` that carries the suspension.
  readonly service: string
  // The model to use instead, read out of the service's own notes.
  readonly substitute: string
}

/**
 * The settings keys that turn fast mode on. Read in every settings layer.
 */
export const FAST_MODE_SETTING_KEYS: readonly string[] = ['fastMode']

/**
 * Environment variables that turn fast mode on, whether exported in a shell or
 * set through a settings file's `env` block.
 */
export const FAST_MODE_ENV_VARS: readonly string[] = [
  'ANTHROPIC_FAST_MODE',
  'CLAUDE_CODE_FAST_MODE',
  'CLAUDE_FAST_MODE',
]

/**
 * CLI flags that turn fast mode on for one `claude` invocation.
 */
export const FAST_MODE_FLAGS: readonly string[] = ['--fast', '--fast-mode']

/**
 * The bracketed model-id variant that selects fast mode (`opus[fast]`) — the
 * same spelling the long-context variant uses (`sonnet[1m]`).
 */
export const FAST_MODE_MODEL_SUFFIX = '[fast]'

/**
 * Environment variables that select a model outright, so a shell line or a
 * settings `env` block can be judged the same way a `model` key is.
 */
export const MODEL_ENV_VARS: readonly string[] = ['ANTHROPIC_MODEL']

/**
 * The payload key that names a model on a spawn tool. Nested at any depth: a
 * Workflow declares one per agent.
 */
export const MODEL_KEY = 'model'

// Values that read as "on" for a fast-mode switch. A settings file may carry a
// real boolean; an env var is always a string.
const FAST_MODE_ON_VALUES: ReadonlySet<string> = new Set([
  '1',
  'on',
  'true',
  'yes',
])

// The quoted directive a service's notes carry beside a suspension, e.g.
// `'use Opus 4.8'`. Regex parts: `'` the opening quote, `use\s+` the directive
// verb, `([^']+)` the substitute name up to the closing quote.
const SUBSTITUTE_DIRECTIVE_RE = /'use\s+([^']+)'/i

// A bracketed model-id variant suffix, e.g. the `[1m]` in `sonnet[1m]`.
// Regex parts: `\[` the opening bracket, `[^\]]*` the variant token, `\]$` the
// closing bracket at end of string.
const MODEL_VARIANT_SUFFIX_RE = /\[[^\]]*\]$/

// A vendor namespace prefix on a hosted model id: the `us.anthropic.` in
// `us.anthropic.claude-fable-5-v1:0`. Regex parts: `^` start, `(?:[a-z0-9-]+\.)?`
// an optional region token, `anthropic\.` the vendor namespace.
const VENDOR_NAMESPACE_RE = /^(?:[a-z0-9-]+\.)?anthropic\./

// A trailing revision or release-date qualifier: the `-v1` in `…-v1:0` (after
// the colon is cut) or the `-20251001` in `claude-haiku-4-5-20251001`.
// Regex parts: `-` the separator, `(?:\d{6,8}|v\d+)` a date or a revision,
// `$` end of string.
const MODEL_QUALIFIER_RE = /-(?:\d{6,8}|v\d+)$/

let cachedBanned: readonly BannedModel[] | undefined

function recordOf(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      out.push(item)
    }
  }
  return out
}

/**
 * The substitute a service's `notes` name, or undefined when none does. The
 * data carries it as a quoted `use <model>` directive beside the suspension
 * note, so the guards can name a replacement without hardcoding one.
 */
export function substituteFromNotes(
  notes: readonly string[],
): string | undefined {
  for (const note of notes) {
    const matched = SUBSTITUTE_DIRECTIVE_RE.exec(note)
    if (matched) {
      return matched[1]!.trim()
    }
  }
  return undefined
}

/**
 * The short family token a CLI accepts in place of a full model id — `fable`
 * for `claude-fable-5`. Undefined for an id with no `claude-<family>-<version>`
 * shape, including the slash- or colon-namespaced ids of the third-party
 * services, where a bare family token would be meaningless.
 */
export function modelFamilyAlias(id: string): string | undefined {
  if (id.includes('/') || id.includes(':')) {
    return undefined
  }
  const withoutVendor = id.startsWith('claude-') ? id.slice(7) : id
  const dash = withoutVendor.indexOf('-')
  if (dash <= 0) {
    return undefined
  }
  return withoutVendor.slice(0, dash)
}

/**
 * Every model the pricing data has suspended, in service then id order.
 * Memoized: the data is a static import, so the derivation runs once per
 * process.
 */
export function bannedModels(): readonly BannedModel[] {
  if (cachedBanned !== undefined) {
    return cachedBanned
  }
  const out: BannedModel[] = []
  const services = recordOf(PRICING['services'])
  const serviceKeys = Object.keys(services ?? {})
  // oxlint-disable-next-line unicorn/no-array-sort -- fresh copy
  const serviceNames = serviceKeys.slice().sort()
  for (
    let outer = 0, serviceCount = serviceNames.length;
    outer < serviceCount;
    outer += 1
  ) {
    const serviceName = serviceNames[outer] as string
    const service = recordOf(services?.[serviceName])
    const models = recordOf(service?.['models'])
    if (!models) {
      continue
    }
    // oxlint-disable-next-line unicorn/no-array-sort -- fresh copy
    const ids = Object.keys(models).slice().sort()
    const suspended = ids.filter(id => recordOf(models[id])?.['suspended'])
    if (suspended.length === 0) {
      continue
    }
    // The service's own notes name the replacement; a service carrying no
    // directive falls back to its surviving ids, so the reader is never told
    // only what is refused.
    const substitute =
      substituteFromNotes(stringsOf(service?.['notes'])) ??
      ids.filter(id => !recordOf(models[id])?.['suspended']).join(', ')
    for (let i = 0, { length } = suspended; i < length; i += 1) {
      const id = suspended[i]!
      out.push({
        __proto__: null,
        alias: modelFamilyAlias(id),
        id,
        service: serviceName,
        substitute,
      } as BannedModel)
    }
  }
  cachedBanned = out
  return out
}

/**
 * Fold a model selection down to the id the pricing data would carry: case,
 * a bracketed variant suffix, a provider route prefix, a vendor namespace, and
 * a trailing revision or release date all come off. Returns '' for a value
 * that carries no id at all.
 */
export function normalizeModelId(value: string): string {
  let out = value.trim().toLowerCase()
  out = out.replace(MODEL_VARIANT_SUFFIX_RE, '')
  // A hosted route (`bedrock/…`) or a Bedrock inference-profile arn keeps the
  // id in its last segment.
  const slash = out.lastIndexOf('/')
  if (slash >= 0) {
    out = out.slice(slash + 1)
  }
  // `…-v1:0` carries the revision after a colon.
  const colon = out.indexOf(':')
  if (colon > 0) {
    out = out.slice(0, colon)
  }
  out = out.replace(VENDOR_NAMESPACE_RE, '')
  out = out.replace(MODEL_QUALIFIER_RE, '')
  return out.trim()
}

/**
 * The banned model a selection resolves to, or undefined when it resolves to a
 * sanctioned one. Accepts a full id, a hosted or dated spelling of it, or the
 * short family alias a CLI takes.
 */
export function bannedModelMatch(value: unknown): BannedModel | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = normalizeModelId(value)
  if (!normalized) {
    return undefined
  }
  const banned = bannedModels()
  for (const model of banned) {
    if (normalized === model.id || normalized.endsWith(`.${model.id}`)) {
      return model
    }
  }
  for (const model of banned) {
    if (model.alias !== undefined && normalized === model.alias) {
      return model
    }
  }
  return undefined
}

/**
 * True when the pricing data's top-level policy bans fast mode. The guards
 * stand down on fast mode entirely when it does not.
 */
export function fastModeIsBanned(): boolean {
  return recordOf(PRICING['policy'])?.['fastMode'] === 'banned'
}

/**
 * The data's own reason for the fast-mode ban, quoted back in a block message
 * so the reader gets the rationale rather than a bare refusal.
 */
export function fastModeReason(): string | undefined {
  const reason = recordOf(PRICING['policy'])?.['fastModeReason']
  return typeof reason === 'string' ? reason : undefined
}

/**
 * True when a settings value or env-var value reads as "fast mode on".
 */
export function isFastModeValue(value: unknown): boolean {
  if (value === true) {
    return true
  }
  return (
    typeof value === 'string' &&
    FAST_MODE_ON_VALUES.has(value.trim().toLowerCase())
  )
}

/**
 * True when a model selection asks for fast mode through its id, the
 * `opus[fast]` spelling.
 */
export function modelSelectsFastMode(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim().toLowerCase().endsWith(FAST_MODE_MODEL_SUFFIX)
  )
}

/**
 * The fast-mode switch an `env`-style record turns on, as
 * `<NAME>=<value>` evidence, or undefined when none is on.
 */
export function fastModeInEnvRecord(
  env: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (!env) {
    return undefined
  }
  for (let i = 0, { length } = FAST_MODE_ENV_VARS; i < length; i += 1) {
    const name = FAST_MODE_ENV_VARS[i]!
    const value = env[name]
    if (isFastModeValue(value)) {
      return `${name}=${String(value)}`
    }
  }
  return undefined
}

/**
 * The model an `env`-style record selects, or undefined when it selects none.
 */
export function modelInEnvRecord(
  env: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (!env) {
    return undefined
  }
  for (let i = 0, { length } = MODEL_ENV_VARS; i < length; i += 1) {
    const name = MODEL_ENV_VARS[i]!
    const value = env[name]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}
