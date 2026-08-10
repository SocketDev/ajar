#!/usr/bin/env node
/*
 * @file Claude Code UserPromptSubmit hook — model-policy-guard.
 *
 * Refuses to start a turn on a model the fleet has taken out of service, or
 * with fast mode on. Both verdicts are DERIVED from
 * `scripts/fleet/constants/model-pricing.json`:
 *
 *   - A model is banned iff its entry carries `suspended: true`. No ban list
 *     exists in code, so clearing the flag in the data clears the ban.
 *   - Fast mode is banned iff `policy.fastMode` reads `"banned"`. It bills at
 *     twice the base rate, which multiplies cache-read cost on a large context
 *     instead of buying throughput.
 *
 * Why UserPromptSubmit rather than PreToolUse: the model is chosen once and
 * then bills on every turn, so the turn boundary is the moment to catch it. A
 * per-tool-call block would refuse work already paid for, and would fire dozens
 * of times over one wrong setting.
 *
 * Why a guard and not a nudge: the selection lives in a settings file, so an
 * advisory line scrolls past while the premium keeps billing. The remedy is one
 * edit to one key, which makes the block cheaper to clear than to work around.
 *
 * What it reads: the model is absent from the payload, so the effective
 * selection comes from the settings layers in precedence order (see
 * settings-layers.mts). Nothing else about the prompt is inspected, and no
 * budget figure is read or reported - spend numbers are machine-local runtime
 * config, named by the pricing data's `policy.runtimeConfigPath`.
 *
 * Fails open on anything it cannot resolve: no layer selecting a model means
 * the harness default is in play, which is not this hook's business.
 *
 * Bypass: the slug `model-policy` (`_shared/bypass.mts` owns the spelling).
 */

import { block, defineHook, runHook } from '../_shared/guard.mts'
import { resolveProjectPath } from '../_shared/paths.mts'
import { resolveRepoRoot } from '../_shared/repo-root.mts'
import { verdictLine } from '../_shared/verdict.mts'
import {
  bannedModelMatch,
  fastModeIsBanned,
  fastModeReason,
  modelSelectsFastMode,
} from './model-policy.mts'
import {
  effectiveModelSelection,
  enabledFastModeLayer,
  readModelSettingsLayers,
} from './settings-layers.mts'

import type { GuardResult } from '../_shared/guard.mts'
import type { ToolCallPayload } from '../_shared/payload.mts'
import type { LayerSelection } from './settings-layers.mts'

const HOOK_NAME = 'model-policy-guard'

// Where the policy data lives, named in every message so the reader can see the
// flag the verdict came from.
const POLICY_SOURCE = 'scripts/fleet/constants/model-pricing.json'

/**
 * The block message for a suspended model: which layer selected it, which flag
 * in the data refuses it, and the substitute that data points at.
 */
export function bannedModelMessage(
  selection: LayerSelection,
  id: string,
  substitute: string,
): string {
  const lines = [
    '  What:   the model is out of service fleet-wide.',
    `  Where:  ${selection.label} selects "${selection.value}".`,
    `  Saw:    ${id} carries suspended:true in ${POLICY_SOURCE}.`,
  ]
  if (substitute) {
    lines.push(
      `  Wanted: ${substitute}.`,
      '',
      `  Fix:    switch the model to ${substitute}, then send the prompt`,
      '          again.',
    )
  } else {
    lines.push(
      '  Wanted: a model the pricing data has not suspended.',
      '',
      `  Fix:    pick a model ${POLICY_SOURCE} still prices, then send`,
      '          the prompt again.',
    )
  }
  return verdictLine(
    'block',
    HOOK_NAME,
    `"${selection.value}" is an out-of-service model\n${lines.join('\n')}`,
  )
}

/**
 * The block message for fast mode, quoting the data's own reason for the ban so
 * the reader gets the rationale and not a bare refusal.
 */
export function fastModeMessage(evidence: LayerSelection): string {
  const lines = [
    '  What:   fast mode is banned fleet-wide.',
    `  Where:  ${evidence.label} sets ${evidence.value}.`,
    `  Saw:    policy.fastMode is "banned" in ${POLICY_SOURCE}.`,
    '  Wanted: fast mode off in every settings layer.',
  ]
  const reason = fastModeReason()
  if (reason) {
    lines.push('', `  ${reason}`)
  }
  lines.push(
    '',
    '  Fix:    turn the switch off in the layer named above, then send the',
    '          prompt again.',
  )
  return verdictLine('block', HOOK_NAME, `fast mode is on\n${lines.join('\n')}`)
}

export const check = (payload: ToolCallPayload): GuardResult => {
  // A tool payload is not this hook's surface. UserPromptSubmit carries no
  // tool_name, and the event name pins it whenever the harness supplies one.
  if (payload.tool_name !== undefined) {
    return undefined
  }
  const event = (payload as { hook_event_name?: unknown | undefined })
    .hook_event_name
  if (typeof event === 'string' && event !== 'UserPromptSubmit') {
    return undefined
  }
  const repoRoot = resolveRepoRoot(resolveProjectPath(payload.cwd))
  const layers = readModelSettingsLayers(repoRoot)
  const selection = effectiveModelSelection(layers)
  if (selection) {
    const banned = bannedModelMatch(selection.value)
    if (banned) {
      return block(bannedModelMessage(selection, banned.id, banned.substitute))
    }
  }
  if (!fastModeIsBanned()) {
    return undefined
  }
  // A model id can carry the switch itself (`opus[fast]`), which no settings
  // key records - judge the winning selection as well as the layers.
  if (selection && modelSelectsFastMode(selection.value)) {
    return block(fastModeMessage(selection))
  }
  const fast = enabledFastModeLayer(layers)
  return fast ? block(fastModeMessage(fast)) : undefined
}

export const hook = defineHook({
  bypass: ['model-policy'],
  check,
  event: 'UserPromptSubmit',
  type: 'guard',
})

void runHook(hook, import.meta.url)
