/**
 * @file Owning linter for a repo's first-party C/C++: run `clang-tidy` per
 *   translation unit named in a `compile_commands.json`, discovered at the
 *   repo root or under a top-level `build`-prefixed directory. The cascaded
 *   root `.clang-tidy` (fleet C++ checks, see `template/conditional/cpp/`)
 *   governs every run via `-p <dir>`.
 *   Modes:
 *   node scripts/fleet/lint-cpp.mts         # verify (CI / pre-push)
 *   node scripts/fleet/lint-cpp.mts --fix   # apply clang-tidy's autofixes
 *   clang-tidy can't run without a compilation database — it has no
 *   `--all-targets`-style discovery of its own — so a repo with no
 *   `compile_commands.json` (no real native build configured yet) is an
 *   explicit, loud skip, exit 0, never a silent pass. Same for `clang-tidy`
 *   absent from PATH. Its format twin is `fmt-cpp.mts`.
 */

// prefer-async-spawn: sync-required — sequential CLI gate, exit-code
// aggregation.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { whichSync } from '@socketsecurity/lib-stable/bin/which'
import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { isMainModule } from './_shared/is-main-module.mts'
import { runMain } from './_shared/run-main.mts'
import type { ScriptMeta } from './_shared/run-main.mts'
import { REPO_ROOT } from './paths.mts'

const logger = getDefaultLogger()

const COMPILE_COMMANDS_FILE = 'compile_commands.json'

const fix = process.argv.includes('--fix')

/**
 * The directory holding a `compile_commands.json`, searched at the repo root
 * first, then any top-level directory whose name starts with `build`
 * (`build`, `build-release`, `build.ninja-out`, …) — the common CMake /
 * ninja output locations. `undefined` when neither carries one, meaning this
 * repo has no compilation database yet.
 */
export function findCompileCommandsDir(repoRoot: string): string | undefined {
  if (existsSync(path.join(repoRoot, COMPILE_COMMANDS_FILE))) {
    return repoRoot
  }
  let entries: string[]
  try {
    entries = readdirSync(repoRoot)
  } catch {
    return undefined
  }
  const buildDirs = entries
    .filter(name => /^build/i.test(name))
    .toSorted((a, b) => a.localeCompare(b))
  for (let i = 0, { length } = buildDirs; i < length; i += 1) {
    const abs = path.join(repoRoot, buildDirs[i]!)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory() && existsSync(path.join(abs, COMPILE_COMMANDS_FILE))) {
      return abs
    }
  }
  return undefined
}

/**
 * The `file` entries of a `compile_commands.json` — one per translation unit.
 * Pure JSON read, no clang-tidy spawn, so a test asserts the parse without the
 * tool installed. Returns an empty array on any read/parse failure or a
 * non-array/malformed root; a database that exists but names nothing to lint
 * is not a crash.
 */
export function readTranslationUnits(compileCommandsPath: string): string[] {
  let raw: string
  try {
    raw = readFileSync(compileCommandsPath, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }
  const files: string[] = []
  for (let i = 0, { length } = parsed; i < length; i += 1) {
    const entry = parsed[i]
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const file = (entry as Record<string, unknown>)['file']
      if (typeof file === 'string' && file.length > 0) {
        files.push(file)
      }
    }
  }
  return files
}

/**
 * The `clang-tidy` argv for one translation unit. Pure + exported so a test
 * asserts the `--fix` toggle and the `-p` flag without spawning clang-tidy.
 */
export function buildClangTidyArgs(
  file: string,
  options?:
    | { compileCommandsDir?: string | undefined; fix?: boolean | undefined }
    | undefined,
): string[] {
  const opts = { __proto__: null, ...options } as {
    compileCommandsDir?: string | undefined
    fix?: boolean | undefined
  }
  return [
    file,
    '-p',
    opts.compileCommandsDir ?? '.',
    ...(opts.fix ? ['--fix'] : []),
  ]
}

export function main(): void {
  const repoRoot = REPO_ROOT
  const compileCommandsDir = findCompileCommandsDir(repoRoot)
  if (compileCommandsDir === undefined) {
    logger.warn(
      `lint-cpp: no ${COMPILE_COMMANDS_FILE} found at the repo root or under ` +
        'a build*/ directory — skipping (explicit skip, not a pass). ' +
        'clang-tidy needs a compilation database; a repo with a real native ' +
        'build (CMAKE_EXPORT_COMPILE_COMMANDS=ON, or `bear`) emits one.',
    )
    return
  }
  const bin = whichSync('clang-tidy', { nothrow: true })
  if (!bin || typeof bin !== 'string') {
    logger.warn(
      'lint-cpp: clang-tidy not on PATH — skipping (explicit skip, not a ' +
        'pass). Run `pnpm run setup:brew` to install it.',
    )
    return
  }
  const files = readTranslationUnits(
    path.join(compileCommandsDir, COMPILE_COMMANDS_FILE),
  )
  if (!files.length) {
    logger.info(
      `lint-cpp: ${COMPILE_COMMANDS_FILE} names no translation units; ` +
        'nothing to lint.',
    )
    return
  }
  let failed = false
  for (let i = 0, { length } = files; i < length; i += 1) {
    const file = files[i]!
    logger.info(`lint-cpp: clang-tidy ${path.relative(repoRoot, file)}`)
    const result = spawnSync(
      bin,
      buildClangTidyArgs(file, { compileCommandsDir, fix }),
      { cwd: repoRoot, stdio: 'inherit' },
    )
    if (result.status !== 0) {
      failed = true
    }
  }
  if (failed) {
    logger.fail(
      fix
        ? 'lint-cpp: clang-tidy --fix failed.'
        : 'lint-cpp: clang-tidy findings. Fix: node scripts/fleet/lint-cpp.mts --fix (autofixes only; the rest are hand fixes).',
    )
    process.exitCode = 1
    return
  }
  logger.info('lint-cpp: clean.')
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'runs clang-tidy over every translation unit in the repo compilation database',
  help: `Usage: node scripts/fleet/lint-cpp.mts [flags]

  --fix  apply clang-tidy's machine-applicable autofixes`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
