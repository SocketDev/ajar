/**
 * @file Selectors and page-level read I/O for the Apple Developer portal
 *   certificates flow, in ONE place per the calibration ladder: the account
 *   dashboard's sign-in signal, the certificates list page's row count, and the
 *   add-flow's certificate-type option state. The READ path is CALIBRATED
 *   against the live portal (2026-08-10): the sign-in signal is the landed URL
 *   leaving Apple's SSO host, read passively so a navigation never cancels a
 *   Touch ID prompt; the certificates list is read from the RENDERED page,
 *   because the fetched shell is a ~944-byte SPA stub whose row count is always
 *   zero; and the add page's option state comes from its rendered radio, since
 *   the shell read reported the option missing for an account that plainly had
 *   it. NOTHING here reads fetched HTML any more. The team is verified rather
 *   than assumed: `?teamId=` does NOT switch team context, so
 *   `readPortalTeamId` reads what the session is actually scoped to. The WRITE
 *   path is still PENDING LIVE CALIBRATION. The pure
 *   parsers take plain strings, so they are unit-tested from
 *   fixtures; the `read*` wrappers take a real (or structurally faked)
 *   Playwright `Page`. `driveCertificateCreation` is the write side: it
 *   selects the Developer ID Application option, uploads the CSR, and captures
 *   the issued certificate's download — role-based Playwright locators, the
 *   same idiom `trusted-publisher-page.mts` uses, PENDING LIVE CALIBRATION
 *   against the real add-flow. `captureUnexpectedPageState` backs the "never
 *   blind-retry" rule: an unrecognized page state during a drive screenshots to
 *   a run dir and hands the caller a path to point a human gate at, rather than
 *   clicking something unverified.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { Page } from 'playwright-core'

import { pollWithDecay } from '../../_shared/poll-with-decay.mts'
import { DEVELOPER_ID_TEAM_ID } from './developer-id-plan.mts'

export const APPLE_ORIGIN = 'https://developer.apple.com'
export const ACCOUNT_URL = `${APPLE_ORIGIN}/account`
// Every resource URL PINS the team. An Apple ID that belongs to more than one
// team lands on whichever team the portal last selected, and measured live
// 2026-08-10 that default was the operator's PERSONAL team, not Socket Inc. —
// an unpinned create would mint the identity on the wrong team, which is the
// one mistake here that cannot be undone quietly.
export const CERTIFICATES_LIST_URL = `${APPLE_ORIGIN}/account/resources/certificates/list?teamId=${DEVELOPER_ID_TEAM_ID}`
export const CERTIFICATES_ADD_URL = `${APPLE_ORIGIN}/account/resources/certificates/add?teamId=${DEVELOPER_ID_TEAM_ID}`

/**
 * The certificate-type label the portal renders for the identity this driver
 * manages.
 */
export const DEVELOPER_ID_CERTIFICATE_TYPE_LABEL = 'Developer ID Application'

// Apple's SSO host. A signed-out request to any account URL redirects here,
// which is the ONLY signal that holds for both a fetched body and a landed
// URL. CALIBRATED 2026-08-10 against the live portal.
export const APPLE_SSO_HOST = 'idmsa.apple.com'

// There are deliberately NO fetched-HTML markers here. Every read in this
// module navigates and reads the RENDERED page, because each portal route is
// a client-rendered SPA whose fetched shell carries none of its content: the
// shell-based reads reported "signed out" on a valid session, "zero
// certificates" on any team, and "your account cannot create this
// certificate" for an account that plainly could. A marker list against
// fetched HTML is the shape that produced all three, so it is gone rather
// than retuned.

export type AppleAccountPageState = 'signed-in' | 'signed-out' | 'unknown'

/**
 * The sign-in probe {@link openFleetBrowserSession} injects for the Apple
 * Developer session: the page's landed URL, classified by
 * {@link classifyAccountUrl}. Returns a fixed truthy sentinel on a signed-in
 * read and '' otherwise, matching the probe contract every fleet browser
 * session shares.
 */
export async function resolveAppleAccountIdentity(page: Page): Promise<string> {
  // PASSIVE on purpose: read the page's OWN url, never navigate and never
  // fetch while the operator is authenticating. Apple's sign-in can hand off
  // to Touch ID, and a goto() or reload mid-prompt cancels the biometric
  // dialog — measured live 2026-08-10. The url moves off the SSO host by
  // itself the moment sign-in completes, so polling it costs the page
  // nothing.
  return classifyAccountUrl(page.url()) === 'signed-in' ? 'apple-developer' : ''
}

/**
 * Classify the page's landed URL: any account URL redirects to Apple's SSO
 * host while signed out, and lands back on {@link APPLE_ORIGIN} once signed
 * in. An `about:blank` (or any other host) is `unknown`, never signed-in.
 * Pure — exported for tests.
 */
export function classifyAccountUrl(url: string): AppleAccountPageState {
  if (url.includes(APPLE_SSO_HOST)) {
    return 'signed-out'
  }
  return url.startsWith(`${APPLE_ORIGIN}/account`) ? 'signed-in' : 'unknown'
}

export type CertificatesListPageState = 'error' | 'readable' | 'signed-out'

/**
 * Read the certificates list page through the signed-in session and report
 * its state plus its Developer ID Application row count (0 when the page
 * did not classify as `readable`, since a row count from an unreadable page
 * proves nothing). Structural — a fake `Page` satisfies this the same way
 * every other fleet browser reader does.
 */
export async function readCertificatesListPage(page: Page): Promise<{
  rows: number
  state: CertificatesListPageState
}> {
  // NAVIGATE, never fetch. Measured live 2026-08-10: the certificates page is
  // a client-rendered SPA whose fetched shell is ~944 bytes and carries no
  // rows at all, so counting the fetched body reported 0 unconditionally —
  // a FALSE "no certificate exists" on the one read that exists to refuse a
  // duplicate. The rendered DOM is the only place the rows are real.
  await page.goto(CERTIFICATES_LIST_URL, { waitUntil: 'domcontentloaded' })
  // Return the moment the page carries either the list heading or its
  // empty-state, rather than sleeping a flat ceiling on a page that painted
  // in 200ms. `locator('body').innerText()` rather than an
  // `evaluate(() => document…)`: the fleet tsconfig carries no `dom` lib, so a
  // DOM global inside an evaluate callback does not type-check.
  const text = await awaitRendered(
    page,
    body =>
      body.includes('Certificates, Identifiers') ||
      body.includes(CERTIFICATES_EMPTY_MARKER),
  )
  if (page.url().includes(APPLE_SSO_HOST)) {
    return { rows: 0, state: 'signed-out' }
  }
  return readRenderedCertificatesList(text)
}

// Ceiling on how long an SPA route gets to paint before a read gives up.
// Generous on purpose: an under-wait reads an empty list as zero rows, which
// is the exact false-negative this whole path exists to avoid. This is a
// CEILING, not a fixed sleep — awaitRendered returns the moment the page
// carries what the caller needs, so the common case costs a fraction of it.
export const CERTIFICATES_RENDER_WAIT_MS = 6000

// First poll interval while waiting for a paint. Short, because an SPA route
// usually settles well inside a second.
export const RENDER_POLL_INITIAL_MS = 250
export const RENDER_POLL_MAX_MS = 1500

/**
 * Wait until the page's rendered text satisfies `ready`, and hand that text
 * back. Returns the last text seen when the ceiling expires, so the caller
 * classifies a real page rather than an empty string — an unpainted page must
 * read as an ERROR, never as a confident "nothing here".
 *
 * Replaces a flat sleep at every read site. A fixed 6s wait was wrong twice
 * over: it burned six seconds on a page that painted in 200ms, and it still
 * had no answer for a slow one.
 */
export async function awaitRendered(
  page: Page,
  ready: (text: string) => boolean,
  budgetMs = CERTIFICATES_RENDER_WAIT_MS,
): Promise<string> {
  let lastText = ''
  const outcome = await pollWithDecay(
    async () => {
      const text = await page.locator('body').innerText()
      lastText = text
      return ready(text) ? text : undefined
    },
    {
      budgetMs,
      initialMs: RENDER_POLL_INITIAL_MS,
      maxMs: RENDER_POLL_MAX_MS,
      sleep: async ms => {
        await page.waitForTimeout(ms)
      },
    },
  )
  return outcome.value ?? lastText
}

// The empty-state heading the portal renders when a team holds no
// certificates at all. Calibrated live 2026-08-10.
export const CERTIFICATES_EMPTY_MARKER = 'Getting Started with Certificates'

/**
 * Classify + count from the RENDERED certificates page text. An explicit
 * empty-state heading is the only thing that proves zero; text carrying
 * neither the empty state nor the page's own heading is `error`, so an
 * unpainted or unexpected page can never pass as "no certificates".
 * Pure — exported for tests.
 */
export function readRenderedCertificatesList(text: string): {
  rows: number
  state: CertificatesListPageState
} {
  if (text.includes(CERTIFICATES_EMPTY_MARKER)) {
    return { rows: 0, state: 'readable' }
  }
  if (!text.includes('Certificates, Identifiers')) {
    return { rows: 0, state: 'error' }
  }
  const matches = text.match(/Developer ID Application/g)
  return { rows: matches ? matches.length : 0, state: 'readable' }
}

/**
 * The team id the portal is CURRENTLY scoped to, read from the header line
 * the resource pages render as `<team name> - <TEAMID>`. Returns undefined
 * when no such line is present. Pure — exported for tests.
 *
 * This exists because `?teamId=…` DOES NOT switch team context: measured live
 * 2026-08-10, the add page rendered the operator's personal team while the
 * URL carried Socket Inc.'s id. The team is session state the operator picks
 * in the portal's own switcher, so it must be READ and enforced, never
 * assumed from a URL we constructed.
 */
export function extractPortalTeamId(text: string): string | undefined {
  // Apple team ids are 10 uppercase alphanumerics, rendered after " - ".
  const match = text.match(/ - ([0-9A-Z]{10})\b/)
  return match?.[1]
}

/**
 * Read the team the signed-in portal session is scoped to. Navigates to the
 * certificates list and reads its header. Note: every resource page renders
 * that same header, so the list is just the cheapest one to land on.
 */
export async function readPortalTeamId(
  page: Page,
): Promise<string | undefined> {
  await page.goto(CERTIFICATES_LIST_URL, { waitUntil: 'domcontentloaded' })
  // Ready when the header line carrying `<name> - <TEAMID>` has painted.
  return extractPortalTeamId(
    await awaitRendered(page, body => extractPortalTeamId(body) !== undefined),
  )
}

// The portal's own team switcher, calibrated from the live DOM 2026-08-10:
//   <div class="user-menu">
//     <span class="user-name …">John-David Dalton</span>   ← toggles the menu
//     <span class="team-name">John-David Dalton - BR6U768Y5D</span>
//     <ul class="hide"><li data-id="PZRCDQ736X">Socket Inc.</li>…</ul>
// Each team is an <li> keyed by its team id, so the switch is deterministic
// rather than a label match against a display name.
export const TEAM_MENU_TOGGLE_SELECTOR = '.user-menu .user-name'
export const TEAM_NAME_SELECTOR = '.user-menu .team-name'

/**
 * The `li` selector for one team in the switcher.
 */
export function teamOptionSelector(teamId: string): string {
  return `.user-menu li[data-id="${teamId}"]`
}

/**
 * Switch the portal to `teamId` through its own switcher, and confirm from
 * the rendered team-name line that it took. Returns the team id in effect
 * afterwards, so the caller verifies rather than trusting the clicks.
 *
 * `?teamId=` in a URL does NOT change team context, so this is the only way
 * to move it without asking the operator to do it by hand mid-run.
 */
export async function switchPortalTeam(
  page: Page,
  teamId: string,
): Promise<string | undefined> {
  const teamName = page.locator(TEAM_NAME_SELECTOR).first()
  // Already there? Do nothing. Apple remembers the last selected team per
  // account, so a run often starts on the right one, and re-clicking the
  // selected entry re-renders the header out from under the read that
  // follows.
  const current = extractPortalTeamId(await teamName.innerText())
  if (current === teamId) {
    return current
  }
  const option = page.locator(teamOptionSelector(teamId))
  if ((await option.count()) === 0) {
    // The team is not offered to this Apple ID at all.
    return undefined
  }
  // PRESENCE IS NOT READINESS. The switcher renders every team's <li> into
  // the DOM up front and hides them behind `ul.hide` until the toggle is
  // clicked, so `count()` matches a hidden node and clicking it times out
  // with "element is not visible". Gate on VISIBILITY and open the menu when
  // it is closed.
  if (!(await option.first().isVisible())) {
    await page.locator(TEAM_MENU_TOGGLE_SELECTOR).first().click()
    await option.first().waitFor({ state: 'visible' })
  }
  await option.first().click()
  // Selecting a team re-renders the header, so wait for the name line to come
  // back and to show a team OTHER than the one we started on, rather than
  // sleeping a flat ceiling and risking a read of the pre-switch header. The
  // ceiling still applies, and the last value seen is returned either way, so
  // the caller compares against what is really in effect.
  await teamName.waitFor({ state: 'visible' }).catch(() => {})
  const text = await awaitRendered(page, body => {
    const seen = extractPortalTeamId(body)
    return seen !== undefined && seen !== current
  })
  return extractPortalTeamId(text) ?? current
}

/**
 * Wait for the portal session to be scoped to `wantedTeamId`, re-reading it
 * until it matches or the budget runs out. Returns the last team id seen.
 *
 * A plain refusal would fire the instant sign-in completes, which is BEFORE
 * the operator can reach the team switcher — so the first run of every
 * session would fail by construction and cost another sign-in, since Apple's
 * session does not survive the browser closing. Waiting turns that into a
 * gate the operator can actually clear in place. `onWait` is called once, so
 * a caller can tell them what to do.
 */
export async function waitForPortalTeam(
  page: Page,
  config: {
    onWait?: (() => void) | undefined
    timeoutMs?: number | undefined
    wantedTeamId: string
  },
): Promise<string | undefined> {
  const cfg = { __proto__: null, ...config } as typeof config
  // Navigate ONCE, then poll PASSIVELY with a DECAYING interval. Two things
  // this shape protects. Re-navigating per tick reloaded the page under the
  // operator and closed the switcher they were reaching for — the same
  // mistake the sign-in probe made against Touch ID, so a wait for a human
  // action never touches the page that human is acting on. And a flat poll
  // across a ten-minute wait is hundreds of reads at a vendor that
  // rate-limits, where backing off keeps the first seconds responsive and the
  // tail nearly free. A read that throws is a page mid-navigation rather than
  // a failure, so the poller rides it and reports the last team it did see.
  let lastSeen = await readPortalTeamId(page).catch(() => undefined)
  if (lastSeen === cfg.wantedTeamId) {
    return lastSeen
  }
  const outcome = await pollWithDecay(
    async () => {
      const seen = extractPortalTeamId(await page.locator('body').innerText())
      if (seen !== undefined) {
        lastSeen = seen
      }
      return seen === cfg.wantedTeamId ? seen : undefined
    },
    {
      budgetMs: cfg.timeoutMs ?? PORTAL_TEAM_WAIT_MS,
      initialMs: PORTAL_TEAM_POLL_MS,
      maxMs: PORTAL_TEAM_POLL_MAX_MS,
      onFirstWait: cfg.onWait,
      sleep: async ms => {
        await page.waitForTimeout(ms)
      },
    },
  )
  return outcome.value ?? lastSeen
}

// The interval ceiling once the poll has backed off. A team switch is a few
// clicks, so a ten-second tail is still prompt while costing ~60 reads across
// the full budget instead of ~300.
export const PORTAL_TEAM_POLL_MAX_MS = 10_000

// Poll pace while the operator works the team switcher. Read-only: it reads
// the page's own rendered text and never navigates it.
export const PORTAL_TEAM_POLL_MS = 2000

// How long the operator gets to switch teams in the portal's own switcher.
export const PORTAL_TEAM_WAIT_MS = 10 * 60_000

export type DeveloperIdOptionState = 'available' | 'disabled' | 'missing'

/**
 * Read the add-certificate page through the signed-in session and report its
 * Developer ID Application option state. Structural — a fake `Page`
 * satisfies this the same way every other fleet browser reader does.
 */
export async function readCertificateAddPage(page: Page): Promise<{
  optionState: DeveloperIdOptionState
}> {
  // NAVIGATE + read the RENDERED controls, never the fetched shell. Measured
  // live 2026-08-10: the add page is client-rendered, so a fetched body
  // carries none of the certificate-type options and this read reported
  // `missing` — which the caller surfaces as "your account may not create a
  // Developer ID certificate". A tooling blind spot must never be reported as
  // a permissions verdict about the operator.
  await page.goto(CERTIFICATES_ADD_URL, { waitUntil: 'domcontentloaded' })
  // Ready when the type list has painted. Waiting on the LABEL rather than a
  // flat sleep matters here: reading too early finds no radio and would report
  // `missing`, which the caller renders as a verdict about the operator's
  // role. The read must not answer until the page has actually shown its
  // options.
  await awaitRendered(page, body =>
    body.includes(DEVELOPER_ID_CERTIFICATE_TYPE_LABEL),
  )
  const radio = page.getByRole('radio', {
    name: DEVELOPER_ID_CERTIFICATE_TYPE_LABEL,
  })
  if ((await radio.count()) === 0) {
    return { optionState: 'missing' }
  }
  return {
    optionState: (await radio.first().isEnabled()) ? 'available' : 'disabled',
  }
}

/**
 * Drive the add-certificate flow to completion on an already-open,
 * already-verified page: select the Developer ID Application option,
 * continue, upload the CSR through the file input, continue, then capture
 * the issued certificate's browser download into `downloadDir`. Every
 * locator is role/label-based — the same idiom `trusted-publisher-page.mts`
 * uses for npm's form — and PENDING LIVE CALIBRATION: a live `create
 * --drive` run is expected to correct any locator the real page does not
 * match, never the other way around. Navigates exactly once, at the top,
 * matching the "drive in place" contract every fleet page-driver follows —
 * everything after that opening navigation happens where the page already
 * is.
 */
export async function driveCertificateCreation(
  page: Page,
  config: { csrPath: string; downloadDir: string },
): Promise<{ downloadPath: string }> {
  const cfg = { __proto__: null, ...config } as typeof config
  await page.goto(CERTIFICATES_ADD_URL, { waitUntil: 'domcontentloaded' })
  await page
    .getByRole('radio', {
      name: new RegExp(DEVELOPER_ID_CERTIFICATE_TYPE_LABEL),
    })
    .first()
    .check({ timeout: 15_000 })
  await page
    .getByRole('button', { name: /continue/i })
    .first()
    .click({ timeout: 10_000 })
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles(cfg.csrPath, { timeout: 15_000 })
  await page
    .getByRole('button', { name: /continue/i })
    .first()
    .click({ timeout: 10_000 })
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 })
  await clickDownloadControl(page)
  const download = await downloadPromise
  const downloadPath = path.join(
    cfg.downloadDir,
    download.suggestedFilename() || 'developer-id.cer',
  )
  await download.saveAs(downloadPath)
  return { downloadPath }
}

/**
 * Click whatever the issued-certificate page uses to hand over the file.
 *
 * Tries a button, then a link, then any element carrying a `download`
 * attribute. Calibrated 2026-08-10 as far as the upload page, where Continue
 * proved to be a real `button` — but the page AFTER upload has never been
 * reached, and this portal already mixes the two: its "Create a certificate"
 * primary action is an `<a>` styled as a button. Trying all three costs
 * nothing and removes the likeliest first-run failure for whoever finally
 * has the role to get here.
 */
export async function clickDownloadControl(page: Page): Promise<void> {
  const candidates = [
    page.getByRole('button', { name: /download/i }),
    page.getByRole('link', { name: /download/i }),
    page.locator('[download]'),
  ]
  for (let i = 0, { length } = candidates; i < length; i += 1) {
    const candidate = candidates[i]!
    if ((await candidate.count()) > 0) {
      await candidate.first().click({ timeout: 10_000 })
      return
    }
  }
  throw new Error(
    [
      'What: the issued certificate has no download control this driver recognizes.',
      `Where: ${CERTIFICATES_ADD_URL}, after the CSR upload.`,
      'Saw: no button, link, or [download] element naming a download.',
      'Wanted: the control that hands over the .cer.',
      'Fix: the certificate WAS created — download it by hand from the certificates list, then run `developer-id-cert.mts import --input <the .cer>`.',
    ].join('\n'),
  )
}

/**
 * The "never blind-retry" backstop: screenshot the page's current state
 * into `runDir` under a name carrying `label` and the moment, so a human
 * gate can point the operator at exactly what stopped the run. Returns the
 * saved path, or '' when the screenshot itself failed (a torn-down page,
 * for instance) — the caller still renders its gate either way, since a
 * missing screenshot is not a reason to skip pausing for the operator.
 */
export async function captureUnexpectedPageState(
  page: Page,
  runDir: string,
  label: string,
): Promise<string> {
  await fs.mkdir(runDir, { recursive: true }).catch(() => undefined)
  const screenshotPath = path.join(runDir, `${label}-${Date.now()}.png`)
  try {
    await page.screenshot({ path: screenshotPath })
  } catch {
    return ''
  }
  return screenshotPath
}
