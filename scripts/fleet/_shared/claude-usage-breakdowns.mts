/*
 * @file Breakdown views over a usage scan - by project, by day, by speed, and
 *   the dedup diagnostics. Pure renderers: they take a scan plus prices and
 *   return lines, so the CLI stays a thin entry and every view is unit-testable
 *   without touching a transcript.
 *
 *   These exist to retire five throwaway analysis scripts. Every finding that
 *   shaped the cost model came out of one of these views, and re-deriving them
 *   from scratch each time is how a wrong ranking gets published: a scratch
 *   by-project pass that scanned only one directory level saw 34% of the data.
 *
 *   Two honesty rules they inherit from the report entry:
 *
 *   1. SHARES BY DEFAULT, dollars only when explicitly asked. This output lands
 *      in the session transcript that the spend scanner reads, so a view that
 *      printed dollars every run would write spend history into thousands of
 *      files.
 *   2. A VIEW SAYS WHAT IT CANNOT SEE. Only the by-speed view can apply the
 *      fast-mode premium, because only `byModelSpeed` carries the split. The
 *      project and day views are base-rate and label themselves as such rather
 *      than quietly under-reporting a fast-heavy project.
 */

import {
  costUsage,
  FAST_MODE_MULTIPLIER_RANGE,
  isFastSpeed,
} from './claude-usage.mts'

import type {
  CacheMultipliers,
  ModelRate,
  UsageScan,
  UsageTotals,
} from './claude-usage.mts'

export interface BreakdownOptions {
  /**
   * Print dollar figures. Default false: shares only.
   */
  showAbsolute?: boolean | undefined
  /**
   * Rows to print. Default 12; the tail is summarised, never silently cut.
   */
  top?: number | undefined
}

export interface BreakdownRow {
  label: string
  share: number
  usd: number
}

interface ResolvedConfig {
  showAbsolute: boolean
  top: number
}

function resolveOptions(
  options?: BreakdownOptions | undefined,
): ResolvedConfig {
  const opts = { __proto__: null, ...options } as BreakdownOptions
  return {
    showAbsolute: opts.showAbsolute === true,
    top: opts.top ?? 12,
  }
}

function money(usd: number): string {
  return `$${Math.round(usd).toLocaleString('en-US')}`
}

function formatValue(row: BreakdownRow, resolved: ResolvedConfig): string {
  const share = `${(row.share * 100).toFixed(1)}%`
  return resolved.showAbsolute
    ? `${money(row.usd).padStart(10)}  ${share.padStart(6)}`
    : share.padStart(6)
}

/**
 * Cost one bucket of totals at BASE rate. Used by the views that have no speed
 * split; the returned figure is a floor, not a total.
 */
export function costAtBaseRate(
  totals: UsageTotals,
  rate: ModelRate | undefined,
  multipliers: CacheMultipliers,
): number {
  return costUsage(totals, rate, multipliers)?.totalUsd ?? 0
}

/**
 * Billable token count for a bucket, so a blended per-token rate stays
 * meaningful across buckets that carry no model split.
 */
export function billableTokens(totals: UsageTotals): number {
  return totals.input + totals.cacheWrite + totals.cacheRead + totals.output
}

/**
 * One blended dollars-per-token figure for the window, derived from the scan's
 * own model mix. Cruder than per-model costing and only used where a bucket
 * carries no model split.
 */
export function blendedRatePerToken(
  scan: UsageScan,
  models: Readonly<Record<string, ModelRate>>,
  multipliers: CacheMultipliers,
): number {
  let usd = 0
  let tokens = 0
  for (const [model, totals] of scan.byModel) {
    usd += costAtBaseRate(totals, models[model], multipliers)
    tokens += billableTokens(totals)
  }
  return tokens > 0 ? usd / tokens : 0
}

/**
 * Rows sorted by cost, with everything past `top` folded into one explicit
 * remainder row. A silently truncated list reads as a complete one.
 */
export function rankRows(rows: BreakdownRow[], top: number): BreakdownRow[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- fresh copy
  const ordered = rows.slice().sort((a, b) => b.usd - a.usd)
  if (ordered.length <= top) {
    return ordered
  }
  const head = ordered.slice(0, top)
  const tail = ordered.slice(top)
  head.push({
    label: `(${tail.length} more)`,
    share: tail.reduce((sum, row) => sum + row.share, 0),
    usd: tail.reduce((sum, row) => sum + row.usd, 0),
  })
  return head
}

/**
 * Spend per project. Base rate: the scan's per-project totals carry no speed
 * split, so a fast-heavy project reads low here and the header says so.
 */
export function renderByProject(
  scan: UsageScan,
  models: Readonly<Record<string, ModelRate>>,
  multipliers: CacheMultipliers,
  options?: BreakdownOptions | undefined,
): string[] {
  const resolved = resolveOptions(options)
  const blended = blendedRatePerToken(scan, models, multipliers)
  const rows: BreakdownRow[] = []
  let total = 0
  for (const [project, totals] of scan.byProject) {
    const usd = billableTokens(totals) * blended
    total += usd
    rows.push({ label: project, share: 0, usd })
  }
  for (let i = 0, { length } = rows; i < length; i += 1) {
    const row = rows[i]!
    row.share = total > 0 ? row.usd / total : 0
  }
  const lines = [`by project (base rate, ${scan.byProject.size} project(s)):`]
  for (const row of rankRows(rows, resolved.top)) {
    lines.push(
      `  ${row.label.slice(0, 38).padEnd(40)} ${formatValue(row, resolved)}`,
    )
  }
  return lines
}

/**
 * Daily series. The view that shows WHEN a lever was active, which is what
 * makes an active-day rate computable instead of a window average.
 */
export function renderByDay(
  scan: UsageScan,
  models: Readonly<Record<string, ModelRate>>,
  multipliers: CacheMultipliers,
  options?: BreakdownOptions | undefined,
): string[] {
  const resolved = resolveOptions(options)
  const blended = blendedRatePerToken(scan, models, multipliers)
  const days = [...scan.byDay.keys()]
  // oxlint-disable-next-line unicorn/no-array-sort -- fresh copy
  days.sort()
  const lines = [`by day (base rate, ${days.length} day(s)):`]
  for (let i = 0, { length } = days; i < length; i += 1) {
    const day = days[i]!
    const totals = scan.byDay.get(day)
    if (!totals) {
      continue
    }
    const usd = billableTokens(totals) * blended
    const value = resolved.showAbsolute ? money(usd).padStart(10) : ''
    lines.push(
      `  ${day}  ${value}  ${String(totals.requests).padStart(8)} requests`,
    )
  }
  return lines
}

/**
 * Standard vs fast vs unset. The only view that can apply the premium, and it
 * reports the BAND rather than a point, because cash does not identify where in
 * the band the truth sits.
 */
export function renderBySpeed(
  scan: UsageScan,
  models: Readonly<Record<string, ModelRate>>,
  multipliers: CacheMultipliers,
  options?: BreakdownOptions | undefined,
): string[] {
  const resolved = resolveOptions(options)
  const bySpeed = new Map<
    string,
    { high: number; low: number; requests: number }
  >()
  for (const row of scan.byModelSpeed.values()) {
    const base = costAtBaseRate(row, models[row.model], multipliers)
    const fast = isFastSpeed(row.speed)
    const agg = bySpeed.get(row.speed) ?? { high: 0, low: 0, requests: 0 }
    agg.low += fast ? base * FAST_MODE_MULTIPLIER_RANGE.floor : base
    agg.high += fast ? base * FAST_MODE_MULTIPLIER_RANGE.list : base
    agg.requests += row.requests
    bySpeed.set(row.speed, agg)
  }
  const lines = ['by speed (fast priced as a band, floor to list):']
  for (const [speed, agg] of bySpeed) {
    const band =
      agg.low === agg.high
        ? money(agg.low)
        : `${money(agg.low)} - ${money(agg.high)}`
    const value = resolved.showAbsolute ? band.padStart(22) : ''
    lines.push(
      `  ${speed.padEnd(12)} ${value}  ${String(agg.requests).padStart(8)} requests`,
    )
  }
  return lines
}

/**
 * The dedup diagnostics, in prose. Surfaces the assumption every figure rests
 * on so a reader can see it held rather than trusting that it did.
 */
export function renderDedup(scan: UsageScan): string[] {
  const { dedup } = scan
  const share =
    dedup.recordsSeen > 0
      ? ((dedup.duplicatesDropped / dedup.recordsSeen) * 100).toFixed(1)
      : '0.0'
  return [
    'dedup (message.id + requestId identifies one billed request):',
    `  records seen           ${String(dedup.recordsSeen).padStart(10)}`,
    `  duplicates dropped     ${String(dedup.duplicatesDropped).padStart(10)}  (${share}%)`,
    `  keyless records        ${String(dedup.keylessRecords).padStart(10)}  must be 0, else totals OVER-state`,
    `  split across requests  ${String(dedup.multiRequestMessageIds).padStart(10)}  must be 0, else totals UNDER-state`,
  ]
}
