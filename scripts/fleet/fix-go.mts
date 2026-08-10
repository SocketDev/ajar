/**
 * @file Composite Go auto-fix lane: run `lint-go.mts --fix` (golangci-lint's
 *   machine-applicable autofixes) then `fmt-go.mts` (gofmt) — autofix first,
 *   formatter owns final wrapping, the same ordering `fix-rust.mts` uses for
 *   clippy/cargo fmt. Mode:
 *   node scripts/fleet/fix-go.mts   # golangci-lint --fix, then gofmt
 *   Both steps run even when the first fails, so a golangci-lint miss never
 *   blocks gofmt from still formatting the tree; the exit code aggregates
 *   non-zero if either step failed. Its parts are `lint-go.mts` and
 *   `fmt-go.mts`.
 */

// prefer-async-spawn: sync-required — sequential CLI gates, exit-code
// aggregation.
import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { isMainModule } from './_shared/is-main-module.mts'
import { runMain } from './_shared/run-main.mts'
import type { ScriptMeta } from './_shared/run-main.mts'
import { REPO_ROOT } from './paths.mts'

const logger = getDefaultLogger()

/**
 * The ordered `node <script> [flags]` argv for each step of the composite fix
 * lane. Pure + exported so a test asserts the order (lint --fix before fmt)
 * and the exact flags without spawning either script.
 */
export function planFixGoSteps(): Array<{ args: string[]; label: string }> {
  return [
    {
      args: ['scripts/fleet/lint-go.mts', '--fix'],
      label: 'lint-go --fix',
    },
    {
      args: ['scripts/fleet/fmt-go.mts'],
      label: 'fmt-go',
    },
  ]
}

export function main(): void {
  const steps = planFixGoSteps()
  let failed = false
  for (let i = 0, { length } = steps; i < length; i += 1) {
    const step = steps[i]!
    logger.info(`fix-go: ${step.label} (node ${step.args.join(' ')})`)
    const result = spawnSync('node', step.args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    })
    if (result.status !== 0) {
      failed = true
    }
  }
  if (failed) {
    logger.fail(
      'fix-go: lint-go --fix or fmt-go failed. Fix: resolve the ' +
        'golangci-lint/gofmt output above, then rerun ' +
        'node scripts/fleet/fix-go.mts.',
    )
    process.exitCode = 1
    return
  }
  logger.info('fix-go: clean.')
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'runs the Go auto-fix pair: golangci-lint --fix, then gofmt, in that order',
  help: `Usage: node scripts/fleet/fix-go.mts

  Runs node scripts/fleet/lint-go.mts --fix, then node scripts/fleet/fmt-go.mts.
  golangci-lint's autofixes go first so gofmt owns the final wrapping.`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
