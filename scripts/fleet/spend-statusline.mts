#!/usr/bin/env node
/*
 * @file The Claude Code statusline: one line carrying the token spend meter for
 *   the month to date plus the model in play. Claude Code re-runs this on every
 *   render, so the whole design is about never paying for the measurement
 *   twice. The measuring, dedup, costing, and gauge rendering all live in
 *   `_shared/claude-usage.mts` and `report-claude-usage.mts`; this entry only
 *   caches, reads the render payload, and prints. Three contracts it exists to
 *   hold:
 *
 *   1. IT SERVES FROM A CACHE. Costing a month streams every transcript touched
 *      in the window, thousands of files and seconds of work, so a statusline
 *      that measured per render would be unusable. The figure is read from a
 *      snapshot under {@link SPEND_CACHE_DIR} and only re-measured once the
 *      newest snapshot is older than {@link SPEND_CACHE_TTL_MS}. Any producer
 *      may write there: the spend tracker's snapshot and this script's are the
 *      same shape and the freshest one wins, so wiring the tracker later
 *      removes this script's scans rather than duplicating them.
 *   2. PERCENTAGES AND TIER NAMES ONLY. Same contract as the report: a
 *      percentage and a tier name, never a dollar figure, unless the budget's
 *      `privacy.printAbsoluteFigures` says otherwise. A statusline sits in
 *      every screen share and terminal recording, which is a worse home for a
 *      budget than a transcript.
 *   3. IT NEVER SPEAKS UP ON FAILURE. Every failure path prints NOTHING and
 *      exits 0, so a broken render costs the previous line rather than pinning
 *      a stack trace into the user's chrome. No budget file is not a failure:
 *      it prints a short neutral line rather than inventing a ceiling nobody
 *      agreed to. Colour is the default here, unlike the report, because this
 *      output renders in a terminal instead of landing in a transcript.
 *
 *   Wired through the `statusLine` entry in `.claude/settings.json`, which is
 *   what writes the render payload to this script's stdin. Usage:
 *   node scripts/fleet/spend-statusline.mts
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { getPalette } from '@socketsecurity/lib-stable/colors/socket-palette'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { loadPricing } from './estimate-ai-cost.mts'
import { FLEET_CACHE_DIR } from './paths.mts'
import {
  meterGlyphFor,
  readBudgetConfig,
  renderSpendMeter,
  scanUsage,
  tierFor,
} from './_shared/claude-usage.mts'
import type { BudgetConfig } from './_shared/claude-usage.mts'
import { isMainModule } from './_shared/is-main-module.mts'
import { runMain } from './_shared/run-main.mts'
import type { ScriptMeta } from './_shared/run-main.mts'
import {
  monthToDateWindow,
  paintMeterBar,
  summarizeSpend,
  TIER_PALETTE_SLOT,
  unpricedModels,
} from './report-claude-usage.mts'
import type { SpendWindow } from './report-claude-usage.mts'

import type { Readable } from 'node:stream'

const logger = getDefaultLogger()

/**
 * The model-cost store: where a measured spend figure is cached between
 * renders. Shared with the spend tracker rather than private to this script, so
 * one measurement can serve every consumer.
 */
export const SPEND_CACHE_DIR = path.join(FLEET_CACHE_DIR, 'socket-model-cost')

/**
 * This script's own snapshot file. Reading sweeps the whole store, so a
 * snapshot written by another producer is served just as readily; only this
 * name is written.
 */
export const STATUSLINE_SNAPSHOT_NAME = 'statusline.json'

/**
 * How long a snapshot stays servable: five minutes.
 *
 * The floor is set by what a measurement costs. Streaming a month of
 * transcripts takes seconds, so a TTL near the render interval would keep a
 * scan permanently in flight and make the line unusable, which is the exact
 * failure this cache exists to prevent.
 *
 * The ceiling is set by how fast the gauge can actually move. The bar is 20
 * cells wide, so one cell is 5% of a monthly tier, and five minutes of even
 * heavy spend is a small fraction of one cell. A shorter TTL buys no visible
 * precision and a longer one starts hiding a real jump for more than a turn or
 * two, so five minutes is where those two pressures meet.
 */
export const SPEND_CACHE_TTL_MS = 300_000

/**
 * How long to wait for the render payload before giving up on it. Claude Code
 * writes the payload and closes the stream, so the timeout only covers an
 * inherited pipe nobody closes: without it the statusline would hang forever,
 * which is worse than rendering without the model name.
 */
export const STDIN_TIMEOUT_MS = 250

/**
 * A measured spend figure, cached for the next render. `windowFromMs` is part
 * of the record rather than implied so a consumer can tell WHICH window was
 * measured; `unpricedModelCount` is carried so the line can announce a partial
 * total instead of showing a confident gauge over an unpriced hole.
 */
export interface SpendSnapshot {
  measuredAtMs: number
  requests: number
  unpricedModelCount: number
  usd: number
  windowFromMs: number
}

export interface MeasureSpendConfig {
  nowMs: number
  window: SpendWindow
}

/**
 * The stdin shape this script reads: a readable stream that may also be a TTY.
 * `process.stdin` satisfies it, and a test passes a plain readable.
 */
export type PayloadStream = Readable & { isTTY?: boolean | undefined }

export interface ReadPayloadOptions {
  stream?: PayloadStream | undefined
  timeoutMs?: number | undefined
}

export interface ReadSnapshotConfig {
  cacheDir: string
  nowMs: number
  ttlMs: number
  windowFromMs: number
}

export interface ResolveSpendConfig {
  cacheDir: string
  measure: () => Promise<SpendSnapshot>
  nowMs: number
  ttlMs: number
  windowFromMs: number
}

export interface SnapshotFreshnessConfig {
  nowMs: number
  ttlMs: number
  windowFromMs: number
}

export interface StatuslineRenderConfig {
  budget: BudgetConfig
  color?: boolean | undefined
  model?: string | undefined
  snapshot: SpendSnapshot
}

export interface WriteSnapshotConfig {
  cacheDir: string
  snapshot: SpendSnapshot
}

/**
 * Whether the gauge may carry colour. The report gates colour on a TTY because
 * its output can land in a transcript, where escape codes are noise. A
 * statusline is the opposite case: it only ever renders in the terminal, and
 * Claude Code hands it a pipe rather than a TTY, so a TTY test here would
 * disable colour permanently. `NO_COLOR` is the cross-tool opt-out.
 */
export function colorIsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env['NO_COLOR'] && env['TERM'] !== 'dumb'
}

/**
 * The rendered line: the gauge, a partial-total flag when one is owed, then the
 * model. The meter string itself comes from the shared library and the tint
 * comes from the report's palette map, so the statusline cannot drift from the
 * CLI it mirrors.
 */
export function formatSpendStatusline(config: StatuslineRenderConfig): string {
  const cfg = { __proto__: null, ...config } as StatuslineRenderConfig
  const { budget, snapshot } = cfg
  const meter = renderSpendMeter(snapshot.usd, budget)
  const painted =
    cfg.color === true
      ? paintMeterBar(
          meter,
          getPalette('dark')[TIER_PALETTE_SLOT[tierFor(snapshot.usd, budget)]],
        )
      : meter
  // No second alert glyph here: the gauge already carries the tier's own
  // (⛽/⚠️/🚨), so repeating it read as two unrelated alarms. And "PARTIAL" named
  // the state without saying what was partial about it. The count is the useful
  // part, because it says the spend figure is UNDER the truth by whatever those
  // models cost.
  const partial =
    snapshot.unpricedModelCount > 0
      ? ` · excludes ${snapshot.unpricedModelCount} unpriced ${
          snapshot.unpricedModelCount === 1 ? 'model' : 'models'
        }`
      : ''
  const model = cfg.model ? ` · ${cfg.model}` : ''
  return `${painted}${partial}${model}`
}

/**
 * Measure the window from scratch: the expensive path, taken only when no
 * servable snapshot exists.
 */
export async function measureSpendSnapshot(
  config: MeasureSpendConfig,
): Promise<SpendSnapshot> {
  const cfg = { __proto__: null, ...config } as MeasureSpendConfig
  const scan = await scanUsage(cfg.window.fromMs, cfg.window.toMs)
  const summary = summarizeSpend(scan, loadPricing())
  return {
    measuredAtMs: cfg.nowMs,
    requests: summary.requests,
    unpricedModelCount: unpricedModels(summary).length,
    usd: summary.pricedUsd,
    windowFromMs: cfg.window.fromMs,
  }
}

/**
 * The line printed when no budget file exists. It names the state and stops
 * there: a gauge needs a bar behind it, and inventing one would read as a
 * ceiling somebody agreed to.
 */
export function neutralSpendLine(model?: string | undefined): string {
  const suffix = model ? ` · ${model}` : ''
  return `${meterGlyphFor('target')} no budget configured${suffix}`
}

/**
 * Read a snapshot record, or undefined when the payload cannot be trusted. A
 * malformed snapshot is treated as absent rather than repaired: the cost of
 * being wrong is one extra scan, and serving a half-valid figure would put a
 * wrong gauge in front of the user with nothing to explain it.
 */
export function parseSpendSnapshot(raw: string): SpendSnapshot | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined
  }
  const record = parsed as Record<string, unknown>
  const measuredAtMs = record['measuredAtMs']
  const usd = record['usd']
  const windowFromMs = record['windowFromMs']
  if (
    typeof measuredAtMs !== 'number' ||
    !Number.isFinite(measuredAtMs) ||
    typeof usd !== 'number' ||
    !Number.isFinite(usd) ||
    usd < 0 ||
    typeof windowFromMs !== 'number' ||
    !Number.isFinite(windowFromMs)
  ) {
    return undefined
  }
  const requests = record['requests']
  const unpricedModelCount = record['unpricedModelCount']
  return {
    measuredAtMs,
    requests: typeof requests === 'number' ? requests : 0,
    unpricedModelCount:
      typeof unpricedModelCount === 'number' ? unpricedModelCount : 0,
    usd,
    windowFromMs,
  }
}

/**
 * The newest servable snapshot in the store, or undefined when there is none.
 * Every `.json` in the store is a candidate, so a snapshot from the spend
 * tracker is served exactly like one this script wrote, and the file NAME
 * carries no meaning. Undefined here is what triggers a rescan.
 */
export async function readFreshestSnapshot(
  config: ReadSnapshotConfig,
): Promise<SpendSnapshot | undefined> {
  const cfg = { __proto__: null, ...config } as ReadSnapshotConfig
  let names: string[]
  try {
    names = await readdir(cfg.cacheDir)
  } catch {
    return undefined
  }
  let best: SpendSnapshot | undefined
  for (let i = 0, { length } = names; i < length; i += 1) {
    const name = names[i]!
    if (!name.endsWith('.json')) {
      continue
    }
    let raw: string
    try {
      raw = await readFile(path.join(cfg.cacheDir, name), 'utf8')
    } catch {
      continue
    }
    const snapshot = parseSpendSnapshot(raw)
    if (!snapshot) {
      continue
    }
    if (!best || snapshot.measuredAtMs > best.measuredAtMs) {
      best = snapshot
    }
  }
  return best && snapshotIsFresh(best, cfg) ? best : undefined
}

/**
 * The render payload Claude Code writes to stdin. Returns undefined for an
 * absent, empty, or unparseable payload: the gauge is the point of the line and
 * still renders without the model name, so a payload problem must not cost the
 * measurement. A TTY means a human ran the script by hand, where no payload is
 * coming and waiting would hang.
 */
export async function readStatuslinePayload(
  options?: ReadPayloadOptions | undefined,
): Promise<Record<string, unknown> | undefined> {
  const opts = { __proto__: null, ...options } as ReadPayloadOptions
  const stream: PayloadStream = opts.stream ?? process.stdin
  if (stream.isTTY === true) {
    return undefined
  }
  const timeoutMs = opts.timeoutMs ?? STDIN_TIMEOUT_MS
  const text = await new Promise<string>(resolve => {
    let buffered = ''
    let settled = false
    function finish(): void {
      if (settled) {
        return
      }
      settled = true
      // Releases the handle so the process can exit even when the timeout won
      // the race and the stream is still open.
      stream.pause()
      resolve(buffered)
    }
    // Unref'd rather than cleared on settle: an unref'd timer cannot hold the
    // event loop open, so the ordinary path needs no teardown, and `settled`
    // already makes a late fire a no-op.
    setTimeout(finish, timeoutMs).unref()
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buffered += chunk
    })
    stream.on('end', finish)
    stream.on('error', finish)
  })
  if (!text.trim()) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  return typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>)
    : undefined
}

/**
 * The cached figure, or a fresh measurement written back for the next render.
 * The write is best-effort: a store that cannot be written costs one rescan per
 * render, and that must never cost the render itself.
 */
export async function resolveSpendSnapshot(
  config: ResolveSpendConfig,
): Promise<SpendSnapshot> {
  const cfg = { __proto__: null, ...config } as ResolveSpendConfig
  const cached = await readFreshestSnapshot(cfg)
  if (cached) {
    return cached
  }
  const measured = await cfg.measure()
  try {
    await writeSpendSnapshot({ cacheDir: cfg.cacheDir, snapshot: measured })
  } catch {}
  return measured
}

/**
 * Whether a snapshot may be served. Two conditions, both load-bearing: it is
 * younger than the TTL, and it describes the SAME window. On the 1st of a month
 * a snapshot written minutes earlier describes last month's total, which is
 * fresh by age and wrong by content. A future-dated stamp reads as stale, so a
 * clock skew costs one rescan instead of freezing the gauge.
 */
export function snapshotIsFresh(
  snapshot: SpendSnapshot,
  config: SnapshotFreshnessConfig,
): boolean {
  const cfg = { __proto__: null, ...config } as SnapshotFreshnessConfig
  const age = cfg.nowMs - snapshot.measuredAtMs
  return (
    snapshot.windowFromMs === cfg.windowFromMs && age >= 0 && age < cfg.ttlMs
  )
}

/**
 * The model to name on the line: the payload's display name, falling back to
 * its raw id. Read defensively rather than trusted, since the payload's shape
 * belongs to the client and a missing field is not worth losing the gauge over.
 */
export function statuslineModelLabel(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const model = payload?.['model']
  if (typeof model !== 'object' || model === null) {
    return undefined
  }
  const record = model as Record<string, unknown>
  const display = record['display_name']
  if (typeof display === 'string' && display) {
    return display
  }
  const id = record['id']
  return typeof id === 'string' && id ? id : undefined
}

/**
 * Persist a snapshot for the next render. Written to a scratch sibling and
 * renamed so a concurrent reader never sees a half-written record, and at mode
 * 600 to match the budget store's posture: a measured total is as private as
 * the bar it is measured against.
 */
export async function writeSpendSnapshot(
  config: WriteSnapshotConfig,
): Promise<void> {
  const cfg = { __proto__: null, ...config } as WriteSnapshotConfig
  await mkdir(cfg.cacheDir, { recursive: true })
  const target = path.join(cfg.cacheDir, STATUSLINE_SNAPSHOT_NAME)
  // Not a `.json` name, so a concurrent reader's store sweep skips it.
  const scratch = `${target}.${process.pid}.tmp`
  await writeFile(scratch, `${JSON.stringify(cfg.snapshot)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(scratch, target)
}

export async function main(): Promise<number> {
  try {
    const model = statuslineModelLabel(await readStatuslinePayload())
    const budget = await readBudgetConfig()
    if (!budget) {
      logger.log(neutralSpendLine(model))
      return 0
    }
    const now = new Date()
    const nowMs = now.getTime()
    const window = monthToDateWindow(now)
    const snapshot = await resolveSpendSnapshot({
      cacheDir: SPEND_CACHE_DIR,
      measure: () => measureSpendSnapshot({ nowMs, window }),
      nowMs,
      ttlMs: SPEND_CACHE_TTL_MS,
      windowFromMs: window.fromMs,
    })
    logger.log(
      formatSpendStatusline({
        budget,
        color: colorIsEnabled(),
        model,
        snapshot,
      }),
    )
  } catch {
    // Chrome must stay quiet. Printing nothing leaves the previous line in
    // place, where a message or a stack would be pinned into the user's UI.
  }
  return 0
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'print the one-line month-to-date token spend meter for the Claude Code statusline',
  help: `Usage: node scripts/fleet/spend-statusline.mts

Reads Claude Code's render payload on stdin and prints ONE line: the fuel-gauge
spend meter for the month to date, then the current model. Takes no flags.

The measurement is served from a snapshot under .cache/fleet/socket-model-cost/
and only re-measured once the newest snapshot passes its TTL, because costing a
month streams thousands of transcripts. Percentages and tier names only, unless
the machine-local budget sets privacy.printAbsoluteFigures. With no budget file
it prints a short neutral line instead of inventing a ceiling, and on ANY error
it prints nothing and exits 0 so a failure never reaches the user's chrome.

Colour is on unless NO_COLOR is set: this output renders in a terminal rather
than landing in a session transcript. Run report-claude-usage.mts for the full
report the gauge is a summary of.`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
