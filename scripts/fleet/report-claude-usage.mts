#!/usr/bin/env node
/*
 * @file Report measured Claude spend for the current month against the
 *   machine-local budget. The user-facing half of the spend work: the
 *   measurement, dedup, costing, and gauge rendering all live in
 *   `_shared/claude-usage.mts`, and this entry only chooses a window, resolves
 *   prices, and presents the result.
 *   Three presentation contracts it exists to hold:
 *
 *   1. PERCENTAGES BY DEFAULT. The gauge prints a percentage and a tier name,
 *      never a dollar figure, unless `--absolute` is passed or the budget's
 *      `privacy.printAbsoluteFigures` is set. Report output lands in the
 *      session transcript, which is exactly what the spend scanner reads, so a
 *      report that printed the bar would write the budget into thousands of
 *      files.
 *   2. A PARTIAL TOTAL IS ANNOUNCED, NEVER SILENT. A model with no entry in
 *      `constants/model-pricing.json` cannot be costed, so its spend is missing
 *      from the total. The report says so loudly and names the models, because
 *      a total that silently omits the default model reads as a low month.
 *   3. NO BUDGET IS ITS OWN VERDICT. With no budget file the report says "no
 *      budget configured" and names where it looked. It never falls back to a
 *      default ceiling — an invented bar reads as an agreed one. Colour is
 *      opt-in and gated on `process.stdout.isTTY`, for the same reason as (1):
 *      escape codes in a transcript are noise. Tiers map onto the Socket brand
 *      palette's semantic slots (`info` while ordinary, `warning` on the
 *      reserve, `error` at the ceiling) rather than a hand-rolled ramp. Usage:
 *      node scripts/fleet/report-claude-usage.mts [--status|--json]
 *      [--absolute]
 */

import process from 'node:process'

import { getPalette } from '@socketsecurity/lib-stable/colors/socket-palette'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { findModelPricing, loadPricing } from './estimate-ai-cost.mts'
import type { PricingData } from './estimate-ai-cost.mts'
import {
  billsMarginalMoney,
  budgetConfigPaths,
  costUsage,
  dedupKeyIsSound,
  readAccountIdentity,
  readBudgetConfig,
  renderSpendMeter,
  scanUsage,
  tierFor,
} from './_shared/claude-usage.mts'
import type {
  AccountIdentity,
  BudgetConfig,
  BudgetTierName,
  DedupDiagnostics,
  UsageScan,
  UsageTotals,
} from './_shared/claude-usage.mts'
import {
  renderByDay,
  renderByProject,
  renderBySpeed,
  renderDedup,
} from './_shared/claude-usage-breakdowns.mts'
import { isMainModule } from './_shared/is-main-module.mts'
import { runMain } from './_shared/run-main.mts'
import type { ScriptMeta } from './_shared/run-main.mts'

const logger = getDefaultLogger()

/**
 * The tier → palette slot map. `info` is the neutral slot while consumption is
 * ordinary, `warning` once the aim is passed and the reserve is carrying the
 * work, `error` at the ceiling. Semantic slots rather than a private colour
 * ramp, so the gauge matches every other Socket surface.
 */
export const TIER_PALETTE_SLOT: Readonly<
  Record<BudgetTierName, 'error' | 'info' | 'warning'>
> = {
  ceiling: 'error',
  stretch: 'warning',
  target: 'info',
}

/**
 * The measured window: local midnight on the 1st of `now`'s month through
 * `now`. Month-to-date because the budget's tiers are monthly.
 */
export interface SpendWindow {
  fromMs: number
  toMs: number
}

export function monthToDateWindow(now: Date): SpendWindow {
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  start.setHours(0, 0, 0, 0)
  return { fromMs: start.getTime(), toMs: now.getTime() }
}

/**
 * One model's measured usage and what it cost. `usd` is undefined when the
 * model has no price entry — never 0, which would read as "free".
 */
export interface ModelSpend {
  model: string
  sharePct: number
  totals: UsageTotals
  usd: number | undefined
}

export interface SpendSummary {
  models: ModelSpend[]
  pricedUsd: number
  requests: number
  unpricedRequests: number
  tokens: UsageTotals
}

/**
 * Cost every model in `scan` against the canonical pricing data. Models are
 * returned priced-first and descending by spend, so the biggest line is the
 * first one read.
 */
export function summarizeSpend(
  scan: UsageScan,
  pricing: PricingData,
): SpendSummary {
  const rows: ModelSpend[] = []
  let pricedUsd = 0
  let unpricedRequests = 0
  for (const [model, totals] of scan.byModel) {
    const found = findModelPricing(pricing, model)
    const cost = costUsage(
      totals,
      found?.model,
      found?.serviceEntry.multipliers ?? {},
    )
    if (cost) {
      pricedUsd += cost.totalUsd
    } else {
      unpricedRequests += totals.requests
    }
    rows.push({ model, sharePct: 0, totals, usd: cost?.totalUsd })
  }
  for (let i = 0, { length } = rows; i < length; i += 1) {
    const row = rows[i]!
    row.sharePct =
      row.usd === undefined || pricedUsd <= 0 ? 0 : (row.usd / pricedUsd) * 100
  }
  rows.sort(compareModelSpend)
  return {
    models: rows,
    pricedUsd,
    requests: scan.totals.requests,
    tokens: scan.totals,
    unpricedRequests,
  }
}

/**
 * Priced rows first, then by spend descending; unpriced rows fall to the end
 * ordered by request count so the largest gap is the first one named.
 */
export function compareModelSpend(a: ModelSpend, b: ModelSpend): number {
  if (a.usd === undefined && b.usd === undefined) {
    return b.totals.requests - a.totals.requests
  }
  if (a.usd === undefined) {
    return 1
  }
  if (b.usd === undefined) {
    return -1
  }
  return b.usd - a.usd
}

export function unpricedModels(summary: SpendSummary): ModelSpend[] {
  return summary.models.filter(row => row.usd === undefined)
}

/**
 * Everything the three presentation forms need. A required bag, so it is a
 * `config` rather than an `options` — the measurement is not optional.
 */
export interface PresentConfig {
  account?: AccountIdentity | undefined
  budget?: BudgetConfig | undefined
  budgetPaths?: readonly string[] | undefined
  color?: boolean | undefined
  // Carried on EVERY presentation, not behind a flag. Deduplication is part of
  // producing a figure, so its soundness is part of the figure: a reader must
  // not have to opt into a view to learn the reading rests on a broken key.
  dedup: DedupDiagnostics
  filesScanned?: number | undefined
  showAbsolute?: boolean | undefined
  summary: SpendSummary
  window: SpendWindow
}

/**
 * The one-line warning a reading carries when its own foundation is suspect.
 * Empty when sound, so a healthy report stays quiet.
 */
export function soundnessSuffix(dedup: DedupDiagnostics): string {
  if (dedupKeyIsSound(dedup)) {
    return ''
  }
  const direction =
    dedup.multiRequestMessageIds > 0 ? 'UNDERSTATES' : 'OVERSTATES'
  return ` · 🚨 dedup key unsound, total ${direction}`
}

/**
 * Paint only the gauge — the `[…]` run — leaving the glyph and the reading in
 * the terminal's own colour. The meter text itself is composed by the shared
 * library; this only tints what it produced, so there is one source of truth
 * for the string.
 */
export function paintMeterBar(
  meter: string,
  paint: (text: string) => string,
): string {
  const open = meter.indexOf('[')
  const close = open === -1 ? -1 : meter.indexOf(']', open + 1)
  if (open === -1 || close === -1) {
    return meter
  }
  return (
    meter.slice(0, open) +
    paint(meter.slice(open, close + 1)) +
    meter.slice(close + 1)
  )
}

/**
 * The one-line gas gauge: month-to-date spend against the tier the budget puts
 * it in. Returns the "no budget configured" verdict instead when there is no
 * budget file, since a gauge with no bar behind it would be fiction.
 */
export function formatStatusLine(config: PresentConfig): string {
  const cfg = { __proto__: null, ...config } as PresentConfig
  const { budget, summary } = cfg
  const unpriced = unpricedModels(summary)
  const suffix = `${
    unpriced.length
      ? ` · 🚨 ${unpriced.length} unpriced model(s), total is PARTIAL`
      : ''
  }${soundnessSuffix(cfg.dedup)}`
  if (!budget) {
    return `⛽ no budget configured · ${summary.requests} billed request(s) month-to-date${suffix}`
  }
  const meter = renderSpendMeter(
    summary.pricedUsd,
    budget,
    cfg.showAbsolute === true,
  )
  if (cfg.color !== true) {
    return `${meter}${suffix}`
  }
  const palette = getPalette('dark')
  const slot = TIER_PALETTE_SLOT[tierFor(summary.pricedUsd, budget)]
  return `${paintMeterBar(meter, palette[slot])}${suffix}`
}

function formatTokens(totals: UsageTotals): string {
  return (
    `${totals.input.toLocaleString()} fresh in · ` +
    `${totals.cacheWrite.toLocaleString()} cache write · ` +
    `${totals.cacheRead.toLocaleString()} cache read · ` +
    `${totals.output.toLocaleString()} out`
  )
}

function formatAccountLine(account: AccountIdentity): string {
  const billing = account.billingType ?? 'unknown'
  const seat = account.seatTier ? ` · seat ${account.seatTier}` : ''
  const spends = billsMarginalMoney(account)
    ? 'marginal money'
    : 'subscription headroom'
  return `account ${account.id} · billing ${billing}${seat} · spends ${spends}`
}

/**
 * The loud partial-total block. Named models plus the deterministic fix, so the
 * reader never has to guess why the figure looks low.
 */
export function formatUnpricedBlock(summary: SpendSummary): string[] {
  const unpriced = unpricedModels(summary)
  if (!unpriced.length) {
    return []
  }
  const share =
    summary.requests > 0
      ? Math.round((summary.unpricedRequests / summary.requests) * 100)
      : 0
  return [
    '',
    `🚨 PARTIAL TOTAL — ${unpriced.length} observed model(s) have no price entry.`,
    `   They carry ${summary.unpricedRequests.toLocaleString()} of ${summary.requests.toLocaleString()} billed requests (${share}%), so the reading above UNDERSTATES spend.`,
    ...unpriced.map(
      row =>
        `   unpriced: ${row.model} (${row.totals.requests.toLocaleString()} requests)`,
    ),
    '   Fix: re-source prices with `node scripts/fleet/update-model-pricing.mts`, then re-run this report.',
  ]
}

/**
 * The default multi-line report: the gauge, then what it was measured from.
 */
export function formatReport(config: PresentConfig): string[] {
  const cfg = { __proto__: null, ...config } as PresentConfig
  const { summary } = cfg
  const lines = [formatStatusLine(cfg)]
  lines.push(
    `window: ${new Date(cfg.window.fromMs).toISOString()} → ${new Date(cfg.window.toMs).toISOString()}`,
  )
  lines.push(
    `measured: ${summary.requests.toLocaleString()} deduplicated billed request(s) across ${cfg.filesScanned ?? 0} transcript(s)`,
  )
  lines.push(`tokens: ${formatTokens(summary.tokens)}`)
  if (cfg.budget) {
    lines.push(`tier: ${tierFor(summary.pricedUsd, cfg.budget)}`)
  } else {
    lines.push('budget: none found — looked in:')
    for (const candidate of cfg.budgetPaths ?? []) {
      lines.push(`  ${candidate}`)
    }
  }
  if (cfg.account) {
    lines.push(formatAccountLine(cfg.account))
  } else {
    lines.push('account: unreadable — spend cannot be attributed to a seat')
  }
  if (summary.models.length) {
    lines.push('by model:')
    for (const row of summary.models) {
      const share =
        row.usd === undefined
          ? 'UNPRICED'
          : `${row.sharePct.toFixed(1)}% of spend`
      lines.push(
        `  ${row.model}: ${row.totals.requests.toLocaleString()} request(s) · ${share}`,
      )
    }
  }
  lines.push(...formatUnpricedBlock(summary))
  return lines
}

/**
 * The machine-readable form. Absolute dollars appear only when they are allowed
 * to print; `absoluteWithheld` says so explicitly, so a consumer can tell a
 * withheld figure from a zero one.
 */
export function buildUsageJson(config: PresentConfig): Record<string, unknown> {
  const cfg = { __proto__: null, ...config } as PresentConfig
  const { budget, summary } = cfg
  const showAbsolute = cfg.showAbsolute === true
  const unpriced = unpricedModels(summary)
  return {
    account: cfg.account
      ? {
          billingType: cfg.account.billingType ?? undefined,
          billsMarginalMoney: billsMarginalMoney(cfg.account),
          id: cfg.account.id,
          seatTier: cfg.account.seatTier ?? undefined,
        }
      : undefined,
    budget: budget
      ? {
          configured: true,
          tier: tierFor(summary.pricedUsd, budget),
          warnEveryPct: budget.warnEveryPct,
          ...(showAbsolute
            ? {
                targetMonthly: budget.target.monthly,
                stretchMonthly: budget.stretch.monthly,
              }
            : {}),
        }
      : { configured: false, searchedPaths: [...(cfg.budgetPaths ?? [])] },
    filesScanned: cfg.filesScanned ?? 0,
    models: summary.models.map(row => ({
      model: row.model,
      priced: row.usd !== undefined,
      requests: row.totals.requests,
      sharePct: Number(row.sharePct.toFixed(2)),
      ...(showAbsolute && row.usd !== undefined ? { usd: row.usd } : {}),
    })),
    spend: {
      absoluteWithheld: !showAbsolute,
      totalIsPartial: unpriced.length > 0,
      ...(showAbsolute ? { pricedUsd: summary.pricedUsd } : {}),
    },
    status: formatStatusLine({ ...cfg, color: false }),
    tokens: summary.tokens,
    totalRequests: summary.requests,
    unpricedModels: unpriced.map(row => ({
      model: row.model,
      requests: row.totals.requests,
    })),
    window: {
      fromIso: new Date(cfg.window.fromMs).toISOString(),
      toIso: new Date(cfg.window.toMs).toISOString(),
    },
  }
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const asStatus = argv.includes('--status')
  const budgetPaths = budgetConfigPaths()
  const budget = await readBudgetConfig(budgetPaths)
  const window = monthToDateWindow(new Date())
  const scan = await scanUsage(window.fromMs, window.toMs)
  const summary = summarizeSpend(scan, loadPricing())
  const present: PresentConfig = {
    account: await readAccountIdentity(),
    budget,
    budgetPaths,
    dedup: scan.dedup,
    // Escape codes are noise in a transcript, so colour waits for a real
    // terminal — and never applies to the JSON form.
    color: !asJson && process.stdout.isTTY === true,
    filesScanned: scan.filesScanned,
    showAbsolute: argv.includes('--absolute') || !!budget?.printAbsoluteFigures,
    summary,
    window,
  }
  if (asJson) {
    logger.log(JSON.stringify(buildUsageJson(present), undefined, 2))
    return
  }
  // The summary answers "how much"; the breakdowns answer "where from". They
  // append to EITHER summary form rather than replacing it, so `--status
  // --dedup` prints both instead of silently dropping the view.
  logger.log(
    asStatus ? formatStatusLine(present) : formatReport(present).join('\n'),
  )
  // Opt-in per view: printing all four every run buries the verdict.
  const pricing = loadPricing()
  const anthropic = pricing.services?.['anthropic']
  const models = anthropic?.models ?? {}
  const multipliers = anthropic?.multipliers ?? {}
  const breakdown = { showAbsolute: present.showAbsolute }
  const views: Array<[string, () => string[]]> = [
    [
      '--by-project',
      () => renderByProject(scan, models, multipliers, breakdown),
    ],
    ['--by-day', () => renderByDay(scan, models, multipliers, breakdown)],
    ['--by-speed', () => renderBySpeed(scan, models, multipliers, breakdown)],
    ['--dedup', () => renderDedup(scan)],
  ]
  for (const [flag, render] of views) {
    if (argv.includes(flag)) {
      logger.log('')
      logger.log(render().join('\n'))
    }
  }
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'report month-to-date Claude spend against the machine-local budget as a gas gauge',
  help: `Usage: node scripts/fleet/report-claude-usage.mts [flags]
  --status      print only the one-line token spend meter
  --json        print the report as machine-readable JSON
  --absolute    opt in to printing dollar figures (default: percentages + tier names)
  --by-project  append spend per project (base rate)
  --by-day      append the daily series, which shows when a lever was active
  --by-speed    append standard/fast/unset, with fast priced as a band
  --dedup       append the dedup diagnostics every cost figure rests on

Colour is applied only when stdout is a TTY, because this output can land in a
session transcript where escape codes are noise. The budget is the machine-local
one resolved by budgetConfigPaths(), or $SOCKET_USAGE_BUDGET; with no budget file
the report says "no budget configured" rather than inventing a ceiling. Run it
with no flags to see which paths were searched.`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
