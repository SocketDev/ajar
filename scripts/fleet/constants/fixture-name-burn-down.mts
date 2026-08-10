/*
 * @file The dated BURN-DOWN allowlist for
 *   `scripts/fleet/check/fixture-names-are-descriptive.mts`, loaded from the
 *   sibling `fixture-name-burn-down.json`.
 *
 *   The rule landed 2026-08-08: fixture names in test source are fake but
 *   descriptive (`example.js`, `/path/to/example`, `@example/module`), never
 *   single-letter placeholders (`x.js`, `/path/to/x`). The test corpus was not
 *   clean when the gate landed, so every file carrying the backlog is listed
 *   by PATH with the date it entered the burn-down.
 *
 *   THIS LIST ONLY EVER SHRINKS, AND IT SHRINKS TO EMPTY. An entry is a debt,
 *   not an exemption: once a file's placeholders are renamed, that file's line
 *   comes out of the JSON in the same commit. A listed file that scans clean
 *   is reported by the gate as a STALE entry so the line comes out. Once the
 *   last line is gone, this module, the JSON, and the import in the check all
 *   retire together.
 *
 *   Keys are repo-relative, forward-slash paths, sorted. Values are the ISO
 *   date the path entered the burn-down. The list is fleet-wide, so it carries
 *   both the wheelhouse's `template/base/...` authoring paths and the live
 *   paths a cascaded member sees; a key that names nothing in the current repo
 *   is inert and is never reported as stale.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

const BURN_DOWN_FILE = path.join(
  import.meta.dirname,
  'fixture-name-burn-down.json',
)

interface BurnDownFile {
  readonly files: Readonly<Record<string, string>>
}

function loadBurnDown(): Readonly<Record<string, string>> {
  try {
    const parsed = JSON.parse(
      readFileSync(BURN_DOWN_FILE, 'utf8'),
    ) as BurnDownFile
    return parsed.files ?? {}
  } catch {
    // A missing or malformed list must never turn the gate off silently. An
    // empty map means every file gates, which fails loud on the real backlog
    // instead of quietly passing it.
    return {}
  }
}

export const FIXTURE_NAME_BURN_DOWN: Readonly<Record<string, string>> =
  loadBurnDown()

/**
 * True when `relPath` is still owed a rename, so its placeholder findings are
 * suppressed. `relPath` must already be a forward-slash, repo-relative path.
 */
export function isBurnedDown(relPath: string): boolean {
  return Object.hasOwn(FIXTURE_NAME_BURN_DOWN, relPath)
}

/**
 * Every burn-down path, sorted. The gate prints the count so the remaining
 * debt is visible on a green run.
 */
export function burnDownPaths(): string[] {
  return Object.keys(FIXTURE_NAME_BURN_DOWN).toSorted()
}
