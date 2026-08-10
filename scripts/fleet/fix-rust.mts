/**
 * @file Composite Rust auto-fix lane: run `lint-rust.mts --fix` (clippy's
 *   machine-applicable autofixes) then `fmt-rust.mts` (cargo fmt) — autofix
 *   first, formatter owns final wrapping, the same ordering `fix.mts` uses for
 *   oxlint/oxfmt (`lint --fix` before `format`). Mode:
 *   node scripts/fleet/fix-rust.mts   # clippy --fix, then cargo fmt
 *   This is the sanctioned `fix:rust` entry point — the Rust analog of
 *   `pnpm run fix`'s deterministic lint-then-format pass, minus the AI
 *   residue leg: clippy's `-D warnings` denies every remaining lint, so there
 *   is no judgment-call rule set left to hand to AI. Both steps run even when
 *   the first fails, so a clippy miss never blocks cargo fmt from still
 *   formatting the tree; the exit code aggregates non-zero if either step
 *   failed. Its parts are `lint-rust.mts` and `fmt-rust.mts`.
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
 * The ordered `node <script> [flags]` argv for each step of the composite
 * fix lane. Pure + exported so a test asserts the order (lint --fix before
 * fmt) and the exact flags without spawning either script.
 */
export function planFixRustSteps(): Array<{ args: string[]; label: string }> {
  return [
    {
      args: ['scripts/fleet/lint-rust.mts', '--fix'],
      label: 'lint-rust --fix',
    },
    {
      args: ['scripts/fleet/fmt-rust.mts'],
      label: 'fmt-rust',
    },
  ]
}

export function main(): void {
  const steps = planFixRustSteps()
  let failed = false
  for (let i = 0, { length } = steps; i < length; i += 1) {
    const step = steps[i]!
    logger.info(`fix-rust: ${step.label} (node ${step.args.join(' ')})`)
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
      'fix-rust: lint-rust --fix or fmt-rust failed. Fix: resolve the ' +
        'clippy/cargo fmt output above, then rerun ' +
        'node scripts/fleet/fix-rust.mts.',
    )
    process.exitCode = 1
    return
  }
  logger.info('fix-rust: clean.')
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'runs the Rust auto-fix pair: cargo clippy --fix, then cargo fmt, in that order',
  help: `Usage: node scripts/fleet/fix-rust.mts

  Runs node scripts/fleet/lint-rust.mts --fix, then node scripts/fleet/fmt-rust.mts.
  Clippy's autofixes go first so cargo fmt owns the final wrapping.`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
