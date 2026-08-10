#!/usr/bin/env node
/*
 * @file prepare lifecycle orchestrator. Runs after pnpm install completes.
 *   Kept as a script (not inline in package.json) so it can be tested, linted,
 *   and updated by the wheelhouse cascade. Steps:
 *
 *   1. Install fleet git hooks.
 *   2. Rebuild the V8 hook snapshot when this checkout's settings.json points
 *      at the native launcher but the launcher or its blob is missing.
 *
 *   Usage: node scripts/fleet/prepare.mts
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { errorMessage } from '@socketsecurity/lib-stable/errors/message'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'

import { isMainModule } from './_shared/is-main-module.mts'
import { runMain } from './_shared/run-main.mts'
import { REPO_ROOT } from './paths.mts'

import type { ScriptMeta } from './_shared/run-main.mts'

const DISPATCH_DIR = path.join(REPO_ROOT, '.claude/hooks/fleet/_shared')

const SETTINGS_PATH = path.join(REPO_ROOT, '.claude/settings.json')

const LAUNCHER_NAME =
  process.platform === 'win32' ? 'dispatch-launcher.exe' : 'dispatch-launcher'

const logger = getDefaultLogger()

export async function run(
  label: string,
  cmd: string,
  args: string[],
): Promise<boolean> {
  try {
    await spawn(cmd, args, { stdio: 'inherit' })
    return true
  } catch (error) {
    logger.error(`${label} failed: ${errorMessage(error)}`)
    return false
  }
}

interface ClaudeSettings {
  hooks?:
    | Record<
        string,
        | Array<{
            hooks?: Array<{ command?: unknown | undefined }> | undefined
          }>
        | undefined
      >
    | undefined
}

/**
 * True when settings dispatches hooks through the native launcher. Only then
 * does a missing launcher matter: the fleet default is
 * `node .claude/hooks/fleet/index.cjs`, which needs nothing built and is what
 * every member ships with.
 *
 * Walks the parsed hook commands rather than scanning the file text, so a
 * launcher named in an unrelated comment or a settings key cannot be mistaken
 * for one that actually dispatches.
 */
export function dispatchesThroughLauncher(settings: ClaudeSettings): boolean {
  const events = Object.values(settings.hooks ?? {})
  for (let i = 0, { length } = events; i < length; i += 1) {
    const matchers = events[i] ?? []
    for (let j = 0, matcherCount = matchers.length; j < matcherCount; j += 1) {
      const entries = matchers[j]?.hooks ?? []
      for (let k = 0, entryCount = entries.length; k < entryCount; k += 1) {
        const command = entries[k]?.command
        if (typeof command === 'string' && command.includes(LAUNCHER_NAME)) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * True when `blobPath` was built for a different node than the one running.
 *
 * The cache keys each blob under a `v<version>-<arch>-…` directory, and V8
 * refuses a blob from another version outright: `node --snapshot-blob` exits
 * 14 with "built with Node.js version X and the current Node.js version is Y".
 * That matters more than a missing file, because the launcher `execv`s — once
 * the exec succeeds there is no fallback left, so a stranded blob is a hard
 * failure rather than a slow path. A `.node-version` bump does exactly this.
 */
export function blobIsForAnotherRuntime(
  blobPath: string,
  nodeVersion: string,
): boolean {
  return !blobPath.includes(`v${nodeVersion}-`)
}

/**
 * True when the launcher this checkout dispatches through cannot actually run:
 * the binary is gone, a sidecar is gone, the sidecar names a blob that no
 * longer exists, or that blob belongs to another node. Any of those and hooks
 * stop working with nothing said.
 */
export function launcherIsBroken(
  dispatchDir: string,
  nodeVersion: string = process.versions.node,
): boolean {
  const launcher = path.join(dispatchDir, LAUNCHER_NAME)
  const blobSidecar = path.join(dispatchDir, 'snapshot-blob.path')
  if (!existsSync(launcher) || !existsSync(blobSidecar)) {
    return true
  }
  try {
    const blobPath = readFileSync(blobSidecar, 'utf8').trim()
    return (
      !existsSync(blobPath) || blobIsForAnotherRuntime(blobPath, nodeVersion)
    )
  } catch {
    return true
  }
}

export async function main(): Promise<void> {
  const ok = await run('install-git-hooks', 'node', [
    'scripts/fleet/install-git-hooks.mts',
  ])
  if (!ok) {
    process.exitCode = 1
    return
  }
  // Rebuild ONLY when this checkout dispatches through the launcher and that
  // launcher is unusable. The snapshot build is a bundle plus a ~17 MB blob
  // plus a C compile; paying that on every install would be worse than the
  // problem. A bundle-only member never reaches here, and hook-snapshot.mts
  // self-skips there anyway.
  let settings: ClaudeSettings
  try {
    settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as ClaudeSettings
  } catch {
    // Absent or malformed settings: the settings-schema check owns that, and
    // there is no launcher wiring to repair either way.
    return
  }
  if (!dispatchesThroughLauncher(settings) || !launcherIsBroken(DISPATCH_DIR)) {
    return
  }
  logger.log(
    'prepare: settings.json dispatches through the hook launcher, which is missing or stale — rebuilding it.',
  )
  // Non-fatal. A machine without a C toolchain still gets working hooks
  // through the compile-cache baseline, so a failed rebuild must not fail the
  // install.
  await run('setup:3-hook-snapshot', 'node', [
    'scripts/fleet/setup/hook-snapshot.mts',
    '--wire-launcher',
  ])
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'runs the post-install prepare steps (installs the fleet git hooks)',
  help: 'Usage: node scripts/fleet/prepare.mts',
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
