/**
 * @file Owning formatter for a repo's first-party C/C++: discover every
 *   `.c`/`.cc`/`.cpp`/`.cxx`/`.h`/`.hpp` file in the tree, skipping
 *   vendored/generated code and other sessions' agent worktrees, and run
 *   `clang-format` over the batch in one invocation. The cascaded root
 *   `.clang-format` (fleet C++ style, see `template/conditional/cpp/`) governs
 *   every run via `--style=file`. Modes:
 *   node scripts/fleet/fmt-cpp.mts           # rewrite
 *   node scripts/fleet/fmt-cpp.mts --check   # verify only (CI / pre-push)
 *   Both `clang-format` absent from PATH and no cascaded `.clang-format` at the
 *   repo root (a non-cpp member running the umbrella somehow) are explicit,
 *   loud skips — exit 0, never a silent pass. Its lint twin is `lint-cpp.mts`.
 */

// prefer-async-spawn: sync-required — sequential CLI gate, exit-code
// aggregation.
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { whichSync } from '@socketsecurity/lib-stable/bin/which'
import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { normalizePath } from '@socketsecurity/lib-stable/paths/normalize'
import { isMainModule } from './_shared/is-main-module.mts'
import { runMain } from './_shared/run-main.mts'
import type { ScriptMeta } from './_shared/run-main.mts'
import { REPO_ROOT } from './paths.mts'

const logger = getDefaultLogger()

const check = process.argv.includes('--check')

// File extensions this walker treats as first-party C/C++ source or headers.
export const CPP_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hpp',
])

// Directories whose C/C++ is not ours to format: vendored/upstream drops,
// build output, and per-checkout caches. Mirrors
// `_shared/cargo-workspaces.mts`'s SKIP_DIRS for the C/C++ walker.
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'build',
  'coverage',
  'deps',
  'external',
  'fixtures',
  'node_modules',
  'target',
  'third_party',
  'upstream',
  'vendor',
])

// Agent worktrees are full checkouts of this repo living inside it, so the
// walk would find their sources and act on files another session is editing.
// Matched on the path rather than the directory name so a repo that
// legitimately owns a `worktrees/` directory keeps its C/C++ covered.
const WORKTREE_ROOT = '.claude/worktrees'

export function isAgentWorktreePath(dirPath: string): boolean {
  const p = normalizePath(dirPath)
  return p === WORKTREE_ROOT || p.endsWith(`/${WORKTREE_ROOT}`)
}

/**
 * Every first-party C/C++ source/header file under `root`, sorted for a
 * deterministic invocation. Pure filesystem walk — no clang-format spawn — so
 * a test asserts the skip set without the tool installed.
 */
export function findCppSourceFiles(root: string): string[] {
  const files: string[] = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (let i = 0, { length } = entries; i < length; i += 1) {
      const name = entries[i]!
      if (
        SKIP_DIRS.has(name) ||
        name.endsWith('-bundled') ||
        name.endsWith('-vendored')
      ) {
        continue
      }
      const abs = path.join(dir, name)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!isAgentWorktreePath(abs)) {
          stack.push(abs)
        }
      } else if (CPP_SOURCE_EXTENSIONS.has(path.extname(name))) {
        files.push(normalizePath(abs))
      }
    }
  }
  return files.toSorted()
}

/**
 * The `clang-format` argv for one batch of files. Pure + exported so a test
 * asserts the `--check` toggle and the file batching without spawning
 * clang-format. `--style=file` makes clang-format walk UP from each file to
 * find the nearest `.clang-format` — the cascaded root config — rather than
 * fall back to its own defaults.
 */
export function buildClangFormatArgs(
  files: readonly string[],
  options?: { check?: boolean | undefined } | undefined,
): string[] {
  const opts = { __proto__: null, ...options } as {
    check?: boolean | undefined
  }
  return [
    '--style=file',
    ...(opts.check ? ['--dry-run', '--Werror'] : ['-i']),
    ...files,
  ]
}

export function main(): void {
  const repoRoot = REPO_ROOT
  const files = findCppSourceFiles(repoRoot)
  if (!files.length) {
    logger.info(
      'fmt-cpp: no first-party C/C++ source found; nothing to format.',
    )
    return
  }
  const bin = whichSync('clang-format', { nothrow: true })
  if (!bin || typeof bin !== 'string') {
    logger.warn(
      'fmt-cpp: clang-format not on PATH — skipping (explicit skip, not a ' +
        'pass). Run `pnpm run setup:brew` to install it.',
    )
    return
  }
  if (!existsSync(path.join(repoRoot, '.clang-format'))) {
    logger.warn(
      'fmt-cpp: no .clang-format at the repo root — skipping (explicit skip, ' +
        'not a pass). This member does not carry the cpp capability cascade.',
    )
    return
  }
  logger.info(
    `fmt-cpp: clang-format ${check ? '--dry-run ' : ''}(${files.length} file(s))`,
  )
  const result = spawnSync(bin, buildClangFormatArgs(files, { check }), {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    logger.fail(
      check
        ? 'fmt-cpp: formatting drift found. Fix: node scripts/fleet/fmt-cpp.mts'
        : 'fmt-cpp: clang-format failed.',
    )
    process.exitCode = 1
    return
  }
  logger.info('fmt-cpp: clean.')
}

const SCRIPT_META: ScriptMeta = {
  describe:
    "run clang-format over every first-party C/C++ file in the tree under the fleet's .clang-format style",
  help: `Usage: node scripts/fleet/fmt-cpp.mts [flags]
  --check  verify only; exit non-zero on formatting drift`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
