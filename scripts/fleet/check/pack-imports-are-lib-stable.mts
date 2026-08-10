#!/usr/bin/env node
/**
 * @file `check --all` gate: every pack script (`scripts/fleet/**\/*.mts`)
 *   imports the Socket lib ONLY through its `-stable` alias
 *   (`@socketsecurity/lib-stable/…`), never the bare `@socketsecurity/lib/…`.
 *   The pack cascades into every fleet member — including socket-lib itself,
 *   where the bare specifier self-resolves to the repo's OWN unbuilt `dist/`
 *   and the Check job dies with `ERR_MODULE_NOT_FOUND` (live incident:
 *   `external-tools/_shared.mts` importing `lib/json/edit`). Every real
 *   subpath ships an exact `lib-stable` twin, so the fix is always the same
 *   one-token rename. Only IMPORT specifiers are matched — the `from '<spec>'`
 *   clause of a static import/export and the dynamic `import('<spec>')` form —
 *   so a doc comment or message string naming the bare package never trips.
 *   Skips itself: its own matcher fixtures would otherwise self-match. Usage:
 *   node scripts/fleet/check/pack-imports-are-lib-stable.mts [--quiet]
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { normalizePath } from '@socketsecurity/lib-stable/paths/normalize'

import { REPO_ROOT } from '../paths.mts'
import { isMainModule } from '../_shared/is-main-module.mts'
import { runMain } from '../_shared/run-main.mts'
import { listMtsFiles } from './static-imports-are-declared.mts'

import type { ScriptMeta } from '../_shared/run-main.mts'

const logger = getDefaultLogger()

// The one tree the release pack delivers to members, relative to REPO_ROOT. In
// the wheelhouse this is the live mirror of template/base/scripts/fleet — the
// same bytes — so scanning the live tree covers the template source too.
export const SCANNED_TREE = path.join('scripts', 'fleet')

// This check's own repo-relative path (posix form). Its matcher fixtures and
// diagnostics spell the bare specifier inside import shapes, so it skips
// itself rather than self-matching.
export const SELF_PATH = 'scripts/fleet/check/pack-imports-are-lib-stable.mts'

// The `from '<spec>'` tail of a static import/export whose specifier opens the
// bare lib package. Requiring the `from` keyword (or the dynamic form below)
// keeps a doc comment or message string that merely NAMES the package inert.
// oxlint-disable-next-line socket/require-regex-comment -- described above
const FROM_SPECIFIER_RE = /\bfrom\s*['"](@socketsecurity\/lib\/[^'"]+)['"]/

// The dynamic `import('<spec>')` form of the same bare-package specifier.
// oxlint-disable-next-line socket/require-regex-comment -- described above
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"](@socketsecurity\/lib\/[^'"]+)['"]/

export interface BareLibImport {
  readonly file: string
  readonly line: number
  readonly specifier: string
  readonly stableTwin: string
}

/**
 * The `@socketsecurity/lib-stable/…` twin of a bare `@socketsecurity/lib/…`
 * specifier — same subpath, aliased package. Every subpath the pack imports
 * ships an exact twin, so the rename is always sufficient.
 */
export function stableTwinForSpecifier(specifier: string): string {
  return specifier.replace(
    '@socketsecurity/lib/',
    '@socketsecurity/lib-stable/',
  )
}

/**
 * Diagnose every file in `files` (relative path → content) whose import
 * specifiers open the bare `@socketsecurity/lib/` package. Pure — the check's
 * whole finding logic, independent of file-system layout, so unit tests drive
 * it with in-memory fixtures. Matches per line, so each finding carries its
 * 1-based line number; `SELF_PATH` is skipped (see its comment).
 */
export function findBareLibImports(
  files: ReadonlyMap<string, string>,
): BareLibImport[] {
  const findings: BareLibImport[] = []
  for (const [file, content] of files) {
    if (normalizePath(file) === SELF_PATH) {
      continue
    }
    const lines = content.split(/\r?\n/)
    for (let i = 0, { length } = lines; i < length; i += 1) {
      const text = lines[i]!
      const match = FROM_SPECIFIER_RE.exec(text) ?? DYNAMIC_IMPORT_RE.exec(text)
      if (!match) {
        continue
      }
      const specifier = match[1]!
      findings.push({
        file,
        line: i + 1,
        specifier,
        stableTwin: stableTwinForSpecifier(specifier),
      })
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return findings
}

/**
 * Read every `.mts` file under `repoRoot`'s pack tree into a relative-path →
 * content map. A missing tree (a member mid-hydration) is a no-op; unreadable
 * files are skipped, never fatal.
 */
export function readPackScriptFiles(repoRoot: string): Map<string, string> {
  const files = new Map<string, string>()
  const mtsFiles = listMtsFiles(path.join(repoRoot, SCANNED_TREE))
  for (let i = 0, { length } = mtsFiles; i < length; i += 1) {
    const file = mtsFiles[i]!
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    files.set(path.relative(repoRoot, file), content)
  }
  return files
}

export function main(): void {
  const quiet = process.argv.includes('--quiet')
  const findings = findBareLibImports(readPackScriptFiles(REPO_ROOT))

  if (findings.length > 0) {
    logger.fail(
      '[pack-imports-are-lib-stable] a pack script imports the bare @socketsecurity/lib package.',
    )
    logger.error('')
    logger.error(
      '  What:   scripts/fleet/ cascades into every member — including socket-lib,',
    )
    logger.error(
      "          where a bare '@socketsecurity/lib/…' specifier self-resolves to the",
    )
    logger.error(
      "          repo's own unbuilt dist/ and dies with ERR_MODULE_NOT_FOUND.",
    )
    logger.error('')
    for (let i = 0, { length } = findings; i < length; i += 1) {
      const f = findings[i]!
      logger.error(`  Where:  ${f.file}:${f.line}`)
      logger.error(`  Saw:    import '${f.specifier}'`)
      logger.error(`  Fix:    import '${f.stableTwin}' — the exact twin`)
      logger.error('')
    }
    process.exitCode = 1
    return
  }

  if (!quiet) {
    logger.success(
      '[pack-imports-are-lib-stable] every pack-script lib import goes through @socketsecurity/lib-stable.',
    )
  }
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'verifies every pack script imports the Socket lib via its -stable alias',
  help: `Usage: node scripts/fleet/check/pack-imports-are-lib-stable.mts [flags]

  --quiet  suppress the success message`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
