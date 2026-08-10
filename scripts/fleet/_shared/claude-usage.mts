/*
 * @file Measure real Claude spend from local session transcripts and compare it
 *   against the machine-local budget. Pure measurement + arithmetic; callers
 *   own I/O policy and presentation. Two contracts this file exists to hold:
 *
 *   1. BILLED REQUESTS ARE DEDUPLICATED. A transcript can carry the same assistant
 *      message more than once (sidechains, resumes, compaction copies).
 *      Counting raw turns overstates spend badly - measured against one window
 *      it inflated the request count until dedup on `message.id + requestId`
 *      brought it to within 0.4% of the audited figure. Every counter here goes
 *      through `usageKey`.
 *   2. NO BUDGET FIGURE LIVES IN GIT. The bar and the emergency reserve are read
 *      from a machine-local file outside any repository, resolved ONLY by
 *      `budgetConfigPaths` below - do not repeat that path anywhere else, in
 *      code or prose, because a second copy has already drifted twice. The
 *      committed side carries the mechanism only, matching the same contract
 *      the canonical pricing data states for org budgets and usage.
 *   3. WHOSE SPEND IT IS MATTERS. Whether a figure is real money or subscription
 *      headroom depends on the signed-in seat, so the seat is read at runtime
 *      via `readAccountIdentity` rather than assumed here. An unknown seat is
 *      treated as billing real money, which is the safe direction. Costing
 *      follows the vendor model in `constants/model-pricing.json`: fresh input
 *      at the base rate, cache writes at the 5m/1h write multiplier, cache
 *      reads at the read multiplier, output at the output rate. Fast mode is a
 *      flat multiplier on both sides. A model with no price entry is never
 *      silently treated as free; the caller sees it is unpriced and decides
 *      whether to fail.
 */

import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

export interface ModelRate {
  inputPerMtok?: number | undefined
  outputPerMtok?: number | undefined
}

export interface CacheMultipliers {
  cacheRead?: number | undefined
  cacheWrite1h?: number | undefined
  cacheWrite5m?: number | undefined
}

export interface UsageTotals {
  cacheRead: number
  /**
   * ALL cache-creation tokens, both TTLs.
   */
  cacheWrite: number
  /**
   * The portion of `cacheWrite` written with a ONE-HOUR TTL, which bills at a
   * higher multiplier than the 5-minute default (2x vs 1.25x of base input).
   *
   * Optional so existing literals still typecheck; absent means "all 5-minute",
   * which is the cheaper reading, so a caller that never populates it
   * under-states rather than over-states.
   *
   * This was measured wrong once and it was not small: collapsing both TTLs
   * into one counter and pricing the lot at the 5-minute rate understated a
   * 30-day base total by $3,328, or 4.2%, because 27.2% of write tokens were
   * 1-hour.
   */
  cacheWrite1h?: number | undefined
  input: number
  output: number
  requests: number
}

export interface ModelSpeedTotals extends UsageTotals {
  model: string
  speed: string
}

/**
 * Soundness of the dedup key, carried on every scan rather than checked once.
 *
 * The whole cost model rests on `message.id + requestId` identifying one BILLED
 * request. Two ways that can break, both silent:
 *
 * - A record with neither id cannot be deduplicated, so it is counted as-is and
 *   may be a double-count;
 * - A `message.id` appearing under MORE than one `requestId` would mean retries
 *   bill separately, and merging them would UNDER-count.
 *
 * Measured on a 30-day window: 753,479 records collapsed to 349,193 keys, 53.7%
 * duplicates, with zero keyless records and zero multi-request message ids.
 * Both counters must stay at zero; `usage-dedup-key-is-sound` gates that.
 */
export interface DedupDiagnostics {
  duplicatesDropped: number
  keylessRecords: number
  multiRequestMessageIds: number
  recordsSeen: number
}

export interface UsageScan {
  byModel: Map<string, UsageTotals>
  // Keyed by project slug, so cost is attributable across projects rather than
  // only in aggregate.
  byProject: Map<string, UsageTotals>
  dedup: DedupDiagnostics
  // Keyed `<model>|<speed>`. Costing MUST go through this rather than byModel:
  // a fast-mode request bills at a multiple of the base rate, so a model whose
  // traffic is part fast and part standard cannot be priced from one bucket.
  byModelSpeed: Map<string, ModelSpeedTotals>
  // Keyed by UTC date. A lever that was only switched on for part of a window
  // has to be rated over the days it was ACTIVE; averaging across the whole
  // window understated two real levers by 30-48% when measured.
  byDay: Map<string, UsageTotals>
  filesScanned: number
  totals: UsageTotals
}

export interface CostBreakdown {
  cacheReadUsd: number
  cacheWriteUsd: number
  inputUsd: number
  outputUsd: number
  totalUsd: number
}

export interface BudgetTier {
  daily: number | undefined
  monthly: number
}

export interface BudgetConfig {
  ceiling: BudgetTier | undefined
  emergencyPerGrant: number
  emergencyReserve: number
  emergencyTtlMinutes: number
  // Default false: tool output lands in the session transcript, so a tracker
  // that prints the bar every turn writes the budget into thousands of files.
  // Callers emit percentages and tier names unless this is explicitly on.
  printAbsoluteFigures: boolean
  stretch: BudgetTier
  target: BudgetTier
  warnEveryPct: number
}

export type BudgetTierName = 'ceiling' | 'stretch' | 'target'

/**
 * Which signed-in account spend belongs to. Two accounts can bill completely
 * differently for identical token usage - a metered/overage seat spends real
 * dollars where a flat quota seat spends headroom - so mixing them corrupts
 * both figures. `id` is a short digest rather than the raw account UUID so a
 * ledger or a shared report never carries the identity itself.
 */
export interface AccountIdentity {
  billingType: string | undefined
  id: string
  seatTier: string | undefined
}

/**
 * Per-account budget, since a Team-with-overage seat and a flat-quota seat need
 * different tiers. `accountId` is matched against {@link AccountIdentity.id}.
 */
export interface AccountBudget {
  accountId: string | undefined
  billing: string | undefined
  label: string
}

/**
 * Where the budget may live, in resolution order. Both are outside any git
 * repository by design; the fleet home wins so one file can govern every fleet
 * tool rather than only Claude Code.
 */
export function budgetConfigPaths(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const explicit = env['SOCKET_USAGE_BUDGET']
  const paths = explicit ? [explicit] : []
  // `_state` is the fleet home's durable-private-config store, alongside the
  // repo roster. Not `_wheelhouse`, which holds clones and binaries, and not the
  // home root, where a loose file breaks the underscore-store convention.
  paths.push(path.join(os.homedir(), '.socket', '_state', 'usage-budget.json'))
  return paths
}

const TRANSCRIPT_ROOT = path.join(os.homedir(), '.claude', 'projects')

// A line without this substring cannot carry a usage record, so skipping it
// avoids a JSON.parse on the overwhelming majority of transcript lines.
const USAGE_HINT = '"output_tokens"'

export function emptyDedupDiagnostics(): DedupDiagnostics {
  return {
    duplicatesDropped: 0,
    keylessRecords: 0,
    multiRequestMessageIds: 0,
    recordsSeen: 0,
  }
}

/**
 * Whether the dedup key still identifies one billed request. Both counters must
 * be zero; either being non-zero means every cost figure derived from this scan
 * is wrong in a known direction.
 */
export function dedupKeyIsSound(dedup: DedupDiagnostics): boolean {
  return dedup.keylessRecords === 0 && dedup.multiRequestMessageIds === 0
}

export function emptyTotals(): UsageTotals {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    input: 0,
    output: 0,
    requests: 0,
  }
}

/**
 * Identity of one BILLED request. Returns undefined when neither id is present,
 * which means the record cannot be deduplicated and must be counted as-is.
 */
export function usageKey(
  messageId: string | undefined,
  requestId: string | undefined,
): string | undefined {
  if (!messageId && !requestId) {
    return undefined
  }
  return `${messageId ?? ''}|${requestId ?? ''}`
}

export function addUsage(into: UsageTotals, from: Partial<UsageTotals>): void {
  into.cacheRead += from.cacheRead ?? 0
  into.cacheWrite += from.cacheWrite ?? 0
  into.cacheWrite1h = (into.cacheWrite1h ?? 0) + (from.cacheWrite1h ?? 0)
  into.input += from.input ?? 0
  into.output += from.output ?? 0
  into.requests += from.requests ?? 0
}

/**
 * Cost one model's totals. `fastModeMultiplier` scales both sides, matching how
 * fast mode is billed. Returns undefined when the model has no price, so the
 * caller decides whether that is a hard failure.
 */
export function costUsage(
  totals: UsageTotals,
  rate: ModelRate | undefined,
  multipliers: CacheMultipliers,
  fastModeMultiplier = 1,
): CostBreakdown | undefined {
  if (
    !rate ||
    rate.inputPerMtok === undefined ||
    rate.outputPerMtok === undefined
  ) {
    return undefined
  }
  const inputRate = rate.inputPerMtok * fastModeMultiplier
  const outputRate = rate.outputPerMtok * fastModeMultiplier
  const inputUsd = (totals.input / 1e6) * inputRate
  // Each TTL at its own rate. Clamped because `cacheWrite1h` is a SUBSET of
  // `cacheWrite`, and a caller passing a larger part than the whole would
  // otherwise price phantom tokens.
  const write1h = Math.min(
    Math.max(totals.cacheWrite1h ?? 0, 0),
    totals.cacheWrite,
  )
  const write5m = totals.cacheWrite - write1h
  const cacheWriteUsd =
    (write5m / 1e6) * inputRate * (multipliers.cacheWrite5m ?? 1) +
    (write1h / 1e6) *
      inputRate *
      (multipliers.cacheWrite1h ?? multipliers.cacheWrite5m ?? 1)
  const cacheReadUsd =
    (totals.cacheRead / 1e6) * inputRate * (multipliers.cacheRead ?? 1)
  const outputUsd = (totals.output / 1e6) * outputRate
  return {
    cacheReadUsd,
    cacheWriteUsd,
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + cacheWriteUsd + cacheReadUsd + outputUsd,
  }
}

/**
 * Which 5%-style bucket a spend figure sits in. Used so a crossing warns
 * exactly once: a caller stores the last bucket it announced and compares.
 */
export function budgetBucket(
  spentUsd: number,
  barUsd: number,
  everyPct: number,
): number {
  if (barUsd <= 0 || everyPct <= 0) {
    return 0
  }
  return Math.floor(((spentUsd / barUsd) * 100) / everyPct)
}

function readTier(
  tiers: Record<string, unknown>,
  name: BudgetTierName,
): BudgetTier | undefined {
  const raw = tiers[name]
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }
  const record = raw as Record<string, unknown>
  const monthly = record['monthly']
  if (
    typeof monthly !== 'number' ||
    !Number.isFinite(monthly) ||
    monthly <= 0
  ) {
    return undefined
  }
  const daily = record['daily']
  return {
    daily: typeof daily === 'number' && daily > 0 ? daily : undefined,
    monthly,
  }
}

export function parseBudgetConfig(raw: string): BudgetConfig {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TypeError('budget config is not an object')
  }
  const record = parsed as Record<string, unknown>
  const tiers = (record['tiers'] ?? {}) as Record<string, unknown>
  const reserve = (record['emergencyReserve'] ?? {}) as Record<string, unknown>
  const privacy = (record['privacy'] ?? {}) as Record<string, unknown>
  const target = readTier(tiers, 'target')
  const stretch = readTier(tiers, 'stretch')
  if (!target || !stretch) {
    throw new TypeError(
      'budget config needs tiers.target.monthly and tiers.stretch.monthly',
    )
  }
  const warnEveryPct = record['warnEveryPct']
  return {
    ceiling: readTier(tiers, 'ceiling'),
    emergencyPerGrant:
      typeof reserve['perGrant'] === 'number' ? reserve['perGrant'] : 0,
    emergencyReserve:
      typeof reserve['monthly'] === 'number' ? reserve['monthly'] : 0,
    emergencyTtlMinutes:
      typeof reserve['ttlMinutes'] === 'number' ? reserve['ttlMinutes'] : 0,
    printAbsoluteFigures: privacy['printAbsoluteFigures'] === true,
    stretch,
    target,
    warnEveryPct:
      typeof warnEveryPct === 'number' && warnEveryPct > 0 ? warnEveryPct : 5,
  }
}

/**
 * Which tier a spend figure has reached. `target` while under the aim,
 * `stretch` once past it, `ceiling` once past the cap — the last of which is an
 * incident rather than a budget state.
 */
export function tierFor(
  spentUsd: number,
  config: BudgetConfig,
): BudgetTierName {
  if (spentUsd >= config.stretch.monthly) {
    return 'ceiling'
  }
  if (spentUsd >= config.target.monthly) {
    return 'stretch'
  }
  return 'target'
}

const METER_WIDTH = 20
const METER_TICKS = '   E    ¼    ½    ¾    F'

// Gauge glyph escalates with the tier so severity is readable without parsing
// the number: fuel while under the aim, warning once the cap is crossed and the
// emergency reserve is carrying the work, critical at the ceiling.
const METER_GLYPH: Record<BudgetTierName, string> = {
  ceiling: '🚨',
  stretch: '⚠️',
  target: '⛽',
}

export function meterGlyphFor(tier: BudgetTierName): string {
  return METER_GLYPH[tier]
}

/**
 * Fraction of a tier consumed, clamped to 0..1.
 */
export function meterFraction(spentUsd: number, againstUsd: number): number {
  if (againstUsd <= 0) {
    return 0
  }
  return Math.max(0, Math.min(1, spentUsd / againstUsd))
}

// Shade ramp for the partial cell, darkest-last: an empty cell reads ░, a
// filled one █, and the two mid shades give a 5% move somewhere visible to land
// instead of rounding away at statusline width.
const METER_EMPTY = '░'
const METER_FULL = '█'
const METER_PARTIAL_LOW = '▒'
const METER_PARTIAL_HIGH = '▓'

/**
 * The gauge bar alone: a fuel gauge reads how much is LEFT, so it drains as
 * spend rises.
 */
export function renderMeterBar(
  remainingFraction: number,
  width = METER_WIDTH,
): string {
  const filled = Math.max(0, Math.min(width, remainingFraction * width))
  const whole = Math.floor(filled)
  const remainder = filled - whole
  let partial = ''
  if (whole < width) {
    if (remainder >= 0.66) {
      partial = METER_PARTIAL_HIGH
    } else if (remainder >= 0.33) {
      partial = METER_PARTIAL_LOW
    }
  }
  const empty = width - whole - (partial ? 1 : 0)
  return `[${METER_FULL.repeat(whole)}${partial}${METER_EMPTY.repeat(empty)}]`
}

/**
 * The token spend meter. Percentages and tier names only unless the budget
 * explicitly allows absolute figures: this string is safe to screen-share, and
 * it lands in the session transcript, which is exactly what the spend scanner
 * reads — a meter that printed the bar every turn would write the budget into
 * thousands of files.
 */
export function renderSpendMeter(
  spentUsd: number,
  config: BudgetConfig,
  showAbsolute = config.printAbsoluteFigures,
): string {
  const tier = tierFor(spentUsd, config)
  const against =
    tier === 'target' ? config.target.monthly : config.stretch.monthly
  const used = meterFraction(spentUsd, against)
  const bar = renderMeterBar(1 - used)
  const amount = showAbsolute ? ` ${Math.round(spentUsd)}/${against}` : ''
  const label = tier === 'stretch' ? 'reserve' : tier
  return `${meterGlyphFor(tier)} ${bar} ${Math.round((1 - used) * 100)}% left · ${label}${amount}`
}

/**
 * Two-line form for a wider surface (CLI, report page): the gauge over its
 * E/¼/½/¾/F scale, mirroring a physical fuel gauge's markings.
 */
export function renderSpendMeterWide(
  spentUsd: number,
  config: BudgetConfig,
  showAbsolute = config.printAbsoluteFigures,
): string {
  return `${renderSpendMeter(spentUsd, config, showAbsolute)}\n${METER_TICKS}`
}

/**
 * Read the machine-local budget. Returns undefined when absent so a caller can
 * report "no budget configured" as its own distinct verdict rather than
 * inventing a default ceiling nobody agreed to.
 */
export async function readBudgetConfig(
  candidates = budgetConfigPaths(),
): Promise<BudgetConfig | undefined> {
  for (const candidate of candidates) {
    let raw
    try {
      raw = await readFile(candidate, 'utf8')
    } catch {
      continue
    }
    // A present-but-malformed budget is a hard error, never a silent fallthrough
    // to "no budget": that would read as unlimited spend.
    return parseBudgetConfig(raw)
  }
  return undefined
}

export async function listTranscripts(
  root = TRANSCRIPT_ROOT,
  modifiedSinceMs = 0,
): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          const info = await stat(full)
          if (info.mtimeMs >= modifiedSinceMs) {
            found.push(full)
          }
        } catch {}
      }
    }
  }
  await walk(root)
  return found
}

/**
 * Fold one transcript's usage records into `scan`, honoring `seen` for dedup
 * and the [fromMs, toMs) window. Exported so a session-scoped tracker can reuse
 * the exact parsing the whole-corpus report uses.
 */
/**
 * The project a transcript belongs to, from its path. Transcripts live under
 * `<root>/<project-slug>/…`, and sidechains nest deeper, so the slug is the
 * FIRST segment below the root - nested files must attribute to the same
 * project as their parent, or two thirds of the data lands under the wrong
 * key.
 */
export function projectSlugFromPath(
  file: string,
  root = TRANSCRIPT_ROOT,
): string {
  const relative = path.relative(root, file)
  const [first] = relative.split(path.sep)
  return first && first !== '..' ? first : 'unknown'
}

export async function scanTranscript(
  file: string,
  scan: UsageScan,
  seen: Set<string>,
  fromMs: number,
  toMs: number,
  requestByMessage: Map<string, string> = new Map(),
): Promise<void> {
  const project = projectSlugFromPath(file)
  const reader = createInterface({
    crlfDelay: Infinity,
    input: createReadStream(file, { encoding: 'utf8' }),
  })
  for await (const line of reader) {
    if (!line.includes(USAGE_HINT)) {
      continue
    }
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const message = record['message'] as Record<string, unknown> | undefined
    const usage = message?.['usage'] as Record<string, number> | undefined
    if (!usage || typeof usage['output_tokens'] !== 'number') {
      continue
    }
    const stamp =
      typeof record['timestamp'] === 'string'
        ? Date.parse(record['timestamp'])
        : Number.NaN
    if (!Number.isFinite(stamp) || stamp < fromMs || stamp >= toMs) {
      continue
    }
    scan.dedup.recordsSeen += 1
    const messageId = message?.['id'] as string | undefined
    const requestId = record['requestId'] as string | undefined
    const key = usageKey(messageId, requestId)
    if (key === undefined) {
      // Cannot be deduplicated, so it is counted as-is and flagged rather than
      // dropped: silently discarding a billed record understates the bill.
      scan.dedup.keylessRecords += 1
    } else {
      if (seen.has(key)) {
        scan.dedup.duplicatesDropped += 1
        continue
      }
      seen.add(key)
      if (messageId) {
        const priorRequest = requestByMessage.get(messageId)
        if (priorRequest === undefined) {
          requestByMessage.set(messageId, requestId ?? '')
        } else if (priorRequest !== (requestId ?? '')) {
          // Retries billing separately would land here. Left as a counter, not
          // a throw: measurement must not fail a session, and the check gates it.
          scan.dedup.multiRequestMessageIds += 1
        }
      }
    }
    const model =
      typeof message?.['model'] === 'string'
        ? (message['model'] as string)
        : 'unknown'
    let row = scan.byModel.get(model)
    if (!row) {
      row = emptyTotals()
      scan.byModel.set(model, row)
    }
    // `cache_creation` splits the write by TTL; `cache_creation_input_tokens` is
    // their sum. Both are read because the TTLs bill differently and the sum
    // alone cannot say which rate applies.
    const creation = usage['cache_creation'] as
      | Record<string, number>
      | undefined
    const delta: UsageTotals = {
      cacheRead: usage['cache_read_input_tokens'] ?? 0,
      cacheWrite: usage['cache_creation_input_tokens'] ?? 0,
      cacheWrite1h: creation?.['ephemeral_1h_input_tokens'] ?? 0,
      input: usage['input_tokens'] ?? 0,
      output: usage['output_tokens'] ?? 0,
      requests: 1,
    }
    addUsage(row, delta)
    addUsage(scan.totals, delta)
    const speed =
      typeof usage['speed'] === 'string' ? (usage['speed'] as string) : 'unset'
    const speedKey = `${model}|${speed}`
    let speedRow = scan.byModelSpeed.get(speedKey)
    if (!speedRow) {
      speedRow = { ...emptyTotals(), model, speed }
      scan.byModelSpeed.set(speedKey, speedRow)
    }
    addUsage(speedRow, delta)
    const day = new Date(stamp).toISOString().slice(0, 10)
    let dayRow = scan.byDay.get(day)
    if (!dayRow) {
      dayRow = emptyTotals()
      scan.byDay.set(day, dayRow)
    }
    addUsage(dayRow, delta)
    let projectRow = scan.byProject.get(project)
    if (!projectRow) {
      projectRow = emptyTotals()
      scan.byProject.set(project, projectRow)
    }
    addUsage(projectRow, delta)
  }
}

export async function scanUsage(
  fromMs: number,
  toMs: number,
  root = TRANSCRIPT_ROOT,
): Promise<UsageScan> {
  // A transcript touched before the window opened cannot hold a record inside
  // it; one day of slack absorbs clock skew and long-lived appends.
  const files = await listTranscripts(root, fromMs - 86_400_000)
  const scan: UsageScan = {
    byDay: new Map(),
    byModel: new Map(),
    byModelSpeed: new Map(),
    byProject: new Map(),
    dedup: emptyDedupDiagnostics(),
    filesScanned: files.length,
    totals: emptyTotals(),
  }
  const seen = new Set<string>()
  // Shared across files on purpose: a message id can recur in a sidechain
  // transcript, and the soundness question is global, not per file.
  const requestByMessage = new Map<string, string>()
  for (const file of files) {
    // Sequential on purpose: `seen` is shared mutable state, and dedup
    // correctness outranks scan latency here.
    await scanTranscript(file, scan, seen, fromMs, toMs, requestByMessage)
  }
  return scan
}

/**
 * Short, non-reversible handle for an account or org UUID. Ledgers and reports
 * carry this instead of the UUID so attribution survives without the identity
 * travelling with it.
 */
export function accountFingerprint(uuid: string): string {
  return crypto.createHash('sha256').update(uuid).digest('hex').slice(0, 12)
}

/**
 * The account currently signed in, read from the CLI's own profile. Org-scoped
 * on purpose: the CLI caches per-organization state (credit grants, seat
 * eligibility) keyed by organization UUID, so org is the granularity billing
 * actually differs at. Returns undefined when no profile is present.
 *
 * IMPORTANT LIMIT: transcripts carry no account field, so a past session cannot
 * be attributed after the fact. Attribution only works when a switch is
 * RECORDED as it happens, which is why callers snapshot this at session start.
 */
export async function readAccountIdentity(
  profilePath = path.join(os.homedir(), '.claude.json'),
): Promise<AccountIdentity | undefined> {
  let raw
  try {
    raw = await readFile(profilePath, 'utf8')
  } catch {
    return undefined
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }
  const account = parsed['oauthAccount'] as Record<string, unknown> | undefined
  if (!account) {
    return undefined
  }
  const org = account['organizationUuid']
  const self = account['accountUuid']
  const source =
    typeof org === 'string' ? org : typeof self === 'string' ? self : ''
  if (!source) {
    return undefined
  }
  return {
    billingType:
      typeof account['billingType'] === 'string'
        ? account['billingType']
        : undefined,
    id: accountFingerprint(source),
    seatTier:
      typeof account['seatTier'] === 'string' ? account['seatTier'] : undefined,
  }
}

/**
 * Whether spend on this account bills marginal money. A metered or
 * overage-enabled seat spends real dollars per token; a flat quota seat spends
 * headroom, so the same gauge would mean two different things. An unknown
 * billing type is treated as real money, which is the safe direction.
 */
export function billsMarginalMoney(
  identity: AccountIdentity | undefined,
): boolean {
  if (!identity?.billingType) {
    return true
  }
  return identity.billingType !== 'subscription_quota'
}

// Neutral while consumption is ordinary, warming through orange and into red as
// the gauge drains, so the colour carries the same signal as the number.
const METER_RAMP: ReadonlyArray<readonly [number, number]> = [
  [0.6, 250],
  [0.45, 226],
  [0.3, 214],
  [0.15, 208],
  [0, 196],
]

export function meterColorFor(remainingFraction: number): number {
  for (const [floor, code] of METER_RAMP) {
    if (remainingFraction >= floor) {
      return code
    }
  }
  return 196
}

export interface ColorizeOptions {
  enabled?: boolean | undefined
}

/**
 * Wrap text in a 256-colour code. Off unless asked: this output lands in the
 * session transcript, where escape codes are noise, so a caller enables colour
 * only for a real terminal.
 */
export function colorize(
  text: string,
  code: number,
  options?: ColorizeOptions | undefined,
): string {
  const opts = { __proto__: null, ...options } as ColorizeOptions
  if (opts.enabled !== true) {
    return text
  }
  return `\u001B[38;5;${code}m${text}\u001B[39m`
}

export interface SpendMeterOptions {
  color?: boolean | undefined
  showAbsolute?: boolean | undefined
}

/**
 * The meter with the gradient applied to the gauge itself.
 */
export function renderSpendMeterColored(
  spentUsd: number,
  config: BudgetConfig,
  options?: SpendMeterOptions | undefined,
): string {
  const opts = { __proto__: null, ...options } as SpendMeterOptions
  const tier = tierFor(spentUsd, config)
  const against =
    tier === 'target' ? config.target.monthly : config.stretch.monthly
  const remaining = 1 - meterFraction(spentUsd, against)
  const bar = colorize(renderMeterBar(remaining), meterColorFor(remaining), {
    enabled: opts.color === true,
  })
  const showAbsolute = opts.showAbsolute ?? config.printAbsoluteFigures
  const amount = showAbsolute ? ` ${Math.round(spentUsd)}/${against}` : ''
  const label = tier === 'stretch' ? 'reserve' : tier
  return `${meterGlyphFor(tier)} ${bar} ${Math.round(remaining * 100)}% left · ${label}${amount}`
}

/**
 * Fast mode's premium is a RANGE, not a constant, and deliberately so.
 *
 * `list` is the documented premium. `floor` is what observed cash implies: for
 * one 31-day window a quoted cash figure solved to a multiplier of 0.995, i.e.
 * indistinguishable from no premium at all.
 *
 * Both ends produce the same cash, so they are NOT separately identifiable from
 * a single total - `m = list` with a negotiated discount and `m = floor` with
 * no discount are the same equation with two unknowns. An enterprise agreement
 * can move either end. So callers price a BAND and calibrate the band to cash
 * via {@link ScanCostOptions.calibrationFactor}, rather than asserting a
 * point.
 *
 * The policy consequence does not depend on resolving it: the premium cannot be
 * below 1, so fast mode can only ever raise cost. Banning it is free, and the
 * upside is bounded by the band.
 */
export const FAST_MODE_MULTIPLIER_RANGE = { floor: 1, list: 2 } as const

/**
 * Whether a `usage.speed` value means the request actually ran fast. Anything
 * else, including an absent value on older records, is charged at base rate,
 * which is the conservative direction for a saving claim.
 */
export function isFastSpeed(speed: string | undefined): boolean {
  return typeof speed === 'string' && speed.toLowerCase().includes('fast')
}

export interface ScanCostOptions {
  /**
   * Scales modeled cost onto observed cash. Derived as `cash / modeled` over a
   * window where a cash figure is known, so list prices, negotiated rates, and
   * an unresolved fast-mode premium collapse into one correction instead of
   * being guessed individually. 1 means uncalibrated.
   */
  calibrationFactor?: number | undefined
  /**
   * Point multiplier for fast traffic. Defaults to the documented list value.
   */
  fastMultiplier?: number | undefined
}

export interface ScanCost {
  baseUsd: number
  /**
   * `pointUsd` scaled onto observed cash. Equals `pointUsd` when uncalibrated.
   */
  calibratedUsd: number
  fastPremiumUsd: number
  /**
   * Upper bound: fast traffic at the documented list premium.
   */
  highUsd: number
  /**
   * Lower bound: fast traffic at the cash-implied floor, i.e. no premium.
   */
  lowUsd: number
  pointUsd: number
  // Models seen in the window with no usable price. NEVER treated as free: a
  // caller reports a partial total rather than a confidently wrong one.
  unpricedModels: string[]
  unpricedRequests: number
}

/**
 * Cost a whole scan, speed-aware. Pricing from `byModelSpeed` rather than
 * `byModel` is the load-bearing part: a model whose traffic is part fast and
 * part standard bills at two different rates, and folding it into one bucket
 * understates by the fast share.
 */
export function costScan(
  scan: UsageScan,
  models: Readonly<Record<string, ModelRate>>,
  multipliers: CacheMultipliers,
  options?: ScanCostOptions | undefined,
): ScanCost {
  const opts = { __proto__: null, ...options } as ScanCostOptions
  const point = opts.fastMultiplier ?? FAST_MODE_MULTIPLIER_RANGE.list
  const calibration = opts.calibrationFactor ?? 1
  let baseUsd = 0
  let pointUsd = 0
  let lowUsd = 0
  let highUsd = 0
  let unpricedRequests = 0
  const unpriced = new Set<string>()
  for (const row of scan.byModelSpeed.values()) {
    const rate = models[row.model]
    const base = costUsage(row, rate, multipliers)
    if (!base) {
      unpriced.add(row.model)
      unpricedRequests += row.requests
      continue
    }
    baseUsd += base.totalUsd
    if (!isFastSpeed(row.speed)) {
      pointUsd += base.totalUsd
      lowUsd += base.totalUsd
      highUsd += base.totalUsd
      continue
    }
    // Fast traffic is the only place the band opens. Non-fast rows are the same
    // at every end, so the band's width IS the fast exposure.
    pointUsd +=
      costUsage(row, rate, multipliers, point)?.totalUsd ?? base.totalUsd
    lowUsd +=
      costUsage(row, rate, multipliers, FAST_MODE_MULTIPLIER_RANGE.floor)
        ?.totalUsd ?? base.totalUsd
    highUsd +=
      costUsage(row, rate, multipliers, FAST_MODE_MULTIPLIER_RANGE.list)
        ?.totalUsd ?? base.totalUsd
  }
  const unpricedModels = [...unpriced]
  // oxlint-disable-next-line unicorn/no-array-sort -- fresh copy from a Set
  unpricedModels.sort()
  return {
    baseUsd,
    calibratedUsd: pointUsd * calibration,
    fastPremiumUsd: pointUsd - baseUsd,
    highUsd,
    lowUsd,
    pointUsd,
    unpricedModels,
    unpricedRequests,
  }
}

export interface LeverRate {
  activeDays: number
  perActiveDay: number
  perWindowDay: number
  totalUsd: number
}

/**
 * Rate a lever over the days it was ACTIVE, not across the whole window.
 *
 * This exists because averaging got it wrong by a wide margin: fast mode ran on
 * 21 of 31 days and Fable on 24 of 31, so window averages understated their
 * real daily cost by 30-48%. A saving projected from a window average is
 * therefore too low, and the error grows the later in the window a lever was
 * switched off. `perWindowDay` is kept alongside so the two are comparable and
 * the gap is visible rather than implied.
 */
export function leverRate(
  dailyUsd: Iterable<number>,
  windowDays: number,
  activeThresholdUsd = 1,
): LeverRate {
  let total = 0
  let activeDays = 0
  for (const value of dailyUsd) {
    total += value
    if (value > activeThresholdUsd) {
      activeDays += 1
    }
  }
  return {
    activeDays,
    perActiveDay: activeDays > 0 ? total / activeDays : 0,
    perWindowDay: windowDays > 0 ? total / windowDays : 0,
    totalUsd: total,
  }
}
