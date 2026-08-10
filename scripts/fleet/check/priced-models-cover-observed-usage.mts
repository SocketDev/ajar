#!/usr/bin/env node
/**
 * @file Fleet check - the priced model set COVERS the models actually billed on
 *   this machine. `pricing-data-is-current` gates the snapshot's AGE, which is
 *   a different question: a snapshot can be one day old and still carry no
 *   entry for the model doing most of the work, because a refresh only
 *   re-prices the ids already in the file. That hole is not theoretical.
 *   Measured 2026-08-09 against a 2026-07-25 snapshot, the two ids serving the
 *   majority of local requests had no entry at all, so every cost figure over
 *   that traffic read as exactly zero and nothing went red. The gate closes it
 *   from the other direction: read what the machine ACTUALLY billed out of the
 *   local session transcripts, then require each of those models to resolve to
 *   a usable price. Transcript scanning + billed-request dedup come from
 *   `_shared/claude-usage.mts` (one scanner, shared with the spend tracker) and
 *   price resolution from `estimate-ai-cost.mts`'s `findModelPricing`, so this
 *   check can never disagree with the estimator about whether a model is
 *   priced. Two shapes count as a gap: an id no service carries (`unpriced`),
 *   and an id with an entry but no per-token rates (`rateless`). A plan-billed
 *   entry is covered rather than rateless: an absent rate is that entry's
 *   answer, not a hole. `<synthetic>` and `unknown` are the transcript's own
 *   markers for a record that never went to a vendor, so they are never billed
 *   and never demanded. NOTHING measured here is ever written down. The output
 *   names model ids and request counts, never a dollar figure, and the check
 *   writes no file: usage and spend stay machine-local, same contract
 *   model-pricing.json states for org budgets. Runs on the release/CI tier
 *   because a 7-day scan reads thousands of transcript files, which is not an
 *   inner-loop cost. A machine with no transcripts (CI, a fresh checkout)
 *   measures nothing, so it SKIPS loudly rather than passing vacuously. Usage:
 *   node scripts/fleet/check/priced-models-cover-observed-usage.mts [--days
 *   <n>] [--json] [--quiet].
 */

import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { findModelPricing, loadPricing } from '../estimate-ai-cost.mts'
import { scanUsage } from '../_shared/claude-usage.mts'
import { isMainModule } from '../_shared/is-main-module.mts'
import { isJsonRequested, runMain } from '../_shared/run-main.mts'

import type { PricingData } from '../estimate-ai-cost.mts'
import type { UsageTotals } from '../_shared/claude-usage.mts'
import type { ScriptMeta } from '../_shared/run-main.mts'

const logger = getDefaultLogger()

export const MS_PER_DAY = 86_400_000

/**
 * How far back a run looks. Matched to the weekly `updating` cadence that
 * refreshes the pricing data, so the gate reads as "every model billed since
 * the last refresh is priced" rather than an arbitrary window.
 */
export const OBSERVED_WINDOW_DAYS = 7

/**
 * The model field a transcript writes when the record never went to a vendor:
 * `<synthetic>` for a locally generated assistant message, `unknown` for a
 * record carrying no model at all. Neither is billed, so neither is owed a
 * price.
 */
export const NON_BILLED_MODELS: ReadonlySet<string> = new Set([
  '<synthetic>',
  'unknown',
])

/**
 * Where a reader goes to fix a gap. In the wheelhouse the live copy is
 * cascade-generated, so the canonical path is named too.
 */
export const PRICING_FILE = 'scripts/fleet/constants/model-pricing.json'

export type CoverageGap = 'rateless' | 'unpriced'

export const GAP_REASON_TEXT: Readonly<Record<CoverageGap, string>> = {
  rateless: 'has an entry, but no inputPerMtok/outputPerMtok rate',
  unpriced: 'has no entry in any service',
}

export interface ModelCoverageGap {
  model: string
  reason: CoverageGap
  requests: number
}

export type CoverageSkip = 'no-pricing-data' | 'no-transcripts'

export interface CoverageResult {
  filesScanned: number
  gaps: ModelCoverageGap[]
  observedModels: number
  skipped: CoverageSkip | undefined
  windowDays: number
}

/**
 * Read the value after `name` in argv, or undefined when the flag is absent.
 */
export function flagValue(
  argv: readonly string[],
  name: string,
): string | undefined {
  const i = argv.indexOf(name)
  return i !== -1 ? argv[i + 1] : undefined
}

/**
 * The lookback window in whole days. An absent, unparseable, or non-positive
 * `--days` value falls back to the default rather than scanning nothing, since
 * a zero window would pass while measuring no usage at all.
 */
export function resolveWindowDays(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : OBSERVED_WINDOW_DAYS
}

/**
 * Why this model's usage cannot be costed, or undefined when it can. Resolution
 * goes through the estimator's own `findModelPricing`, so an alias or a
 * `<service>/<model>` form resolves here exactly as it does when a cost is
 * computed.
 */
export function classifyModelCoverage(
  pricing: PricingData,
  model: string,
): CoverageGap | undefined {
  const found = findModelPricing(pricing, model)
  if (!found) {
    return 'unpriced'
  }
  const { billing, inputPerMtok, outputPerMtok } = found.model
  if (inputPerMtok !== undefined && outputPerMtok !== undefined) {
    return undefined
  }
  // A plan-billed model has no marginal per-token cost by declaration, so the
  // absent rate is that entry's answer rather than a missing number.
  if (billing) {
    return undefined
  }
  return 'rateless'
}

/**
 * Every observed model whose usage cannot be costed, busiest first, so the
 * biggest hole reads at the top of the report.
 */
export function modelCoverageGaps(
  pricing: PricingData,
  byModel: ReadonlyMap<string, UsageTotals>,
): ModelCoverageGap[] {
  const gaps: ModelCoverageGap[] = []
  for (const [model, totals] of byModel) {
    if (NON_BILLED_MODELS.has(model)) {
      continue
    }
    const reason = classifyModelCoverage(pricing, model)
    if (reason) {
      gaps.push({ model, reason, requests: totals.requests })
    }
  }
  return gaps.toSorted((a, b) => b.requests - a.requests)
}

export interface CoverageScanConfig {
  now?: number | undefined
  pricing: PricingData
  transcriptRoot?: string | undefined
  windowDays: number
}

/**
 * Scan the local transcripts for the window and classify every model found.
 * `now` and `transcriptRoot` are injected so a test drives the whole measure
 * over a scratch tree at a fixed clock; a real run takes both defaults.
 */
export async function measureModelCoverage(
  config: CoverageScanConfig,
): Promise<CoverageResult> {
  const opts = { __proto__: null, ...config } as CoverageScanConfig
  const { windowDays } = opts
  const toMs = opts.now ?? Date.now()
  const fromMs = toMs - windowDays * MS_PER_DAY
  const scan =
    opts.transcriptRoot === undefined
      ? await scanUsage(fromMs, toMs)
      : await scanUsage(fromMs, toMs, opts.transcriptRoot)
  if (scan.filesScanned === 0) {
    return {
      filesScanned: 0,
      gaps: [],
      observedModels: 0,
      skipped: 'no-transcripts',
      windowDays,
    }
  }
  return {
    filesScanned: scan.filesScanned,
    gaps: modelCoverageGaps(opts.pricing, scan.byModel),
    observedModels: scan.byModel.size,
    skipped: undefined,
    windowDays,
  }
}

export interface CoverageReportOptions {
  windowDays?: number | undefined
}

/**
 * The failure body: what broke, where it is fixed, each unpriced id beside its
 * request count, the shape wanted, and the one command that lands a price.
 */
export function renderCoverageReport(
  gaps: readonly ModelCoverageGap[],
  options?: CoverageReportOptions | undefined,
): string {
  const opts = { __proto__: null, ...options } as CoverageReportOptions
  const windowDays = opts.windowDays ?? OBSERVED_WINDOW_DAYS
  const width = gaps.reduce((widest, gap) => {
    return Math.max(widest, gap.model.length)
  }, 0)
  const lines = [
    `  What:  ${gaps.length} model(s) billed in the last ${windowDays} day(s) have no usable price, so every cost figure over that traffic reads as zero.`,
    `  Where: ${PRICING_FILE} (services.*.models); in the wheelhouse edit template/base/${PRICING_FILE} and cascade.`,
    '  Saw:',
  ]
  for (const gap of gaps) {
    lines.push(
      `           ${gap.model.padEnd(width)}  ${gap.requests} request(s), ${GAP_REASON_TEXT[gap.reason]}`,
    )
  }
  lines.push(
    '  Wanted: every model a local transcript names resolves to an entry carrying inputPerMtok and outputPerMtok.',
    "  Fix:   run /update-pricing. Read each id's current rate off its service's",
    '         pricingSource, then land it through the script that owns the write:',
    '           node scripts/fleet/update-model-pricing.mts --service <id> \\',
    `             --prices '{"<model-id>":{"inputPerMtok":<n>,"outputPerMtok":<n>}}'`,
    '         Never hand-type a rate you did not read this run, and never hand-edit',
    '         the JSON: a guessed price makes every budget figure wrong silently,',
    '         where a missing one at least goes red here.',
  )
  return lines.join('\n')
}

export async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const quiet = argv.includes('--quiet')
  const json = isJsonRequested(argv)
  const windowDays = resolveWindowDays(flagValue(argv, '--days'))

  // Cheapest read first: a repo carrying no pricing data has nothing to cover,
  // so it never pays for the transcript scan.
  let pricing: PricingData
  try {
    pricing = loadPricing()
  } catch {
    const result: CoverageResult = {
      filesScanned: 0,
      gaps: [],
      observedModels: 0,
      skipped: 'no-pricing-data',
      windowDays,
    }
    reportCoverage(result, { json, quiet })
    return 0
  }

  const result = await measureModelCoverage({ pricing, windowDays })
  reportCoverage(result, { json, quiet })
  return result.gaps.length ? 1 : 0
}

export interface ReportOptions {
  json?: boolean | undefined
  quiet?: boolean | undefined
}

/**
 * Print one measurement. A skip says what it measured nothing for, so a green
 * run is never mistaken for a verified one.
 */
export function reportCoverage(
  result: CoverageResult,
  options?: ReportOptions | undefined,
): void {
  const opts = { __proto__: null, ...options } as ReportOptions
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`)
    return
  }
  if (result.skipped === 'no-pricing-data') {
    if (!opts.quiet) {
      logger.log(
        `[priced-models-cover-observed-usage] no ${PRICING_FILE} here - nothing to cover.`,
      )
    }
    return
  }
  if (result.skipped === 'no-transcripts') {
    logger.log(
      `[priced-models-cover-observed-usage] SKIPPED: no local session transcripts in the last ${result.windowDays} day(s), so no usage was measured. This is not a pass.`,
    )
    return
  }
  if (result.gaps.length) {
    logger.fail(
      '[priced-models-cover-observed-usage] a model in active use has no usable price.',
    )
    logger.error(
      renderCoverageReport(result.gaps, {
        windowDays: result.windowDays,
      }),
    )
    return
  }
  if (!opts.quiet) {
    logger.success(
      `[priced-models-cover-observed-usage] all ${result.observedModels} model(s) billed in the last ${result.windowDays} day(s) are priced (${result.filesScanned} transcript(s) read).`,
    )
  }
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'checks every model billed in recent local transcripts has a usable price entry',
  help: `Usage: node scripts/fleet/check/priced-models-cover-observed-usage.mts [flags]

  --days <n>  lookback window in days (default: ${OBSERVED_WINDOW_DAYS})
  --json      emit the measurement as JSON instead of prose
  --quiet     suppress the pass message`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
