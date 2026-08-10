#!/usr/bin/env node
/*
 * @file Claude Code Stop hook - spend-warning-nudge.
 *
 * Warns once at every `warnEveryPct` crossing of the monthly TARGET tier, so a
 * session that is quietly eating the budget says so while it is still running
 * rather than at the end of the month.
 *
 * Everything about measurement, dedup, costing, and the gauge is owned by
 * `scripts/fleet/_shared/claude-usage.mts`, and nothing here restates it. This
 * hook contributes exactly three things the library deliberately leaves to a
 * caller, plus one policy decision:
 *
 *   1. INCREMENTAL READS. A transcript is append-only and reaches hundreds of
 *      megabytes, so re-reading it every turn is the cost this hook exists to
 *      avoid. The ledger stores a BYTE offset per session and each run reads
 *      only the bytes added since the last one. The delta is cut at its last
 *      newline, so a half-written final line waits for the next turn instead of
 *      being parsed broken and skipped forever, and the offset advances by the
 *      bytes actually consumed. A per-run ceiling bounds the work when the
 *      backlog is large (a resumed session, or a first run against a transcript
 *      that already exists): the rest is picked up on following turns.
 *   2. A RUNNING TOTAL THAT SURVIVES THE TURN. The delta is costed and added to
 *      the stored figure, so the ledger holds the whole session's spend while
 *      each run only parses the new bytes. Dedup keys carry over too: a
 *      compaction copy or a resumed sidechain can append a record already
 *      counted, and a fresh key set per run would count it twice.
 *   3. WARN ONCE PER CROSSING. The bucket the library computes is compared with
 *      the one already announced, and only an INCREASE speaks. A crossing that
 *      re-warned every turn would train the reader to ignore it, which costs
 *      more than staying quiet.
 *
 * The policy decision is what it prints: PERCENTAGES AND TIER NAMES, never a
 * dollar figure, unless the budget's `privacy.printAbsoluteFigures` opts in.
 * Hook output lands in the session transcript, which is exactly the corpus the
 * spend scanner reads, so a nudge that printed the bar would write the budget
 * into thousands of files. `renderSpendMeter` defaults to the same rule, so the
 * privacy choice is made in one place.
 *
 * NO BUDGET FILE MEANS SILENCE. With no machine-local budget there is no bar,
 * and inventing one would report a crossing of a ceiling nobody agreed to.
 *
 * A NUDGE, so it never blocks and never fails a turn: every error path returns
 * `undefined` and exits 0. A missing transcript, an unreadable ledger, a
 * malformed budget, and a mid-scan throw all read the same way, because a
 * measurement that can break a session is worse than no measurement.
 *
 * Fast traffic is priced at the documented list premium, the top of
 * `FAST_MODE_MULTIPLIER_RANGE`, which warns EARLIER than the cash-implied floor
 * would. That is the safe direction for a budget warning. No calibration factor
 * is applied: it is a figure derived from a private invoice, and this file
 * carries no such number.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { safeDeleteSync } from '@socketsecurity/lib-stable/fs/safe'

import pricingJson from '../../../../scripts/fleet/constants/model-pricing.json' with { type: 'json' }
import {
  budgetBucket,
  costScan,
  emptyDedupDiagnostics,
  emptyTotals,
  readBudgetConfig,
  renderSpendMeter,
  scanTranscript,
  tierFor,
} from '../../../../scripts/fleet/_shared/claude-usage.mts'
import { defineHook, notify, runHook } from '../_shared/guard.mts'
import { resolveRepoRoot } from '../_shared/repo-root.mts'
import { verdictContinuation, verdictLine } from '../_shared/verdict.mts'

import type {
  BudgetConfig,
  CacheMultipliers,
  ModelRate,
  UsageScan,
} from '../../../../scripts/fleet/_shared/claude-usage.mts'
import type { GuardResult } from '../_shared/guard.mts'
import type { ToolCallPayload } from '../_shared/payload.mts'

const HOOK_NAME = 'spend-warning-nudge'

// The shared model-cost store, the same one account-snapshot-recorder writes
// its seat snapshots into. One store per checkout, never inside the tracked
// tree.
export const STORE_NAME = 'socket-model-cost'

// Most bytes one run will parse. A live session appends kilobytes per turn, so
// this only binds when the ledger starts behind: a resumed session, or a first
// run against a transcript that already exists. The remainder is read on the
// following turns, so the offset still converges on the end of the file.
export const MAX_DELTA_BYTES = 16 * 1024 * 1024

// How many dedup keys the ledger carries forward. A billed request already
// counted must stay recognizable when a later append repeats it, and the newest
// keys are the ones a repeat can plausibly name. Bounded so a long session's
// ledger cannot grow without limit.
export const SEEN_KEY_CAP = 4000

/**
 * The Stop payload this hook reads. `session_id` names the ledger; the
 * transcript path is both the source of usage records and the fallback name.
 */
export interface SpendStopPayload extends ToolCallPayload {
  readonly hook_event_name?: string | undefined
  readonly session_id?: string | undefined
}

/**
 * One session's spend ledger. `bytesRead` is the resume point, `spentUsd` the
 * running total the bucket is computed from, and `lastWarnedBucket` the
 * warn-once record.
 */
export interface SpendLedger {
  bytesRead: number
  lastWarnedBucket: number
  requests: number
  seenKeys: string[]
  spentUsd: number
  unpricedRequests: number
  updatedAt: number
}

/**
 * The delta a run consumed: the bytes to parse, and the offset to resume from.
 * `nextOffset` counts only COMPLETE lines, so a partial final line is left for
 * the next run.
 */
export interface TranscriptDelta {
  bytes: Buffer
  nextOffset: number
}

export function emptySpendLedger(): SpendLedger {
  return {
    bytesRead: 0,
    lastWarnedBucket: 0,
    requests: 0,
    seenKeys: [],
    spentUsd: 0,
    unpricedRequests: 0,
    updatedAt: 0,
  }
}

// Characters a session id may contribute to a filename. A session id is a UUID
// in practice; this keeps a surprising value from escaping the store dir.
// Regex parts: `[^A-Za-z0-9_-]` any character outside the safe set, `g` every
// occurrence.
const SESSION_ID_UNSAFE_RE = /[^A-Za-z0-9_-]/g

/**
 * The session id a transcript path names: its basename without `.jsonl`.
 * Returns '' for anything that is not a transcript.
 */
export function transcriptSessionId(
  transcriptPath: string | undefined,
): string {
  if (!transcriptPath || !transcriptPath.endsWith('.jsonl')) {
    return ''
  }
  return path.basename(transcriptPath, '.jsonl')
}

/**
 * The filename-safe ledger key for a session. The payload's own `session_id`
 * wins; the transcript basename is the fallback, since both name the same
 * session.
 */
export function spendSessionKey(payload: SpendStopPayload): string | undefined {
  const raw =
    typeof payload.session_id === 'string' && payload.session_id
      ? payload.session_id
      : transcriptSessionId(payload.transcript_path)
  if (!raw) {
    return undefined
  }
  return raw.replace(SESSION_ID_UNSAFE_RE, '') || undefined
}

/**
 * The store directory for spend ledgers. Anchored on the git toplevel so every
 * caller lands on ONE store per checkout rather than a `.cache/` per working
 * directory, including one inside `template/base/`, the cascade payload (see
 * `_shared/repo-root.mts`). Falls back to the OS temp dir with no project dir.
 */
export function resolveSpendStoreDir(projectDir: string | undefined): string {
  const root = projectDir ? resolveRepoRoot(projectDir) : os.tmpdir()
  return path.join(root, '.cache', 'fleet', STORE_NAME, 'spend')
}

export function spendLedgerPath(storeDir: string, session: string): string {
  return path.join(storeDir, `${session}.json`)
}

/**
 * Where the delta bytes are staged so the canonical transcript parser can read
 * them. Named per session, so two sessions never collide.
 */
export function spendDeltaPath(storeDir: string, session: string): string {
  return path.join(storeDir, `${session}.delta.jsonl`)
}

// A finite, non-negative number from an untrusted field, or the fallback. A
// negative offset would rewind the read; a NaN total would poison every later
// bucket.
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback
}

/**
 * Read a session's ledger. A missing, unreadable, or malformed file reads as an
 * empty ledger, which restarts the measurement rather than failing the turn.
 * The cost of that is one late warning; the cost of throwing is a broken
 * session.
 */
export function readSpendLedger(filePath: string): SpendLedger {
  if (!existsSync(filePath)) {
    return emptySpendLedger()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return emptySpendLedger()
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return emptySpendLedger()
  }
  const record = parsed as Record<string, unknown>
  const empty = emptySpendLedger()
  const keys = record['seenKeys']
  return {
    bytesRead: numberOr(record['bytesRead'], empty.bytesRead),
    lastWarnedBucket: numberOr(
      record['lastWarnedBucket'],
      empty.lastWarnedBucket,
    ),
    requests: numberOr(record['requests'], empty.requests),
    seenKeys: Array.isArray(keys)
      ? keys.filter((key): key is string => typeof key === 'string')
      : [],
    spentUsd: numberOr(record['spentUsd'], empty.spentUsd),
    unpricedRequests: numberOr(
      record['unpricedRequests'],
      empty.unpricedRequests,
    ),
    updatedAt: numberOr(record['updatedAt'], empty.updatedAt),
  }
}

/**
 * Flush a session's ledger. Swallows every write error: losing the offset costs
 * one re-read, and failing the turn costs the session.
 */
export function writeSpendLedger(filePath: string, ledger: SpendLedger): void {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, `${JSON.stringify(ledger)}\n`, 'utf8')
  } catch {
    // Fail open.
  }
}

/**
 * The newest `SEEN_KEY_CAP` dedup keys. Newest wins because a repeat of a
 * billed request lands near the record it copies.
 */
export function trimSeenKeys(keys: readonly string[]): string[] {
  return keys.length > SEEN_KEY_CAP ? keys.slice(-SEEN_KEY_CAP) : [...keys]
}

/**
 * The bytes appended since `offset`, cut at the last complete line.
 *
 * Three cases the offset alone gets wrong, all handled here: a file that SHRANK
 * was replaced, so the read restarts at 0 rather than resuming mid-line; a
 * final line with no newline is not yet complete, so it is left for the next
 * run; and a backlog larger than `MAX_DELTA_BYTES` is consumed over several
 * runs instead of in one long parse. Returns `undefined` when the file cannot
 * be read at all.
 */
export function readTranscriptDelta(
  filePath: string,
  offset: number,
): TranscriptDelta | undefined {
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return undefined
  }
  try {
    const { size } = fstatSync(fd)
    const start = offset > size ? 0 : offset
    const available = Math.min(size - start, MAX_DELTA_BYTES)
    if (available <= 0) {
      return { bytes: Buffer.alloc(0), nextOffset: start }
    }
    const buf = Buffer.alloc(available)
    const read = readSync(fd, buf, 0, available, start)
    const chunk = buf.subarray(0, read)
    const lastNewline = chunk.lastIndexOf(0x0a)
    if (lastNewline === -1) {
      return { bytes: Buffer.alloc(0), nextOffset: start }
    }
    return {
      bytes: chunk.subarray(0, lastNewline + 1),
      nextOffset: start + lastNewline + 1,
    }
  } catch {
    return undefined
  } finally {
    try {
      closeSync(fd)
    } catch {
      // Fail open.
    }
  }
}

const PRICING: Readonly<Record<string, unknown>> = pricingJson

function recordOf(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function anthropicEntry(): Readonly<Record<string, unknown>> | undefined {
  return recordOf(recordOf(PRICING['services'])?.['anthropic'])
}

/**
 * The per-model list rates from the canonical pricing data, keyed exactly as
 * the data spells them. A model the data does not price is left out on purpose:
 * `costScan` then reports it as unpriced, and an unpriced model is never
 * treated as free.
 */
export function anthropicModelRates(): Readonly<Record<string, ModelRate>> {
  const models = recordOf(anthropicEntry()?.['models'])
  const out: Record<string, ModelRate> = {}
  const ids = Object.keys(models ?? {})
  for (let i = 0, { length } = ids; i < length; i += 1) {
    const id = ids[i]!
    const entry = recordOf(models?.[id])
    if (!entry) {
      continue
    }
    const input = entry['inputPerMtok']
    const output = entry['outputPerMtok']
    out[id] = {
      inputPerMtok: typeof input === 'number' ? input : undefined,
      outputPerMtok: typeof output === 'number' ? output : undefined,
    }
  }
  return out
}

/**
 * The cache multipliers from the canonical pricing data. Both write TTLs are
 * read: they bill at different rates, and folding them together understated a
 * measured window by 4.2%.
 */
export function anthropicCacheMultipliers(): CacheMultipliers {
  const multipliers = recordOf(anthropicEntry()?.['multipliers'])
  const read = multipliers?.['cacheRead']
  const write1h = multipliers?.['cacheWrite1h']
  const write5m = multipliers?.['cacheWrite5m']
  return {
    cacheRead: typeof read === 'number' ? read : undefined,
    cacheWrite1h: typeof write1h === 'number' ? write1h : undefined,
    cacheWrite5m: typeof write5m === 'number' ? write5m : undefined,
  }
}

/**
 * Required inputs for parsing one delta. A required bag, so it is a `config`.
 */
export interface DeltaScanConfig {
  bytes: Buffer
  scratchFile: string
  seen: Set<string>
}

/**
 * Fold the delta bytes through the CANONICAL transcript parser.
 *
 * The bytes are staged to a scratch file because `scanTranscript` takes a path,
 * and reusing it is the point: the record shape it reads is subtle (the
 * `message.id + requestId` dedup key, the 1-hour cache-write split, the
 * `usage.speed` bucket), and a second parser here would drift from the one the
 * whole-corpus report uses. The staged file only ever holds this turn's delta,
 * and it is deleted whether the scan succeeds or throws.
 */
export async function scanSpendDelta(
  config: DeltaScanConfig,
): Promise<UsageScan | undefined> {
  const cfg = { __proto__: null, ...config } as DeltaScanConfig
  const scan: UsageScan = {
    byDay: new Map(),
    byModel: new Map(),
    byModelSpeed: new Map(),
    byProject: new Map(),
    dedup: emptyDedupDiagnostics(),
    filesScanned: 1,
    totals: emptyTotals(),
  }
  try {
    mkdirSync(path.dirname(cfg.scratchFile), { recursive: true })
    writeFileSync(cfg.scratchFile, cfg.bytes)
    // The whole delta, whatever it is dated: the window belongs to the session,
    // and a month boundary mid-session must not drop a record already billed.
    await scanTranscript(
      cfg.scratchFile,
      scan,
      cfg.seen,
      0,
      Number.MAX_SAFE_INTEGER,
    )
  } catch {
    return undefined
  } finally {
    try {
      safeDeleteSync(cfg.scratchFile)
    } catch {
      // Fail open.
    }
  }
  return scan
}

/**
 * Everything the warning line needs. A required bag, so it is a `config`.
 */
export interface SpendWarningConfig {
  budget: BudgetConfig
  bucket: number
  spentUsd: number
  unpricedModels: readonly string[]
}

/**
 * The nudge text: the crossing, the gauge, and where the next one lands.
 *
 * Percentages and tier names only. The gauge comes from `renderSpendMeter`,
 * which withholds absolute figures unless the budget opts in, so this function
 * never has to decide the privacy question itself.
 */
export function formatSpendWarning(config: SpendWarningConfig): string {
  const cfg = { __proto__: null, ...config } as SpendWarningConfig
  const step = cfg.budget.warnEveryPct
  const crossedPct = cfg.bucket * step
  const tier = tierFor(cfg.spentUsd, cfg.budget)
  const lines = [
    verdictLine(
      'hint',
      HOOK_NAME,
      `this session has spent ${crossedPct}% of the monthly target, and sits in the ${tier} tier.`,
    ),
    verdictContinuation(renderSpendMeter(cfg.spentUsd, cfg.budget)),
    verdictContinuation(
      `Next warning at ${crossedPct + step}%. To slow the burn: drop stale context, or finish the thread and start a fresh session.`,
    ),
  ]
  if (cfg.unpricedModels.length) {
    lines.push(
      verdictContinuation(
        `${cfg.unpricedModels.length} observed model(s) carry no price entry (${cfg.unpricedModels.join(', ')}), so this reading is a floor.`,
      ),
    )
  }
  return lines.join('\n')
}

/**
 * The machine-local budget, or undefined when there is none. A malformed budget
 * reads the same as an absent one HERE, unlike the report, which calls it a
 * hard error: a nudge that refused to run over a bad config would be a
 * measurement breaking a session.
 */
export async function readSpendBudget(): Promise<BudgetConfig | undefined> {
  try {
    return await readBudgetConfig()
  } catch {
    return undefined
  }
}

export async function check(payload: SpendStopPayload): Promise<GuardResult> {
  try {
    // Stop carries no tool, and the event name pins the surface whenever the
    // harness supplies one.
    if (payload.tool_name !== undefined) {
      return undefined
    }
    const event = payload.hook_event_name
    if (typeof event === 'string' && event !== 'Stop') {
      return undefined
    }
    const transcript = payload.transcript_path
    const session = spendSessionKey(payload)
    if (!transcript || !session) {
      return undefined
    }
    // No bar means no crossing to report. Read before any transcript work, so an
    // unbudgeted machine pays almost nothing for this hook.
    const budget = await readSpendBudget()
    if (!budget) {
      return undefined
    }
    const storeDir = resolveSpendStoreDir(
      payload.cwd || process.env['CLAUDE_PROJECT_DIR'] || undefined,
    )
    const ledgerFile = spendLedgerPath(storeDir, session)
    const before = readSpendLedger(ledgerFile)
    const delta = readTranscriptDelta(transcript, before.bytesRead)
    if (!delta) {
      return undefined
    }
    const now = Date.now()
    if (delta.bytes.length === 0) {
      // Nothing complete was appended. The offset can still move, when the file
      // was replaced and shrank, so the ledger is flushed either way.
      writeSpendLedger(ledgerFile, {
        ...before,
        bytesRead: delta.nextOffset,
        updatedAt: now,
      })
      return undefined
    }
    const seen = new Set(before.seenKeys)
    const scan = await scanSpendDelta({
      bytes: delta.bytes,
      scratchFile: spendDeltaPath(storeDir, session),
      seen,
    })
    if (!scan) {
      return undefined
    }
    const cost = costScan(
      scan,
      anthropicModelRates(),
      anthropicCacheMultipliers(),
    )
    const spentUsd = before.spentUsd + cost.pointUsd
    const bucket = budgetBucket(
      spentUsd,
      budget.target.monthly,
      budget.warnEveryPct,
    )
    writeSpendLedger(ledgerFile, {
      bytesRead: delta.nextOffset,
      lastWarnedBucket: Math.max(before.lastWarnedBucket, bucket),
      requests: before.requests + scan.totals.requests,
      seenKeys: trimSeenKeys([...seen]),
      spentUsd,
      unpricedRequests: before.unpricedRequests + cost.unpricedRequests,
      updatedAt: now,
    })
    // Only an INCREASE speaks. The same bucket as last time means the crossing
    // was already announced.
    if (bucket <= before.lastWarnedBucket) {
      return undefined
    }
    return notify(
      formatSpendWarning({
        budget,
        bucket,
        spentUsd,
        unpricedModels: cost.unpricedModels,
      }),
    )
  } catch {
    // Fail open and silent. A spend measurement must never break a turn.
    return undefined
  }
}

export const hook = defineHook({
  check,
  event: 'Stop',
  type: 'nudge',
})

void runHook(hook, import.meta.url)
