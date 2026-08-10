/**
 * @file Owning formatter for a repo's first-party Go: run `gofmt` for every Go
 *   module in the tree, skipping vendored/generated code. Modes:
 *   node scripts/fleet/fmt-go.mts           # rewrite
 *   node scripts/fleet/fmt-go.mts --check   # verify only (CI / pre-push)
 *   Module discovery is shared with `lint-go.mts` via
 *   `_shared/go-workspaces.mts`. Unlike a cargo workspace, a Go module never
 *   nests as a "member", so every discovered `go.mod` dir runs on its own. A
 *   machine with no `gofmt` on PATH skips loud rather than failing the gate —
 *   run `pnpm run setup:go` to install the Go toolchain, which ships it. Its
 *   lint twin is `lint-go.mts`.
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

const check = process.argv.includes('--check')

/**
 * The `gofmt` argv for one module dir. Pure + exported so a test asserts the
 * `--check` toggle without spawning gofmt. `-l` always lists the drifted
 * files; `-w` (rewrite mode only) writes the formatted result back in place —
 * `--check` mode omits it so gofmt never mutates the tree it is verifying.
 */
export function buildGofmtArgs(
  options?: { check?: boolean | undefined } | undefined,
): string[] {
  const opts = { __proto__: null, ...options } as {
    check?: boolean | undefined
  }
  return opts.check ? ['-l', '.'] : ['-l', '-w', '.']
}

/**
 * Parse `gofmt -l`'s stdout — one drifted file path per line — into a
 * trimmed, non-empty list. Pure + exported for tests; `gofmt` is never
 * spawned here.
 */
export function parseGofmtDrift(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

export function main(): void {
  const repoRoot = REPO_ROOT
  const moduleDirs = findGoModuleDirs(repoRoot)
  if (!moduleDirs.length) {
    logger.info('fmt-go: no go.mod found; nothing to format.')
    return
  }
  const args = buildGofmtArgs({ check })
  let failed = false
  for (let i = 0, { length } = moduleDirs; i < length; i += 1) {
    const dir = moduleDirs[i]!
    logger.info(
      `fmt-go: gofmt ${args.join(' ')} (${path.relative(repoRoot, dir) || '.'})`,
    )
    const result = spawnSync('gofmt', args, { cwd: dir, encoding: 'utf8' })
    const spawnError = result.error as NodeJS.ErrnoException | undefined
    if (spawnError?.code === 'ENOENT') {
      logger.info(
        'fmt-go: gofmt is not on PATH; skipping.\n' +
          '  Fix: pnpm run setup:go (installs the Go toolchain, which ships gofmt).',
      )
      return
    }
    const drift = parseGofmtDrift(result.stdout)
    if (check) {
      if (drift.length) {
        failed = true
        for (let j = 0, { length: dlen } = drift; j < dlen; j += 1) {
          logger.error(`fmt-go: drift in ${dir}/${drift[j]}`)
        }
      }
    } else {
      if (result.status !== 0) {
        failed = true
        if (result.stderr) {
          logger.error(result.stderr)
        }
      }
      for (let j = 0, { length: dlen } = drift; j < dlen; j += 1) {
        logger.info(`fmt-go: reformatted ${dir}/${drift[j]}`)
      }
    }
  }
  if (failed) {
    logger.fail(
      check
        ? 'fmt-go: formatting drift found. Fix: node scripts/fleet/fmt-go.mts'
        : 'fmt-go: gofmt failed.',
    )
    process.exitCode = 1
    return
  }
  logger.info('fmt-go: clean.')
}

const SCRIPT_META: ScriptMeta = {
  describe: 'run gofmt over every first-party Go module in the tree',
  help: `Usage: node scripts/fleet/fmt-go.mts [flags]
  --check  verify only; exit non-zero on formatting drift`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
