#!/usr/bin/env node
/**
 * @file Assertion: a repo's OWN brand marks under `assets/` are canonically
 *   named `<repo>-<mark>[-<variant>].<ext>` — a wrong-repo prefix, an unknown
 *   mark, or a bad variant drifts the brand surface and breaks the
 *   README/asset-dirs references that resolve those exact names. The canonical
 *   grammar: <repo> the repo's own name (package.json name sans @scope, else
 *   the repo directory basename) <mark> combomark | favicon | logomark |
 *   wordmark <variant> light | dark (optional — the theme-split of an adaptive
 *   mark) <ext> svg | png e.g. `sockeye-combomark.svg` (adaptive),
 *   `sockeye-combomark-dark.svg`, `sockeye-logomark.png`,
 *   `sockeye-favicon.svg`. SCOPE: `assets/` is flat
 *   (scripts/repo/gen/asset-dirs.mts) and holds three populations — the repo's
 *   own marks, the shared Socket house kit every member receives by cascade
 *   (`socket-shield-*`, `socket-combomark-*`, …), and functional files
 *   (`coverage.svg`, `favicon-32.png`, `site.webmanifest`). Only the first is
 *   the repo's to name, so the gate policies exactly the files prefixed
 *   `<repo>-` and leaves the other two alone. A house mark is named by the
 *   wheelhouse generator, not by the member, so holding it to the member's own
 *   prefix would fail every repo in the fleet. CONDITIONAL: a repo with no
 *   `assets/` directory vacuous-passes, and so does one carrying only house
 *   marks. The gate bites the moment a repo's own mark lands. Strict: a
 *   non-canonical name exits 1 (no known-good exceptions — the brand grammar is
 *   exact).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { isMainModule } from '../_shared/is-main-module.mts'
import { runMain } from '../_shared/run-main.mts'
import { REPO_ROOT } from '../paths.mts'

import type { ScriptMeta } from '../_shared/run-main.mts'

const logger = getDefaultLogger()

// The canonical mark names, variants, and extensions. Sorted; a name outside
// these sets is non-canonical.
const MARKS: ReadonlySet<string> = new Set([
  'combomark',
  'favicon',
  'logomark',
  'wordmark',
])
const VARIANTS: ReadonlySet<string> = new Set(['dark', 'light'])
const EXTENSIONS: ReadonlySet<string> = new Set(['png', 'svg'])

export interface BrandNameIssue {
  readonly file: string
  readonly message: string
}

/**
 * The directory a repo's brand marks live in. Flat `assets/` — the layout
 * owner (scripts/repo/gen/asset-dirs.mts) writes every mark straight there,
 * so a nested `assets/repo/brand/` matches nothing in any fleet repo.
 */
export function brandDir(repoRoot: string): string {
  return path.join(repoRoot, 'assets')
}

/**
 * The repo's canonical name — the `package.json` `name` (sans `@scope/`) if
 * present, else the repo directory basename. Pure; exported for tests.
 */
export function resolveRepoName(repoRoot: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { name?: unknown | undefined }
    if (typeof pkg.name === 'string' && pkg.name.length > 0) {
      const slash = pkg.name.lastIndexOf('/')
      return slash >= 0 ? pkg.name.slice(slash + 1) : pkg.name
    }
  } catch {}
  return path.basename(repoRoot)
}

/**
 * The canonicity issue for one brand filename, or undefined when it matches
 * `<repoName>-<mark>[-<variant>].<ext>`. Pure; exported for tests.
 */
export function canonicalBrandIssue(
  filename: string,
  repoName: string,
): string | undefined {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) {
    return `no extension (expected .svg or .png)`
  }
  const ext = filename.slice(dot + 1)
  if (!EXTENSIONS.has(ext)) {
    return `extension '.${ext}' is not .svg or .png`
  }
  const stem = filename.slice(0, dot)
  const prefix = `${repoName}-`
  if (!stem.startsWith(prefix)) {
    return `must be prefixed '${prefix}' (the repo name)`
  }
  const parts = stem.slice(prefix.length).split('-')
  const mark = parts[0]!
  if (!MARKS.has(mark)) {
    return `unknown mark '${mark}' (expected combomark / favicon / logomark / wordmark)`
  }
  if (parts.length === 1) {
    return undefined
  }
  if (parts.length === 2) {
    return VARIANTS.has(parts[1]!)
      ? undefined
      : `unknown variant '${parts[1]}' (expected light / dark)`
  }
  return `too many name segments (expected <repo>-<mark>[-light|-dark].<ext>)`
}

/**
 * Scan a brand directory, returning the non-canonical files among the repo's
 * OWN marks. Files not prefixed `<repoName>-` are out of scope (the shared
 * Socket house kit and functional files — see the SCOPE note up top). Returns
 * [] when the directory is absent, the conditional vacuous pass. Pure;
 * exported for tests.
 */
export function scanBrandDir(dir: string, repoName: string): BrandNameIssue[] {
  let entries: string[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter(dirent => dirent.isFile())
      .map(dirent => dirent.name)
  } catch {
    return []
  }
  const issues: BrandNameIssue[] = []
  for (let i = 0, { length } = entries; i < length; i += 1) {
    const file = entries[i]!
    // .DS_Store and other dotfiles are not brand assets.
    if (file.startsWith('.')) {
      continue
    }
    // Only the repo's own marks are the repo's to name. The house kit and the
    // functional files sit in the same flat directory and belong to neither
    // this grammar nor this repo.
    if (!file.startsWith(`${repoName}-`)) {
      continue
    }
    const message = canonicalBrandIssue(file, repoName)
    if (message !== undefined) {
      issues.push({ file, message })
    }
  }
  issues.sort((a, b) => a.file.localeCompare(b.file))
  return issues
}

export function main(): void {
  const dir = brandDir(REPO_ROOT)
  if (!existsSync(dir)) {
    logger.log(
      'brand-assets-are-canonically-named: skipped (no assets/ — repo carries no brand marks).',
    )
    return
  }
  const repoName = resolveRepoName(REPO_ROOT)
  const issues = scanBrandDir(dir, repoName)
  if (issues.length === 0) {
    logger.log(
      `brand-assets-are-canonically-named: OK — every ${repoName}- mark matches ${repoName}-<mark>[-light|-dark].<svg|png>.`,
    )
    return
  }
  logger.warn(
    `brand-assets-are-canonically-named: ${issues.length} non-canonical brand file(s) under assets/:`,
  )
  for (const issue of issues) {
    logger.warn(`  ${issue.file} — ${issue.message}`)
  }
  logger.warn(
    'Rename to <repo>-<mark>[-light|-dark].<svg|png>, mark ∈ combomark|favicon|logomark|wordmark.',
  )
  process.exitCode = 1
}

const SCRIPT_META: ScriptMeta = {
  describe:
    "checks that a repo's own assets/ brand marks are canonically named",
  help: 'Usage: node scripts/fleet/check/brand-assets-are-canonically-named.mts',
}

/* c8 ignore start - entrypoint guard; exercised via subprocess */
if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
/* c8 ignore stop */
