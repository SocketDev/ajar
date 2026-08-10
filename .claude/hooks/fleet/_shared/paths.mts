/**
 * @file Canonical filesystem paths shared by fleet hooks. Paths are built here
 *   once and consumed by runtime code and tests instead of being reconstructed
 *   at each call site.
 */

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FALLBACK_PROJECT_PATH = path.join(HERE, '..', '..', '..', '..')

const FLEET_ROSTER_RELATIVE_PATHS: readonly string[] = [
  'template/base/.claude/skills/fleet/cascading-fleet/lib/fleet-repos.json',
  '.claude/skills/fleet/cascading-fleet/lib/fleet-repos.json',
]

/**
 * The project path a hook should operate on. `preferred` (the hook payload's
 * `cwd`, when the caller has one) wins, then `CLAUDE_PROJECT_DIR`, then the
 * project path this hook tree is installed in. Empty strings fall through.
 *
 * `process.cwd()` is forbidden in `.claude/hooks/`
 * (socket/no-process-cwd-in-scripts-hooks) because the agent runner may invoke
 * a hook from any directory. The bundled copy sits at the same depth as the
 * source, so the fixed walk holds for both.
 */
export function resolveProjectPath(preferred?: string | undefined): string {
  return preferred || process.env['CLAUDE_PROJECT_DIR'] || FALLBACK_PROJECT_PATH
}

export function fleetRosterPaths(repoRoot: string): readonly string[] {
  return FLEET_ROSTER_RELATIVE_PATHS.map(relativePath =>
    path.join(repoRoot, relativePath),
  )
}

/**
 * `<repoRoot>/changelog.d` — the news-fragment directory, where a repo keeps
 * one file per change instead of editing CHANGELOG.md directly. Returns the
 * path whether or not it exists: the fleet does not require the convention,
 * so callers decide what an absent directory means.
 */
export function changelogFragmentsPath(repoRoot: string): string {
  return path.join(repoRoot, 'changelog.d')
}
