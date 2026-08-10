/**
 * @file Go module discovery shared by the Go runners (`fmt-go.mts`,
 *   `lint-go.mts`, `fix-go.mts`). Walks a repo for first-party `go.mod` files,
 *   skipping vendored/generated code and other sessions' agent worktrees — the
 *   same floor `cargo-workspaces.mts` applies to `Cargo.toml`. Unlike a cargo
 *   workspace, a `go.mod` nested under another module's directory is NOT a
 *   workspace member — Go modules are independent by default, so every
 *   discovered `go.mod` is kept; none is dropped as an "outer already covers
 *   it" case.
 */

import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { normalizePath } from '@socketsecurity/lib-stable/paths/normalize'

// Directories whose Go is not ours to lint or format: vendored/upstream drops,
// package-manager output, build output, and per-checkout caches. Mirrors
// cargo-workspaces.mts's SKIP_DIRS.
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'coverage',
  'deps',
  'external',
  // A fixtures dir is test corpus, never first-party Go.
  'fixtures',
  'node_modules',
  'target',
  'third_party',
  'upstream',
  'vendor',
])

// Agent worktrees are full checkouts of this repo living inside it, so the
// walk would find their go.mod files and act on source another session is
// editing. Matched on the path rather than the directory name so a repo that
// legitimately owns a `worktrees/` directory keeps its Go covered.
const WORKTREE_ROOT = '.claude/worktrees'

export function isAgentWorktreePath(dirPath: string): boolean {
  const p = normalizePath(dirPath)
  return p === WORKTREE_ROOT || p.endsWith(`/${WORKTREE_ROOT}`)
}

/**
 * Every directory at or under `repoRoot` that owns a `go.mod`, skipping
 * vendored/build subtrees and agent worktrees. A `go.mod` nested under another
 * discovered module's directory is kept too — Go modules don't nest the way a
 * cargo workspace's members do, so there is no "outer already covers it" case
 * to de-nest. Returns absolute, normalized (`/`-separated), sorted paths.
 * Missing/unreadable directories are skipped, never thrown.
 */
export function findGoModuleDirs(repoRoot: string): string[] {
  const dirs: string[] = []
  const stack = [repoRoot]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    let hasGoMod = false
    for (let i = 0, { length } = entries; i < length; i += 1) {
      const name = entries[i]!
      if (name === 'go.mod') {
        hasGoMod = true
        continue
      }
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
      if (st.isDirectory() && !isAgentWorktreePath(abs)) {
        stack.push(abs)
      }
    }
    if (hasGoMod) {
      dirs.push(normalizePath(dir))
    }
  }
  return dirs.toSorted()
}
