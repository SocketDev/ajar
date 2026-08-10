#!/usr/bin/env node
/*
 * @file Fleet check - the dedup key still identifies ONE billed request.
 *   Every spend figure this fleet produces rests on one assumption: that
 *   `message.id + requestId` names exactly one billed request, so a transcript
 *   record carrying the same pair is a copy rather than a second charge. That
 *   assumption is load-bearing and large. Measured over a 30-day window,
 *   753,479 records collapsed to 349,193 keys - 53.7% of records are copies,
 *   because a sidechain, a resume, and a compaction all re-emit the same
 *   assistant message. Counting raw records instead nearly doubles the bill,
 *   which is exactly the error that made a first pass read 72% high.
 *   The assumption can break in two directions, and both break SILENTLY:
 *
 *   - a record with neither id cannot be deduplicated at all, so it is counted
 *     as-is and may be a double-count (over-states);
 *   - a `message.id` appearing under more than one `requestId` would mean a retry
 *     bills separately, so merging them discards a real charge (under-states).
 *     Neither shows up as a wrong-looking number. Both are currently at zero,
 *     and nothing else would notice if that changed - a transcript-format
 *     change ships with a Claude Code release, not with a commit here. So this
 *     gate reads the counters the shared scanner already keeps and fails when
 *     either leaves zero, naming which direction the error runs. NOTHING
 *     measured here is written down. Output is record counts and percentages,
 *     never a dollar figure and never a project name: usage stays
 *     machine-local, the same contract model-pricing.json states for org
 *     budgets. A machine with no transcripts (CI, a fresh checkout) measures
 *     nothing, so it SKIPS loudly rather than passing vacuously. Usage: node
 *     scripts/fleet/check/usage-dedup-key-is-sound.mts [--days <n>] [--json]
 *     [--quiet].
 */

import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { dedupKeyIsSound, scanUsage } from '../_shared/claude-usage.mts'
import { isMainModule } from '../_shared/is-main-module.mts'
import { isJsonRequested, runMain } from '../_shared/run-main.mts'

import type { DedupDiagnostics } from '../_shared/claude-usage.mts'
import type { ScriptMeta } from '../_shared/run-main.mts'

const logger = getDefaultLogger()

export const MS_PER_DAY = 86_400_000

/**
 * How far back a run looks. Short on purpose: a format change would appear in
 * the newest records, and a wide scan buys nothing a narrow one misses while
 * costing every check run more.
 */
export const DEDUP_WINDOW_DAYS = 3

export interface DedupSoundnessResult {
  dedup: DedupDiagnostics
  duplicateShare: number
  filesScanned: number
  skipped?: 'no-transcripts' | undefined
  windowDays: number
}

export function resolveWindowDays(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEDUP_WINDOW_DAYS
}

export function flagValue(
  argv: readonly string[],
  flag: string,
): string | undefined {
  const index = argv.indexOf(flag)
  if (index >= 0 && index + 1 < argv.length) {
    return argv[index + 1]
  }
  const prefixed = argv.find(arg => arg.startsWith(`${flag}=`))
  return prefixed ? prefixed.slice(flag.length + 1) : undefined
}

export interface MeasureOptions {
  nowMs?: number | undefined
}

export async function measureDedupSoundness(
  windowDays: number,
  options?: MeasureOptions | undefined,
): Promise<DedupSoundnessResult> {
  const opts = { __proto__: null, ...options } as MeasureOptions
  const now = opts.nowMs ?? Date.now()
  const scan = await scanUsage(now - windowDays * MS_PER_DAY, now)
  if (scan.dedup.recordsSeen === 0) {
    return {
      dedup: scan.dedup,
      duplicateShare: 0,
      filesScanned: scan.filesScanned,
      skipped: 'no-transcripts',
      windowDays,
    }
  }
  return {
    dedup: scan.dedup,
    duplicateShare: scan.dedup.duplicatesDropped / scan.dedup.recordsSeen,
    filesScanned: scan.filesScanned,
    windowDays,
  }
}

/**
 * The failure text. Names the DIRECTION of the resulting error, because that is
 * what tells a reader whether a published figure was too high or too low.
 */
export function renderSoundnessReport(result: DedupSoundnessResult): string {
  const { dedup } = result
  const lines: string[] = []
  lines.push(
    `What:   the billed-request dedup key no longer identifies one charge.`,
    `Where:  local session transcripts, last ${result.windowDays} day(s), ${result.filesScanned} file(s).`,
  )
  if (dedup.keylessRecords > 0) {
    lines.push(
      `Saw:    ${dedup.keylessRecords} record(s) with neither message.id nor requestId.`,
      `        These cannot be deduplicated, so they are counted as-is and every`,
      `        total OVER-states by however many are copies.`,
    )
  }
  if (dedup.multiRequestMessageIds > 0) {
    lines.push(
      `Saw:    ${dedup.multiRequestMessageIds} message.id(s) under more than one requestId.`,
      `        A retry now bills separately, so merging them DISCARDS real charges`,
      `        and every total UNDER-states.`,
    )
  }
  lines.push(
    `Wanted: both counters at zero, which is what the model was calibrated on.`,
    `Fix:    do not adjust a figure to compensate. Establish the new identity of a`,
    `        billed request first, change usageKey in _shared/claude-usage.mts to`,
    `        match, then re-derive the calibration factor against a known cash`,
    `        figure. Every spend number published before this fires is suspect.`,
  )
  return lines.join('\n')
}

export interface ReportOptions {
  json?: boolean | undefined
  quiet?: boolean | undefined
}

export function reportSoundness(
  result: DedupSoundnessResult,
  options?: ReportOptions | undefined,
): void {
  const opts = { __proto__: null, ...options } as ReportOptions
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`)
    return
  }
  if (result.skipped === 'no-transcripts') {
    logger.log(
      `[usage-dedup-key-is-sound] SKIPPED: no local session transcripts in the last ${result.windowDays} day(s), so nothing was measured. This is not a pass.`,
    )
    return
  }
  if (!dedupKeyIsSound(result.dedup)) {
    logger.fail('[usage-dedup-key-is-sound] the dedup key is no longer sound.')
    logger.error(renderSoundnessReport(result))
    return
  }
  if (!opts.quiet) {
    const share = (result.duplicateShare * 100).toFixed(1)
    logger.success(
      `[usage-dedup-key-is-sound] key holds over ${result.dedup.recordsSeen} record(s) in the last ${result.windowDays} day(s): ${share}% were copies, 0 keyless, 0 split across requests.`,
    )
  }
}

export async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const result = await measureDedupSoundness(
    resolveWindowDays(flagValue(argv, '--days')),
  )
  reportSoundness(result, {
    json: isJsonRequested(argv),
    quiet: argv.includes('--quiet'),
  })
  return result.skipped === undefined && !dedupKeyIsSound(result.dedup) ? 1 : 0
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'checks the billed-request dedup key still identifies exactly one charge',
  help: `Usage: node scripts/fleet/check/usage-dedup-key-is-sound.mts [flags]

  --days <n>  lookback window in days (default: ${DEDUP_WINDOW_DAYS})
  --json      emit the measurement as JSON instead of prose
  --quiet     suppress the pass message`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
