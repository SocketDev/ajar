#!/usr/bin/env node
/*
 * @file Claude Code PreToolUse hook — model-spawn-policy-guard.
 *
 * The spawn-side twin of `model-policy-guard`. That hook holds the SESSION to
 * the model-cost policy at the turn boundary; this one holds every process the
 * session starts to the same policy, so a banned model cannot be reached by
 * delegating to it.
 *
 * Both read one derivation (`../model-policy-guard/model-policy.mts`), which
 * reads one file (`scripts/fleet/constants/model-pricing.json`): a model is
 * banned iff its entry carries `suspended: true`, and fast mode is banned iff
 * `policy.fastMode` reads `"banned"`. Nothing here restates either list.
 *
 * Four surfaces, two shapes:
 *
 *   - `Agent` / `Task` / `Workflow` — judged on the `model` keys in the tool
 *     input, at any depth, because a Workflow declares one per agent. Keyed on
 *     the FIELD NAME, never on the prose: a brief that discusses a suspended
 *     model still runs, which is what keeps the guard usable in a repo whose
 *     own docs name the model.
 *   - `Bash` — judged with the shared shell tokenizer
 *     (`_shared/shell-command.mts`), never with a regex over the command line:
 *     a `claude` invocation's `--model` value, a fast-mode flag on it, and a
 *     model- or fast-mode environment assignment on any segment of the line.
 *
 * Fails open on anything it cannot resolve — a `$VAR`-sourced model, a flag
 * with no value, a payload shape it does not recognize.
 *
 * Exit codes: 0 pass, 2 block.
 *
 * Bypass: the slug `model-spawn-policy` (`_shared/bypass.mts` owns the
 * spelling).
 */

import { block, defineHook, runHook } from '../_shared/guard.mts'
import { readCommand } from '../_shared/payload.mts'
import {
  commandsFor,
  flagValue,
  invocationHasFlag,
  parseCommands,
} from '../_shared/shell-command.mts'
import { verdictLine } from '../_shared/verdict.mts'
import {
  bannedModelMatch,
  FAST_MODE_ENV_VARS,
  FAST_MODE_FLAGS,
  FAST_MODE_SETTING_KEYS,
  fastModeIsBanned,
  fastModeReason,
  isFastModeValue,
  MODEL_ENV_VARS,
  MODEL_KEY,
  modelSelectsFastMode,
} from '../model-policy-guard/model-policy.mts'

import type { GuardResult } from '../_shared/guard.mts'
import type { ToolCallPayload } from '../_shared/payload.mts'
import type { BannedModel } from '../model-policy-guard/model-policy.mts'

const HOOK_NAME = 'model-spawn-policy-guard'

const POLICY_SOURCE = 'scripts/fleet/constants/model-pricing.json'

// The CLI whose `--model` flag selects a model for a spawned process.
const CLAUDE_BINARY = 'claude'

// The spawn tools that carry a model in their input.
const SPAWN_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'Workflow'])

// Caps on the payload walk. A Workflow input nests agents inside steps, so the
// depth allowance is generous; the node cap bounds a pathological payload.
const MAX_WALK_DEPTH = 8
const MAX_WALK_NODES = 4096

/**
 * What a spawn selects: every model it names, and the fast-mode switch it turns
 * on. Both surfaces (payload keys, shell line) produce this same shape so one
 * verdict function judges them.
 */
export interface SpawnSelections {
  // Evidence for the fast-mode switch (`<key>=<value>`, or a flag), or
  // undefined when the spawn leaves fast mode alone.
  readonly fastMode: string | undefined
  // Every model the spawn names, in walk order.
  readonly models: readonly string[]
}

/**
 * A refused selection: what was seen and, for a model, which banned entry it
 * resolved to.
 */
export interface SpawnFinding {
  readonly evidence: string
  readonly kind: 'fast-mode' | 'model'
  readonly model: BannedModel | undefined
}

function emptySelections(): SpawnSelections {
  return { __proto__: null, fastMode: undefined, models: [] } as SpawnSelections
}

/**
 * Every `model` value in a spawn payload plus the fast-mode switch it sets,
 * found by walking the input for those KEY NAMES at any depth. Values that are
 * not strings are skipped: a model is always named as a string.
 */
export function payloadSelections(input: unknown): SpawnSelections {
  const models: string[] = []
  let fastMode: string | undefined
  let budget = MAX_WALK_NODES
  const walk = (node: unknown, depth: number): void => {
    if (budget <= 0 || depth > MAX_WALK_DEPTH || !node) {
      return
    }
    budget -= 1
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, depth + 1)
      }
      return
    }
    if (typeof node !== 'object') {
      return
    }
    const record = node as Record<string, unknown>
    const keys = Object.keys(record)
    for (let i = 0, { length } = keys; i < length; i += 1) {
      const key = keys[i] as string
      const value = record[key]
      if (key === MODEL_KEY && typeof value === 'string' && value.trim()) {
        models.push(value.trim())
      }
      if (
        MODEL_ENV_VARS.includes(key) &&
        typeof value === 'string' &&
        value.trim()
      ) {
        models.push(value.trim())
      }
      if (
        fastMode === undefined &&
        (FAST_MODE_SETTING_KEYS.includes(key) ||
          FAST_MODE_ENV_VARS.includes(key)) &&
        isFastModeValue(value)
      ) {
        fastMode = `${key}=${String(value)}`
      }
      walk(value, depth + 1)
    }
  }
  walk(input, 0)
  return { __proto__: null, fastMode, models } as SpawnSelections
}

/**
 * The `NAME=value` assignment for one of `names` anywhere in a parsed shell
 * line, as `[name, value]`. Reads the shared parser's own output: a leading
 * assignment on a segment, and an assignment token handed to a wrapper such as
 * `env` or `export`, both surface here, while an assignment quoted inside a
 * message can never reach it.
 */
export function assignmentsIn(
  command: string,
  names: readonly string[],
): ReadonlyArray<readonly [string, string]> {
  const out: Array<readonly [string, string]> = []
  for (const segment of parseCommands(command)) {
    const tokens = [...segment.assignments, ...segment.args]
    for (let i = 0, { length } = tokens; i < length; i += 1) {
      const token = tokens[i]!
      const eq = token.indexOf('=')
      if (eq <= 0) {
        continue
      }
      const name = token.slice(0, eq)
      if (names.includes(name)) {
        out.push([name, token.slice(eq + 1)])
      }
    }
  }
  return out
}

/**
 * What a shell line selects. `claude --model <id>` and an `ANTHROPIC_MODEL=`
 * assignment both name a model; a fast-mode flag on `claude` and a fast-mode
 * environment assignment both turn the switch on.
 */
export function bashSelections(command: string): SpawnSelections {
  const models: string[] = []
  for (const segment of commandsFor(command, CLAUDE_BINARY)) {
    const selected = flagValue(segment.args, `--${MODEL_KEY}`)
    if (selected) {
      models.push(selected)
    }
  }
  for (const [, value] of assignmentsIn(command, MODEL_ENV_VARS)) {
    if (value.trim()) {
      models.push(value.trim())
    }
  }
  let fastMode: string | undefined
  if (invocationHasFlag(command, CLAUDE_BINARY, FAST_MODE_FLAGS)) {
    fastMode = `${FAST_MODE_FLAGS.join(' / ')} on \`${CLAUDE_BINARY}\``
  }
  if (fastMode === undefined) {
    for (const [name, value] of assignmentsIn(command, FAST_MODE_ENV_VARS)) {
      if (isFastModeValue(value)) {
        fastMode = `${name}=${value}`
        break
      }
    }
  }
  return { __proto__: null, fastMode, models } as SpawnSelections
}

/**
 * The refused part of a selection set, or undefined when everything it names is
 * sanctioned. A banned model is reported ahead of fast mode: it is the more
 * specific finding, and it names a substitute.
 */
export function refusedSelection(
  selections: SpawnSelections,
): SpawnFinding | undefined {
  for (const value of selections.models) {
    const banned = bannedModelMatch(value)
    if (banned) {
      return {
        __proto__: null,
        evidence: value,
        kind: 'model',
        model: banned,
      } as SpawnFinding
    }
  }
  if (!fastModeIsBanned()) {
    return undefined
  }
  for (const value of selections.models) {
    if (modelSelectsFastMode(value)) {
      return {
        __proto__: null,
        evidence: value,
        kind: 'fast-mode',
        model: undefined,
      } as SpawnFinding
    }
  }
  return selections.fastMode === undefined
    ? undefined
    : ({
        __proto__: null,
        evidence: selections.fastMode,
        kind: 'fast-mode',
        model: undefined,
      } as SpawnFinding)
}

/**
 * The block message: what the spawn selected, which flag in the data refuses
 * it, and what to select instead.
 */
export function spawnBlockMessage(
  toolName: string,
  finding: SpawnFinding,
): string {
  if (finding.kind === 'model') {
    const banned = finding.model
    const substitute = banned?.substitute
    const lines = [
      `  What:   the spawned ${toolName} selects a model that is out of service`,
      '          fleet-wide.',
      `  Where:  the ${toolName} call selects "${finding.evidence}".`,
      `  Saw:    ${banned?.id} carries suspended:true in ${POLICY_SOURCE}.`,
      substitute
        ? `  Wanted: ${substitute}.`
        : '  Wanted: a model the pricing data has not suspended.',
      '',
      substitute
        ? `  Fix:    spawn on ${substitute} instead, or drop the model`
        : '  Fix:    name a model the data still prices, or drop the model',
      '          selection and inherit the session default.',
    ]
    return verdictLine(
      'block',
      HOOK_NAME,
      `a spawn selects the out-of-service model "${finding.evidence}"\n${lines.join('\n')}`,
    )
  }
  const lines = [
    `  What:   the spawned ${toolName} turns fast mode on, which is banned`,
    '          fleet-wide.',
    `  Where:  the ${toolName} call sets ${finding.evidence}.`,
    `  Saw:    policy.fastMode is "banned" in ${POLICY_SOURCE}.`,
    '  Wanted: the spawn to run at the base rate.',
  ]
  const reason = fastModeReason()
  if (reason) {
    lines.push('', `  ${reason}`)
  }
  lines.push('', '  Fix:    drop the fast-mode switch from the spawn.')
  return verdictLine(
    'block',
    HOOK_NAME,
    `a spawn turns fast mode on\n${lines.join('\n')}`,
  )
}

/**
 * What a payload selects, whichever surface it arrived on. An unmatched tool
 * selects nothing.
 */
export function selectionsFor(payload: ToolCallPayload): SpawnSelections {
  const toolName = payload.tool_name
  if (toolName === 'Bash') {
    const command = readCommand(payload)
    return command ? bashSelections(command) : emptySelections()
  }
  if (toolName !== undefined && SPAWN_TOOLS.has(toolName)) {
    return payloadSelections(payload.tool_input)
  }
  return emptySelections()
}

export const check = (payload: ToolCallPayload): GuardResult => {
  const toolName = payload.tool_name
  if (!toolName) {
    return undefined
  }
  const finding = refusedSelection(selectionsFor(payload))
  return finding ? block(spawnBlockMessage(toolName, finding)) : undefined
}

export const hook = defineHook({
  bypass: ['model-spawn-policy'],
  check,
  event: 'PreToolUse',
  matcher: ['Agent', 'Task', 'Workflow', 'Bash'],
  type: 'guard',
})

void runHook(hook, import.meta.url)
