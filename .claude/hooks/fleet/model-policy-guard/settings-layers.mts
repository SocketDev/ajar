/*
 * @file Which model the session is actually running, and whether any layer has
 *   fast mode on.
 *
 *   A UserPromptSubmit payload does not carry the model, so the effective
 *   selection is read from the layers that set it, highest precedence first:
 *   the process environment, then the checkout's `.claude/settings.local.json`
 *   (operator-local, gitignored), then its `.claude/settings.json` (the
 *   cascaded shared file), then `~/.claude/settings.json`. That is Claude Code's
 *   own order with the enterprise-managed layer left out, since a hook cannot
 *   read a machine it is not running on.
 *
 *   Each file contributes two facts: a `model` selection, and a fast-mode
 *   switch — either the settings key or a `env` block naming one of the
 *   fast-mode variables. The BAN verdict is not decided here; this module only
 *   reports what each layer says. `model-policy.mts` owns the policy.
 *
 *   Labels are written relative to the checkout or as `~/…`, never as an
 *   absolute path, so a block message never prints an operator's home
 *   directory.
 */

import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import {
  FAST_MODE_SETTING_KEYS,
  fastModeInEnvRecord,
  isFastModeValue,
  modelInEnvRecord,
} from './model-policy.mts'

/**
 * One layer's contribution to the effective selection.
 */
export interface ModelSettingsLayer {
  // How the layer is named in a message: `~/.claude/settings.json`, or
  // `the environment` for the process env.
  readonly label: string
  // The model this layer selects, or undefined when it selects none.
  readonly model: string | undefined
  // The fast-mode switch this layer turns on, as `<key>=<value>` evidence, or
  // undefined when the layer leaves fast mode alone.
  readonly fastMode: string | undefined
}

/**
 * A resolved selection: the value and the layer that supplied it.
 */
export interface LayerSelection {
  readonly label: string
  readonly value: string
}

/**
 * The settings files that can select a model, highest precedence first. Paths
 * are absolute (they are read); the LABELS the messages use come from
 * {@link readModelSettingsLayers}.
 */
export function settingsLayerFiles(
  repoRoot: string,
): ReadonlyArray<{ readonly file: string; readonly label: string }> {
  return [
    {
      __proto__: null,
      file: path.join(repoRoot, '.claude', 'settings.local.json'),
      label: '.claude/settings.local.json',
    } as { readonly file: string; readonly label: string },
    {
      __proto__: null,
      file: path.join(repoRoot, '.claude', 'settings.json'),
      label: '.claude/settings.json',
    } as { readonly file: string; readonly label: string },
    {
      __proto__: null,
      file: path.join(os.homedir(), '.claude', 'settings.json'),
      label: '~/.claude/settings.json',
    } as { readonly file: string; readonly label: string },
  ]
}

/**
 * Parse one settings file into a layer. Returns undefined when the file is
 * absent or unparseable — a hook never fails a turn over a malformed settings
 * file it does not own.
 */
export function readSettingsFileLayer(
  file: string,
  label: string,
): ModelSettingsLayer | undefined {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined
  }
  const env =
    parsed['env'] && typeof parsed['env'] === 'object'
      ? (parsed['env'] as Record<string, unknown>)
      : undefined
  const topLevelModel =
    typeof parsed['model'] === 'string' && parsed['model'].trim()
      ? parsed['model'].trim()
      : undefined
  let fastMode = fastModeInEnvRecord(env)
  if (fastMode === undefined) {
    for (const key of FAST_MODE_SETTING_KEYS) {
      if (isFastModeValue(parsed[key])) {
        fastMode = `${key}=${String(parsed[key])}`
        break
      }
    }
  }
  return {
    __proto__: null,
    fastMode,
    label,
    model: topLevelModel ?? modelInEnvRecord(env),
  } as ModelSettingsLayer
}

/**
 * The process environment as a layer. Highest precedence: an exported variable
 * overrides every settings file.
 */
export function readEnvLayer(
  env: Readonly<Record<string, string | undefined>>,
): ModelSettingsLayer {
  return {
    __proto__: null,
    fastMode: fastModeInEnvRecord(env),
    label: 'the environment',
    model: modelInEnvRecord(env),
  } as ModelSettingsLayer
}

/**
 * Every layer that has something to say about the model, highest precedence
 * first. A layer selecting nothing and setting nothing is dropped, so callers
 * can treat the list as the evidence set.
 */
export function readModelSettingsLayers(
  repoRoot: string,
): readonly ModelSettingsLayer[] {
  const out: ModelSettingsLayer[] = [readEnvLayer(process.env)]
  for (const { file, label } of settingsLayerFiles(repoRoot)) {
    const layer = readSettingsFileLayer(file, label)
    if (layer) {
      out.push(layer)
    }
  }
  return out.filter(
    layer => layer.model !== undefined || layer.fastMode !== undefined,
  )
}

/**
 * The model the session is running: the first layer, in precedence order, that
 * selects one. Undefined when no layer does, which means the harness default is
 * in play and there is nothing for a policy to judge.
 */
export function effectiveModelSelection(
  layers: readonly ModelSettingsLayer[],
): LayerSelection | undefined {
  for (const layer of layers) {
    if (layer.model !== undefined) {
      return {
        __proto__: null,
        label: layer.label,
        value: layer.model,
      } as LayerSelection
    }
  }
  return undefined
}

/**
 * The first layer with fast mode on, in precedence order. Fast mode is checked
 * across EVERY layer rather than only the winning one: a lower layer turning it
 * on still bills at the premium, because nothing higher up turns it back off.
 */
export function enabledFastModeLayer(
  layers: readonly ModelSettingsLayer[],
): LayerSelection | undefined {
  for (const layer of layers) {
    if (layer.fastMode !== undefined) {
      return {
        __proto__: null,
        label: layer.label,
        value: layer.fastMode,
      } as LayerSelection
    }
  }
  return undefined
}
