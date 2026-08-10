#!/usr/bin/env node
// Claude Code SessionStart hook — account-snapshot-recorder.
//
// Records WHICH signed-in account a session belongs to, because spend cannot be
// attributed to an account after the fact.
//
// The constraint that forces this to exist: session transcripts carry no account
// field. Verified by key-listing real transcripts — they hold `sessionId`,
// `requestId`, `cwd`, `userType`, and no account, org, or email anywhere. So the
// only record of who was signed in is the one taken WHILE they were signed in.
// Every day this does not run is a day whose spend can never be attributed.
//
// Why attribution matters at all: two accounts can bill completely differently
// for identical token usage. A metered or overage-enabled seat spends real
// dollars per token; a flat-quota seat spends subscription headroom. Mixing them
// corrupts both figures. Four distinct organization UUIDs already appear in this
// machine's local caches, so this is not hypothetical.
//
// PRIVACY: the record stores a short DIGEST of the organization UUID, never the
// UUID, the email, or the organization name. Attribution survives without the
// identity travelling with it, so the ledger stays safe to read and to share.
//
// Pure-observational: never blocks, never fails a session, writes only into the
// gitignored cache store.

import crypto from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { defineHook, notify, runHook } from '../_shared/guard.mts'
import { resolveRepoRoot } from '../_shared/repo-root.mts'

const STORE_NAME = 'socket-model-cost'

// Deliberately NOT imported from scripts/fleet/_shared/claude-usage.mts, which
// owns the same digest for the script side. A hook is dep-0 and bundled, so it
// does not reach across into the scripts tree; fifteen duplicated lines is the
// price of that boundary. The two must agree, so the shape is fixed in both:
// sha256 of the uuid, first 12 hex characters.
export function accountFingerprint(uuid: string): string {
  return crypto.createHash('sha256').update(uuid).digest('hex').slice(0, 12)
}

export interface AccountSnapshot {
  accountId: string
  billingType: string | undefined
  seatTier: string | undefined
}

export function globalConfigPath(): string {
  return path.join(os.homedir(), '.claude.json')
}

/**
 * The signed-in account, digested. Organization-scoped because that is the
 * granularity billing differs at — the client caches credit grants and seat
 * eligibility per organization UUID, not per user. Falls back to the account
 * UUID only when no organization is present.
 */
export function readAccountSnapshot(
  configPath: string,
): AccountSnapshot | undefined {
  if (!existsSync(configPath)) {
    return undefined
  }
  let account: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    account = parsed['oauthAccount'] as Record<string, unknown> | undefined
  } catch {
    return undefined
  }
  if (!account) {
    return undefined
  }
  const org = account['organizationUuid']
  const self = account['accountUuid']
  const source =
    typeof org === 'string' && org
      ? org
      : typeof self === 'string' && self
        ? self
        : ''
  if (!source) {
    return undefined
  }
  return {
    accountId: accountFingerprint(source),
    billingType:
      typeof account['billingType'] === 'string'
        ? account['billingType']
        : undefined,
    seatTier:
      typeof account['seatTier'] === 'string' ? account['seatTier'] : undefined,
  }
}

export function storeDir(projectDir: string | undefined): string {
  const root = projectDir ? resolveRepoRoot(projectDir) : os.tmpdir()
  return path.join(root, '.cache', 'fleet', STORE_NAME, 'accounts')
}

export function latestPath(dir: string): string {
  return path.join(dir, 'latest.json')
}

export function readLatest(dir: string): AccountSnapshot | undefined {
  const file = latestPath(dir)
  if (!existsSync(file)) {
    return undefined
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AccountSnapshot
  } catch {
    return undefined
  }
}

/**
 * Append this session's snapshot and refresh the pointer to the current one.
 * Swallows every I/O error: a recorder that breaks a session costs more than
 * the attribution is worth.
 */
export function writeSnapshot(
  dir: string,
  sessionId: string,
  snapshot: AccountSnapshot,
  nowIso: string,
): void {
  try {
    mkdirSync(dir, { recursive: true })
    const safeSession = sessionId.replace(/[^A-Za-z0-9_-]/g, '') || 'unknown'
    const record = { ...snapshot, recordedAt: nowIso, sessionId: safeSession }
    const body = `${JSON.stringify(record, undefined, 2)}\n`
    writeFileSync(path.join(dir, `${safeSession}.json`), body)
    writeFileSync(latestPath(dir), body)
  } catch {}
}

/**
 * The message shown when the seat CHANGED since the last recorded session.
 * Undefined on a first run or an unchanged seat — a recorder that narrated
 * every session would be noise, and the change is the only part a reader must
 * act on.
 */
export function changeNotice(
  previous: AccountSnapshot | undefined,
  next: AccountSnapshot,
): string | undefined {
  if (!previous || previous.accountId === next.accountId) {
    return undefined
  }
  const from = previous.seatTier ?? 'unknown seat'
  const to = next.seatTier ?? 'unknown seat'
  return (
    `signed-in account changed since the last session (${from} to ${to}). ` +
    'Spend from here is attributed to the new account. A figure spanning the ' +
    'switch mixes two billing models, so read it per account, never as one total.'
  )
}

export interface SessionStartPayload {
  cwd?: string | undefined
  session_id?: string | undefined
}

export function check(
  payload: SessionStartPayload,
): ReturnType<typeof notify> | undefined {
  const snapshot = readAccountSnapshot(globalConfigPath())
  if (!snapshot) {
    return undefined
  }
  const dir = storeDir(payload.cwd ?? process.env['CLAUDE_PROJECT_DIR'])
  const previous = readLatest(dir)
  writeSnapshot(
    dir,
    payload.session_id ?? 'unknown',
    snapshot,
    new Date().toISOString(),
  )
  const notice = changeNotice(previous, snapshot)
  return notice ? notify(`[account-snapshot] ${notice}`) : undefined
}

export const hook = defineHook({
  check,
  event: 'SessionStart',
  type: 'nudge',
})

void runHook(hook, import.meta.url)
