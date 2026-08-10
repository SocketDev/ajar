#!/usr/bin/env node
/*
 * @file `check --all` gate: fixture names in test source are fake but
 *   DESCRIPTIVE. A quoted fixture path names its role — `example.js`,
 *   `helpers/example.js`, `/path/to/example`, `@example/module` — never a
 *   single-letter placeholder like `x.js`, `./a.js`, or `/path/to/x`.
 *
 *   Why. A single-letter name carries no meaning at the call site, collides
 *   silently when a second fixture joins it (`a.js`/`b.js` renames overwrite
 *   each other), and greps for nothing. The `@example` npm scope is the
 *   sanctioned fake module scope: it is empty on npm (verified 2026-08-08),
 *   so a fake module name under it can never collide with a real dependency.
 *
 *   The detector lives in `scripts/fleet/_shared/fixture-names.mts`. This
 *   file owns the walk (tracked test files), the burn-down bookkeeping, and
 *   the verdict. There is deliberately NO `--fix`: renames can collide
 *   (`a.js` and `b.js` in one fixture map both want `example.js`), so the
 *   rename is a judgment call, not a mechanical rewrite.
 *
 *   Burn-down. The test corpus was not clean when the rule landed, so the
 *   files still carrying the backlog are listed by path in
 *   `scripts/fleet/constants/fixture-name-burn-down.json` with the date each
 *   entered. That list only ever shrinks, and it shrinks to empty. A file NOT
 *   listed gates normally, so nothing new can land while the backlog burns
 *   down. A listed file that scans clean is reported as a stale entry to drop.
 *
 *   Escape hatch, for a test whose SUBJECT is single-character names:
 *   `fixture-name: allow` on the line, `fixture-name: allow-file` anywhere in
 *   the file.
 *
 *   Scope: tracked test source (`*.test.*` and files under a test dir), minus
 *   `fixtures/` payload dirs — a fixture FILE's on-disk name is its content,
 *   not a reference.
 *
 *   Usage: node scripts/fleet/check/fixture-names-are-descriptive.mts
 *   [paths...] [--quiet]
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { normalizePath } from '@socketsecurity/lib-stable/paths/normalize'
// oxlint-disable-next-line socket/prefer-async-spawn -- sync check
import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'

import { REPO_ROOT } from '../paths.mts'
import {
  burnDownPaths,
  isBurnedDown,
} from '../constants/fixture-name-burn-down.mts'
import {
  FIXTURE_NAME_ALLOW_LINE,
  FIXTURE_NAME_FIX,
  scanFixtureNames,
} from '../_shared/fixture-names.mts'
import { isMainModule } from '../_shared/is-main-module.mts'
import { runMain } from '../_shared/run-main.mts'
import type { ScriptMeta } from '../_shared/run-main.mts'

const logger = getDefaultLogger()

// Test-source extensions the scan reads.
const TEST_SOURCE_EXT_RE = /\.(?:[jt]sx|c?[jt]s|m[jt]s)$/

/**
 * Tracked test-source files: `*.test.*` anywhere, or any source file under a
 * `test`/`tests`/`__tests__` dir. `fixtures/` payload dirs stay out — an
 * on-disk fixture file's name is its content, not a reference to rename.
 */
export function collectTestFiles(repoRoot: string): string[] {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
    stdio: 'pipe',
  })
  if (result.status !== 0) {
    return []
  }
  const { stdout } = result
  const listed = typeof stdout === 'string' ? stdout : String(stdout)
  const relPaths = listed.split('\0')
  const files: string[] = []
  for (let i = 0, { length } = relPaths; i < length; i += 1) {
    const raw = relPaths[i]!
    if (!raw || !TEST_SOURCE_EXT_RE.test(raw)) {
      continue
    }
    const normalized = normalizePath(raw)
    if (
      normalized.includes('/fixtures/') ||
      normalized.startsWith('fixtures/')
    ) {
      continue
    }
    const isTestFile =
      normalized.includes('.test.') ||
      // Matches a test directory segment at the start or after a slash.
      // (?:^|\/) — segment boundary on the left
      // (?:__tests__|tests?) — the known test dir names
      // \/ — the segment must be a directory, not a file
      /(?:^|\/)(?:__tests__|tests?)\//.test(normalized)
    if (isTestFile) {
      files.push(normalized)
    }
  }
  return files
}

export interface FixtureNameScanResult {
  // Report lines, already rendered, for every gating finding.
  readonly report: string[]
  // Burn-down paths that scanned clean, so their entry is owed a removal.
  readonly stale: string[]
  // How many findings the burn-down list suppressed.
  readonly suppressed: number
}

/**
 * Scan `files` for single-letter fixture placeholders, splitting gating
 * findings from the ones the burn-down list still owes, and flagging
 * burn-down entries that came back clean.
 */
export function scanFilesForFixtureNames(
  repoRoot: string,
  files: readonly string[],
): FixtureNameScanResult {
  const report: string[] = []
  const clean = new Set(burnDownPaths())
  let suppressed = 0
  for (let i = 0, { length } = files; i < length; i += 1) {
    const rel = files[i]!
    let content: string
    try {
      content = readFileSync(path.join(repoRoot, rel), 'utf8')
    } catch {
      continue
    }
    const findings = scanFixtureNames(content)
    if (!findings.length) {
      continue
    }
    if (isBurnedDown(rel)) {
      clean.delete(rel)
      suppressed += findings.length
      continue
    }
    for (let j = 0, { length: flen } = findings; j < flen; j += 1) {
      const f = findings[j]!
      report.push(
        `  ${rel}:${f.line} — "${f.span}" names a fixture "${f.segment}"`,
      )
    }
  }
  // A burn-down path the scan never reached (retired, renamed, or out of the
  // scoped subset) stays owed, so only files that were READ can go stale.
  const scanned = new Set(files)
  return {
    report,
    stale: [...clean].filter(rel => scanned.has(rel)).toSorted(),
    suppressed,
  }
}

function reportStale(stale: readonly string[]): void {
  if (!stale.length) {
    return
  }
  logger.warn(
    `[fixture-names-are-descriptive] ${stale.length} burn-down entr(ies) now scan clean. Drop them from scripts/fleet/constants/fixture-name-burn-down.json:`,
  )
  for (let i = 0, { length } = stale; i < length; i += 1) {
    logger.warn(`  ${stale[i]!}`)
  }
}

function reportFindings(report: readonly string[]): void {
  logger.fail(
    '[fixture-names-are-descriptive] test fixtures use single-letter placeholder names:',
  )
  for (let i = 0, { length } = report; i < length; i += 1) {
    logger.error(report[i]!)
  }
  logger.error(`  For each: ${FIXTURE_NAME_FIX}.`)
  logger.error(
    `  Keep an intentional single-letter name with '${FIXTURE_NAME_ALLOW_LINE}'.`,
  )
}

export function main(): number {
  // Non-flag args scope the scan to explicit paths; otherwise the whole
  // tracked test tree gates.
  const paths = process.argv.slice(2).filter(a => !a.startsWith('-'))
  const scope = paths.length
    ? paths.map(p => normalizePath(p)).toSorted()
    : collectTestFiles(REPO_ROOT)
  const result = scanFilesForFixtureNames(REPO_ROOT, scope)
  reportStale(result.stale)
  if (result.report.length) {
    reportFindings(result.report)
    process.exitCode = 1
    return 1
  }
  if (!process.argv.includes('--quiet')) {
    const owed = burnDownPaths().length
    logger.success(
      owed
        ? `[fixture-names-are-descriptive] fixture names are descriptive outside the burn-down list (${owed} file(s), ${result.suppressed} placeholder(s) still owed).`
        : '[fixture-names-are-descriptive] fixture names are descriptive.',
    )
  }
  return 0
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'check that test fixture names are descriptive, never single-letter placeholders',
  help: `Usage: node scripts/fleet/check/fixture-names-are-descriptive.mts [paths...] [flags]
  [paths...]   scope the scan to these files (default: the tracked test tree)
  --quiet      suppress the success line`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
