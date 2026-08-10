/*
 * @file Composite C/C++ auto-fix: autofix first, formatter last — the same
 *   ordering `fix.mts` uses for lint vs. format, so clang-tidy's rewrites
 *   land BEFORE clang-format normalizes whitespace, never after (a
 *   post-format clang-tidy pass would re-dirty files clang-format just
 *   settled).
 *
 *   Steps:
 *   - node scripts/fleet/lint-cpp.mts --fix — clang-tidy autofixes.
 *   - node scripts/fleet/fmt-cpp.mts — clang-format rewrite.
 *
 *   Each step is a real child process (its own tool-absent / no-database /
 *   no-cascaded-config skip applies independently), so this composite never
 *   duplicates either script's skip logic — it only sequences and aggregates
 *   their exit codes.
 *
 *   Usage: node scripts/fleet/fix-cpp.mts
 */

// prefer-async-spawn: sync-required — sequential CLI gate, exit-code
// aggregation.
import path from 'node:path'
import process from 'node:process'

import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { isMainModule } from './_shared/is-main-module.mts'
import { runMain } from './_shared/run-main.mts'
import type { ScriptMeta } from './_shared/run-main.mts'
import { REPO_ROOT } from './paths.mts'

const logger = getDefaultLogger()

/**
 * One step of the composite: argv after the node binary, plus a display
 * label. Argv is repo-relative so it spawns the same way regardless of cwd.
 */
export interface FixCppStep {
  readonly argv: readonly string[]
  readonly label: string
}

/**
 * The composite's steps, in run order. Pure + exported so a test asserts the
 * order (autofix before format) without spawning either script.
 */
export function planFixCppSteps(): FixCppStep[] {
  return [
    {
      argv: [path.join('scripts', 'fleet', 'lint-cpp.mts'), '--fix'],
      label: 'lint-cpp --fix',
    },
    {
      argv: [path.join('scripts', 'fleet', 'fmt-cpp.mts')],
      label: 'fmt-cpp',
    },
  ]
}

/**
 * Run one step as a real child process (`node <script> …`), inheriting stdio.
 * Returns its exit code (0 on success).
 */
export function runFixCppStep(step: FixCppStep, repoRoot: string): number {
  logger.info(`fix-cpp: ${step.label}…`)
  const result = spawnSync(process.execPath, [...step.argv], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  return result.status ?? 1
}

export function main(): void {
  const repoRoot = REPO_ROOT
  let failed = false
  for (const step of planFixCppSteps()) {
    if (runFixCppStep(step, repoRoot) !== 0) {
      failed = true
    }
  }
  if (failed) {
    logger.fail('fix-cpp: one or more steps failed; see output above.')
    process.exitCode = 1
    return
  }
  logger.info('fix-cpp: clean.')
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'runs clang-tidy --fix then clang-format over the repo (autofix first, formatter last)',
  help: `Usage: node scripts/fleet/fix-cpp.mts`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
