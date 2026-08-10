/**
 * @file Pure planners for the Apple Developer ID certificate driver: decide
 *   skip/create/refuse from the local keychain state plus the portal's own
 *   certificate list (no playwright, no network — every value here arrives
 *   already read), and the human-readable renderers for `status` and
 *   `create`'s dry-run plan. An identity the keychain already carries is the
 *   SUCCESS case; a portal that already lists one Developer ID Application
 *   certificate REFUSES a second unless the operator opts in, because the
 *   private key for an existing certificate lives on whichever machine
 *   created it and Apple caps Developer ID Application certificates per
 *   team — the identity doctrine here is ONE, not two. Page-level state
 *   lives in `developer-id-page.mts`; the keychain/openssl command plans
 *   live in `keychain-csr.mts`.
 */

export const DEVELOPER_ID_TEAM_ID = 'PZRCDQ736X'
export const DEVELOPER_ID_ORG_NAME = 'Socket Inc.'
export const DEVELOPER_ID_COMMON_NAME = 'Socket Inc. Developer ID'
export const DEVELOPER_ID_SUBJECT_EMAIL = 'jdalton@socket.dev'

/**
 * The exact identity label `security find-identity -v -p codesigning` prints
 * for a valid Developer ID Application identity on this team. Every reader
 * of the keychain state matches against this literal.
 */
export const DEVELOPER_ID_IDENTITY_LABEL = `Developer ID Application: ${DEVELOPER_ID_ORG_NAME} (${DEVELOPER_ID_TEAM_ID})`

/**
 * The certificate-type label the portal renders for the identity this driver
 * manages. Kept here (rather than only in `developer-id-page.mts`) so a plan
 * renderer can name it without importing the page module.
 */
export const DEVELOPER_ID_CERTIFICATE_TYPE_LABEL = 'Developer ID Application'

/**
 * The local-state + portal-state inputs {@link decideDeveloperIdCertPlan}
 * decides from.
 */
export interface DeveloperIdPlanInput {
  /**
   * The operator opted in to a second certificate.
   */
  allowAdditional: boolean
  /**
   * `security find-identity` already lists a valid identity for this team.
   */
  keychainHasIdentity: boolean
  /**
   * How many Developer ID Application rows the portal's list page shows.
   */
  portalRows: number
}

/**
 * The three outcomes a plan run can land on: skip (already have a usable
 * identity — the success case), create (nothing exists, or the operator
 * opted in to another), or refuse (a certificate exists on the portal but
 * not in this keychain, and the operator has not opted in to a second).
 */
export type DeveloperIdDecision =
  | { kind: 'create' }
  | { kind: 'refuse'; reason: string }
  | { kind: 'skip'; reason: string }

/**
 * Decide the run's outcome from local + portal state. Pure — exported for
 * tests. The keychain check wins outright: an identity already usable HERE
 * is the success case regardless of what the portal shows. Absent that, a
 * portal that already lists one or more Developer ID Application rows
 * refuses UNLESS the operator passed `--allow-additional` — creating another
 * would spend a scarce team slot without producing anything usable on this
 * machine, since the private key for the existing row lives wherever its CSR
 * was generated.
 */
export function decideDeveloperIdCertPlan(
  input: DeveloperIdPlanInput,
): DeveloperIdDecision {
  const cfg = { __proto__: null, ...input } as DeveloperIdPlanInput
  if (cfg.keychainHasIdentity) {
    return {
      kind: 'skip',
      reason:
        `the login keychain already carries ${DEVELOPER_ID_IDENTITY_LABEL} — ` +
        'nothing to create.',
    }
  }
  if (cfg.portalRows > 0 && !cfg.allowAdditional) {
    return {
      kind: 'refuse',
      reason:
        `the portal already lists ${cfg.portalRows} ${DEVELOPER_ID_CERTIFICATE_TYPE_LABEL} ` +
        'certificate(s) and this keychain has none. The identity doctrine is ' +
        'ONE, not two, and the team certificate cap is small, so creating ' +
        'another would spend a scarce slot without producing an identity ' +
        'usable on this machine — the private key for an existing row lives ' +
        'on whichever machine generated its CSR. ' +
        "Fix: import that certificate's key on this machine instead, or " +
        'pass --allow-additional to create one anyway.',
    }
  }
  return { kind: 'create' }
}

/**
 * The four-ingredient error for an add-certificate page that does not offer
 * a usable Developer ID Application option — the role-gated shape: the
 * signed-in Apple ID is not the team's ACCOUNT HOLDER. Pure — exported for
 * tests. `url` is passed in rather than imported from
 * `developer-id-page.mts`, so this module stays free of any page dependency.
 *
 * Measured on the live add page 2026-08-10: with an Admin signed in, 17 of
 * the 20 certificate types were enabled and exactly the two Developer ID
 * types were disabled. A lapsed membership disables every type, so a
 * disabled pair beside enabled siblings is the ROLE signal specifically, and
 * Admin is not enough — Apple reserves Developer ID for the Account Holder.
 */
export function describeMissingDeveloperIdOption(config: {
  optionState: 'disabled' | 'missing'
  url: string
}): string {
  const cfg = { __proto__: null, ...config } as typeof config
  const saw =
    cfg.optionState === 'missing'
      ? `no ${DEVELOPER_ID_CERTIFICATE_TYPE_LABEL} option rendered on the add-certificate page`
      : `the ${DEVELOPER_ID_CERTIFICATE_TYPE_LABEL} option rendered disabled`
  return [
    'What: the signed-in Apple ID cannot create a Developer ID Application certificate.',
    `Where: ${cfg.url}`,
    `Saw: ${saw}.`,
    `Wanted: the ${DEVELOPER_ID_CERTIFICATE_TYPE_LABEL} option, enabled.`,
    `Fix: have the ACCOUNT HOLDER of team ${DEVELOPER_ID_TEAM_ID} run this ` +
      'command. Apple reserves Developer ID certificates for that one role, ' +
      'so an Admin sees the option disabled while every other certificate ' +
      'type stays enabled.',
  ].join('\n')
}

/**
 * The `status` command's read-only report: what the keychain and the portal
 * each show, side by side. Pure — exported for tests.
 */
export function renderDeveloperIdStatus(config: {
  keychainHasIdentity: boolean
  portalRows: number
}): string {
  const cfg = { __proto__: null, ...config } as typeof config
  return [
    `keychain: ${
      cfg.keychainHasIdentity
        ? `${DEVELOPER_ID_IDENTITY_LABEL} (valid)`
        : `no ${DEVELOPER_ID_CERTIFICATE_TYPE_LABEL} identity`
    }`,
    `portal:   ${cfg.portalRows} ${DEVELOPER_ID_CERTIFICATE_TYPE_LABEL} certificate(s) listed`,
  ].join('\n')
}

/**
 * The `create` command's plan line for one decision — the dry-run text by
 * default, and what `--drive` is about to perform. Pure — exported for
 * tests.
 */
export function renderDeveloperIdPlan(decision: DeveloperIdDecision): string {
  if (decision.kind === 'skip') {
    return `[skip] ${decision.reason}`
  }
  if (decision.kind === 'refuse') {
    return `[refuse] ${decision.reason}`
  }
  return (
    '[create] generate a 2048-bit RSA CSR ' +
    `(subject: emailAddress=${DEVELOPER_ID_SUBJECT_EMAIL}, CN=${DEVELOPER_ID_COMMON_NAME}), ` +
    'sign in to the Apple Developer portal, upload the CSR under ' +
    `"${DEVELOPER_ID_CERTIFICATE_TYPE_LABEL}", download the issued certificate, ` +
    'import it into the login keychain, and verify with ' +
    '`security find-identity -v -p codesigning`. Pass --drive to execute.'
  )
}
