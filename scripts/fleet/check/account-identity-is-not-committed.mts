#!/usr/bin/env node
/**
 * @file Fleet check - no account identity is committed, in any form. The spend
 *   work attributes cost per signed-in account, and to do that it handles two
 *   things that must never reach git: the raw organization or account UUID, and
 *   the short digest derived from it. The digest is NOT a safe stand-in. It is
 *   a stable identifier for one organization, so a copy pasted into a test
 *   fixture, a doc example, or a debug constant turns a private org into a
 *   committed one, which is what `public-surface-hygiene` forbids. How it
 *   checks without ever holding the secret: it derives the candidate values
 *   from THIS machine's local client profile at runtime, then scans only
 *   git-TRACKED files for them. Nothing is written down, and the values live in
 *   memory for the length of one run. CRITICAL - the failure message never
 *   prints what it found. A check that echoed the digest would leak it into CI
 *   logs, a terminal scrollback, and a session transcript, which is the same
 *   exposure it exists to prevent. It reports the file, the line, and the CLASS
 *   of value only. A machine with no client profile has nothing to derive, so
 *   it SKIPS loudly rather than passing vacuously. Usage: node
 *   scripts/fleet/check/account-identity-is-not-committed.mts [--json]
 *   [--quiet].
 */

import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { REPO_ROOT } from '../paths.mts'
import { collectTrackedFiles } from '../_shared/tracked-globs.mts'
import { isMainModule } from '../_shared/is-main-module.mts'
import { isJsonRequested, runMain } from '../_shared/run-main.mts'

import type { ScriptMeta } from '../_shared/run-main.mts'

const logger = getDefaultLogger()

// Keep in step with the recorder hook and the usage library, which derive the
// same digest. All three must agree or a leak slips past one of them.
export const DIGEST_LENGTH = 12

/**
 * Client-profile keys whose OBJECT KEYS are organization UUIDs. The client
 * caches per-organization state under them, so together they enumerate every
 * org this machine has touched, not merely the one signed in now.
 */
export const ORG_KEYED_CACHES: readonly string[] = [
  'fableOverageConsentV2',
  'overageCreditGrantCache',
  'passesEligibilityCache',
  's1mAccessCache',
  's1mNonSubscriberAccessCache',
]

// Binary and generated shapes carry no hand-written identity and cost the most
// to read, so they are skipped.
export const SKIP_EXTENSIONS: ReadonlySet<string> = new Set([
  '.br',
  '.gz',
  '.ico',
  '.jpg',
  '.lock',
  '.mp4',
  '.pdf',
  '.png',
  '.profdata',
  '.svg',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
])

export function digestOf(uuid: string): string {
  return crypto
    .createHash('sha256')
    .update(uuid)
    .digest('hex')
    .slice(0, DIGEST_LENGTH)
}

export function clientProfilePath(): string {
  return path.join(os.homedir(), '.claude.json')
}

/**
 * Every organization or account UUID this machine knows about. Empty when no
 * profile exists, which the caller reports as a skip rather than a pass.
 */
export function collectLocalUuids(profilePath: string): Set<string> {
  const found = new Set<string>()
  if (!existsSync(profilePath)) {
    return found
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(profilePath, 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return found
  }
  const account = parsed['oauthAccount'] as Record<string, unknown> | undefined
  for (const key of ['accountUuid', 'organizationUuid']) {
    const value = account?.[key]
    if (typeof value === 'string' && value) {
      found.add(value)
    }
  }
  for (let i = 0, { length } = ORG_KEYED_CACHES; i < length; i += 1) {
    const cacheKey = ORG_KEYED_CACHES[i]!
    const cache = parsed[cacheKey]
    if (cache && typeof cache === 'object') {
      const uuids = Object.keys(cache)
      for (let j = 0, uuidCount = uuids.length; j < uuidCount; j += 1) {
        const uuid = uuids[j]!
        if (uuid) {
          found.add(uuid)
        }
      }
    }
  }
  return found
}

export interface IdentityHit {
  file: string
  kind: 'digest' | 'uuid'
  line: number
}

/**
 * Scan one file's text for any needle. Returns hits WITHOUT the matched value,
 * so a caller cannot print it even by accident.
 */
export function scanText(
  text: string,
  file: string,
  needles: ReadonlyMap<string, IdentityHit['kind']>,
): IdentityHit[] {
  const hits: IdentityHit[] = []
  // Normalizing split: a CRLF file otherwise leaves a trailing \r on every line.
  const lines = text.replace(/\r\n/g, '\n').split(/\r?\n/)
  for (let i = 0, { length } = lines; i < length; i += 1) {
    const line = lines[i] as string
    for (const [needle, kind] of needles) {
      if (line.includes(needle)) {
        hits.push({ file, kind, line: i + 1 })
      }
    }
  }
  return hits
}

export interface ScanResult {
  filesScanned: number
  hits: IdentityHit[]
  skipped?: 'no-profile' | undefined
  uuidsKnown: number
}

export async function scanRepo(
  repoRoot: string,
  uuids: ReadonlySet<string>,
): Promise<ScanResult> {
  if (uuids.size === 0) {
    return { filesScanned: 0, hits: [], skipped: 'no-profile', uuidsKnown: 0 }
  }
  const needles = new Map<string, IdentityHit['kind']>()
  for (const uuid of uuids) {
    needles.set(uuid, 'uuid')
    needles.set(digestOf(uuid), 'digest')
  }
  const tracked = await collectTrackedFiles(['**/*'], {
    cwd: repoRoot,
    dot: true,
  })
  const hits: IdentityHit[] = []
  let filesScanned = 0
  for (
    let i = 0, { length } = tracked.length ? tracked : [];
    i < length;
    i += 1
  ) {
    const relative = tracked[i] as string
    if (SKIP_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
      continue
    }
    let text: string
    try {
      text = readFileSync(path.join(repoRoot, relative), 'utf8')
    } catch {
      continue
    }
    filesScanned += 1
    hits.push(...scanText(text, relative, needles))
  }
  return { filesScanned, hits, uuidsKnown: uuids.size }
}

/**
 * The failure text. Names the location and the CLASS only - never the value,
 * because printing it would leak it into every log that captures this run.
 */
export function renderReport(result: ScanResult): string {
  const lines: string[] = [
    'What:   a committed file carries an account identity.',
    'Where:  the tracked paths below.',
  ]
  for (const hit of result.hits) {
    lines.push(
      `        ${hit.file}:${hit.line} - a ${hit.kind} for a local org`,
    )
  }
  lines.push(
    'Saw:    the value is deliberately NOT printed. Echoing it would put it in',
    '        CI logs and this transcript, the exposure this check exists to',
    '        stop. Open the file and line to see it.',
    'Wanted: zero. A digest is not a safe stand-in for a UUID - it is a stable',
    '        identifier for one organization, so committing it makes a private',
    '        org a committed one.',
    'Fix:    delete the value. Runtime records belong in the gitignored cache',
    '        store; a fixture needs a synthetic value, never a real one.',
  )
  return lines.join('\n')
}

export interface ReportOptions {
  json?: boolean | undefined
  quiet?: boolean | undefined
}

export function report(
  result: ScanResult,
  options?: ReportOptions | undefined,
): void {
  const opts = { __proto__: null, ...options } as ReportOptions
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`)
    return
  }
  if (result.skipped === 'no-profile') {
    logger.log(
      '[account-identity-is-not-committed] SKIPPED: no local client profile, so no identity could be derived. This is not a pass.',
    )
    return
  }
  if (result.hits.length) {
    logger.fail(
      '[account-identity-is-not-committed] a committed file carries an account identity.',
    )
    logger.error(renderReport(result))
    return
  }
  if (!opts.quiet) {
    logger.success(
      `[account-identity-is-not-committed] none of ${result.uuidsKnown} local org identit(ies) appear in ${result.filesScanned} tracked file(s).`,
    )
  }
}

export async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const result = await scanRepo(
    REPO_ROOT,
    collectLocalUuids(clientProfilePath()),
  )
  report(result, {
    json: isJsonRequested(argv),
    quiet: argv.includes('--quiet'),
  })
  return result.hits.length ? 1 : 0
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'checks no tracked file carries an account or organization identity, raw or digested',
  help: `Usage: node scripts/fleet/check/account-identity-is-not-committed.mts [flags]

  --json   emit the measurement as JSON instead of prose
  --quiet  suppress the pass message

Derives the values from this machine's client profile at runtime and never
writes or prints them. A failure names the file, the line, and the class of
value only.`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
