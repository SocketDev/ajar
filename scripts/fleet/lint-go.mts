/**
 * @file Owning linter for a repo's first-party Go: run `golangci-lint` for
 *   every Go module in the tree, skipping vendored/generated code. The
 *   cascaded `.golangci.yml` at the repo root governs every run — golangci-lint
 *   discovers it by walking up from the module dir it is invoked in, so no
 *   `--config` flag is needed here. Modes:
 *   node scripts/fleet/lint-go.mts         # verify (CI / pre-push)
 *   node scripts/fleet/lint-go.mts --fix   # apply golangci-lint's autofixes
 *   Module discovery is shared with `fmt-go.mts` via
 *   `_shared/go-workspaces.mts`. A machine with no `golangci-lint` on PATH
 *   skips loud rather than failing the gate — run `pnpm run setup:go`, or
 *   install it directly (https://golangci-lint.run/welcome/install/ or
 *   `brew install golangci-lint`). Its format twin is `fmt-go.mts`.
 */

// prefer-async-spawn: sync-required — sequential CLI gates, exit-code
// aggregation.
import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { findGoModuleDirs } from './_shared/go-workspaces.mts'
import { isMainModule } from './_shared/is-main-module.mts'
import { runMain } from './_shared/run-main.mts'
import type { ScriptMeta } from './_shared/run-main.mts'
import { REPO_ROOT } from './paths.mts'

const logger = getDefaultLogger()

const fix = process.argv.includes('--fix')

/**
 * The `golangci-lint` argv for one module dir. Pure + exported so a test
 * asserts the `--fix` toggle without spawning golangci-lint. Any argv flag
 * this script doesn't recognize is ignored rather than rejected — `main`
 * reads `--fix` via a plain `process.argv.includes`, never a strict parser.
 */
export function buildGolangciArgs(
  options?: { fix?: boolean | undefined } | undefined,
): string[] {
  const opts = { __proto__: null, ...options } as {
    fix?: boolean | undefined
  }
  return ['run', ...(opts.fix ? ['--fix'] : [])]
}

export function main(): void {
  const repoRoot = REPO_ROOT
  const moduleDirs = findGoModuleDirs(repoRoot)
  if (!moduleDirs.length) {
    logger.info('lint-go: no go.mod found; nothing to lint.')
    return
  }
  const args = buildGolangciArgs({ fix })
  let failed = false
  for (let i = 0, { length } = moduleDirs; i < length; i += 1) {
    const dir = moduleDirs[i]!
    logger.info(
      `lint-go: golangci-lint ${args.join(' ')} (${path.relative(repoRoot, dir) || '.'})`,
    )
    const result = spawnSync('golangci-lint', args, {
      cwd: dir,
      stdio: 'inherit',
    })
    const spawnError = result.error as NodeJS.ErrnoException | undefined
    if (spawnError?.code === 'ENOENT') {
      logger.info(
        'lint-go: golangci-lint is not on PATH; skipping.\n' +
          '  Fix: pnpm run setup:go, or install golangci-lint directly ' +
          '(https://golangci-lint.run/welcome/install/ or `brew install golangci-lint`).',
      )
      return
    }
    if (result.status !== 0) {
      failed = true
    }
  }
  if (failed) {
    logger.fail(
      fix
        ? 'lint-go: golangci-lint --fix failed.'
        : 'lint-go: golangci-lint findings. Fix: node scripts/fleet/lint-go.mts --fix (autofixes only; the rest are hand fixes).',
    )
    process.exitCode = 1
    return
  }
  logger.info('lint-go: clean.')
}

const SCRIPT_META: ScriptMeta = {
  describe: 'runs golangci-lint over every first-party Go module in the tree',
  help: `Usage: node scripts/fleet/lint-go.mts [flags]

  --fix  apply golangci-lint's machine-applicable autofixes`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
