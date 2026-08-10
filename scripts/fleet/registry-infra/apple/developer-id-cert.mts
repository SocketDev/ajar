#!/usr/bin/env node
/*
 * @file Apple Developer ID certificate driver — `status` (read-only:
 *   keychain identity check + signed-in portal certificate list, as a
 *   table), `create` (dry-run by default; `--drive` takes the wheel of the
 *   signed-in session and executes), `csr` + `import` (the DELEGATED split,
 *   below), and `export-p12` (the operator-run `.p12` custody step).
 *
 *   THE DELEGATED SPLIT. Apple reserves Developer ID certificate creation
 *   for a team's ACCOUNT HOLDER — measured live 2026-08-10, an Admin sees
 *   exactly the two Developer ID types disabled while 17 other types stay
 *   enabled. The naive delegation is to have the Account Holder run the
 *   whole flow, but whoever generates the key HOLDS it, so that puts the
 *   org's signing key on their laptop and then moves a secret between
 *   people. Instead: `csr` generates the keypair on the machine that will
 *   sign and emits only the certificate request, which is not secret; the
 *   Account Holder uploads that one file in the portal and returns the
 *   issued `.cer`; `import` verifies its subject and installs it beside the
 *   key that never moved.
 *
 *   Composes the pure planners
 *   (`developer-id-plan.mts`), the portal page state
 *   (`developer-id-page.mts`), and the keychain/CSR command plans
 *   (`keychain-csr.mts`) with the sanctioned browser session
 *   (`openFleetBrowserSession` in `../npm/browser-session.mts`) and the
 *   fleet human-gate composer. Success is always the page's RE-READ answer
 *   plus `security find-identity`'s own output, never a click; an
 *   unrecognized page state during a drive screenshots to a run dir and
 *   stops for the operator rather than retrying a click it cannot verify.
 *   Usage: node scripts/fleet/registry-infra/apple/developer-id-cert.mts
 *   status|csr|import|create|export-p12 [--drive] [--allow-additional]
 *   [--profile-dir <dir>] [--output <path>] [--input <path>]
 */

import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { errorMessage } from '@socketsecurity/lib-stable/errors/message'

import { isMainModule } from '../../_shared/is-main-module.mts'
import { runMain } from '../../_shared/run-main.mts'
import type { ScriptMeta } from '../../_shared/run-main.mts'
import {
  browserSessionGate,
  formatHumanGate,
} from '../../_shared/human-gate.mts'
import { logger, rootPath } from '../shared.mts'
import {
  openFleetBrowserSession,
  showOperatorNote,
} from '../npm/browser-session.mts'
import type {
  FleetBrowserSession,
  FleetBrowserSessionOptions,
} from '../npm/browser-session.mts'
import {
  ACCOUNT_URL,
  captureUnexpectedPageState,
  CERTIFICATES_ADD_URL,
  CERTIFICATES_LIST_URL,
  DEVELOPER_ID_CERTIFICATE_TYPE_LABEL,
  driveCertificateCreation,
  readCertificateAddPage,
  readCertificatesListPage,
  readPortalTeamId,
  resolveAppleAccountIdentity,
  switchPortalTeam,
  waitForPortalTeam,
} from './developer-id-page.mts'
import type { CertificatesListPageState } from './developer-id-page.mts'
import {
  decideDeveloperIdCertPlan,
  describeMissingDeveloperIdOption,
  DEVELOPER_ID_IDENTITY_LABEL,
  DEVELOPER_ID_ORG_NAME,
  DEVELOPER_ID_TEAM_ID,
  renderDeveloperIdPlan,
  renderDeveloperIdStatus,
} from './developer-id-plan.mts'
import {
  exportP12,
  findCodesigningIdentity,
  generateAndImportCsr,
  importCertificate,
  readDerSubject,
  verifyDeveloperIdSubject,
} from './keychain-csr.mts'

/**
 * Where a drive's artifacts land: the downloaded certificate, the exported
 * `.p12`, and any unexpected-page-state screenshot. Outside the repo tree,
 * per `runtime-state-and-caches`.
 */
export const RUN_DIR = path.join(
  os.homedir(),
  '.socket',
  'apple-developer-id-runs',
)

/**
 * `export-p12`'s passphrase source — an environment variable, never argv
 * (argv is `ps`-visible) and never a bare prompt this driver would have to
 * build securely from scratch.
 */
export const P12_PASSPHRASE_ENV = 'APPLE_DEVELOPER_ID_P12_PASSPHRASE'

function renderAppleSignInGate(): string {
  return formatHumanGate(
    browserSessionGate(
      'the Apple Developer portal needs a signed-in session before this run can read or write certificates.',
      `sign in to your Apple ID at ${ACCOUNT_URL} in the fronted Chrome window — the password and 2FA step are yours alone.`,
      'say "open the Apple sign-in window" and I launch the shared Chrome profile and front it — only you can enter the password and 2FA.',
      'this run resumes on its own the moment the account dashboard reports a signed-in session.',
    ),
  ).join('\n')
}

/**
 * Open the signed-in Apple Developer session on the SAME durable profile
 * every fleet browser tool shares. Renders the sign-in gate up front — a
 * session already signed in resolves before any wait is felt, so the
 * printed gate is a one-time notice, not a real pause, in that case.
 */
export async function openAppleSession(
  options?: FleetBrowserSessionOptions | undefined,
): Promise<FleetBrowserSession> {
  logger.log(renderAppleSignInGate())
  const session = await openFleetBrowserSession(
    {
      origin: ACCOUNT_URL,
      probeLabel: 'the account dashboard',
      sessionLabel: 'Apple Developer',
      signedInProbe: resolveAppleAccountIdentity,
      // Apple's session does NOT survive the browser closing, so this wait is
      // paid on EVERY run rather than once per machine, and it lands while
      // the operator is reading a report rather than watching for a window.
      // The default five minutes expired unattended in practice, costing a
      // full re-run plus another 2FA each time.
      signInTimeoutMs: 15 * 60_000,
      signInUrl: ACCOUNT_URL,
    },
    options,
  )
  logger.log(`Signed in to the Apple Developer portal as ${session.user}.`)
  return session
}

async function readKeychainState(): Promise<{
  hasValidIdentity: boolean
  stdout: string
}> {
  return findCodesigningIdentity({
    cwd: rootPath,
    label: DEVELOPER_ID_IDENTITY_LABEL,
  })
}

function describeUnreadableCertificatesList(
  state: CertificatesListPageState,
): string {
  return [
    'What: the certificates list page could not be read.',
    `Where: ${CERTIFICATES_LIST_URL}`,
    `Saw: the page classified as ${state}.`,
    'Wanted: the readable certificates list page.',
    state === 'signed-out'
      ? 'Fix: sign in to the Apple Developer portal in the Chrome window, then re-run.'
      : 'Fix: open the URL above in the signed-in Chrome window and confirm it loads, then re-run.',
  ].join('\n')
}

async function runStatus(config: {
  profileDir?: string | undefined
}): Promise<number> {
  const cfg = { __proto__: null, ...config } as typeof config
  const keychain = await readKeychainState()
  const session = await openAppleSession({ profileDir: cfg.profileDir })
  try {
    const { rows, state } = await readCertificatesListPage(session.page)
    if (state !== 'readable') {
      logger.fail(describeUnreadableCertificatesList(state))
      return 1
    }
    logger.log(
      renderDeveloperIdStatus({
        keychainHasIdentity: keychain.hasValidIdentity,
        portalRows: rows,
      }),
    )
    return 0
  } finally {
    await session.close()
  }
}

/**
 * The write path behind `create --drive`: verify the add page offers a
 * usable option, generate + import the CSR, upload it and capture the
 * download, verify the issued certificate's subject BEFORE it ever touches
 * the keychain, import it, then prove success from `security find-identity`
 * plus a portal re-read — never from the click. Any unrecognized page state
 * mid-drive screenshots to {@link RUN_DIR} and stops rather than retrying.
 */
async function driveCreate(
  session: FleetBrowserSession,
  priorRows: number,
): Promise<number> {
  const { optionState } = await readCertificateAddPage(session.page)
  if (optionState !== 'available') {
    logger.fail(
      describeMissingDeveloperIdOption({
        optionState,
        url: CERTIFICATES_ADD_URL,
      }),
    )
    await showOperatorNote(session.page, {
      body: `Apple reserves Developer ID certificates for the team's Account Holder, so this account sees the option ${optionState}. Nothing is wrong with your membership — every other certificate type is still available to you.`,
      kicker: 'Cannot continue',
      steps: [
        'Run: pnpm run apple:cert csr',
        'Send that .csr to the Account Holder',
        'They upload it here and return the .cer',
        'Run: pnpm run apple:cert import --input <the .cer>',
      ],
      title: 'Account Holder required',
      tone: 'stop',
    })
    return 1
  }
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'socket-developer-id-csr-'),
  )
  await fs.chmod(tmpDir, 0o700)
  try {
    const generation = await generateAndImportCsr({ tmpDir })
    let downloadPath: string
    try {
      const drive = await driveCertificateCreation(session.page, {
        csrPath: generation.csrPath,
        downloadDir: RUN_DIR,
      })
      downloadPath = drive.downloadPath
    } catch (e) {
      const screenshotPath = await captureUnexpectedPageState(
        session.page,
        RUN_DIR,
        'create-drive-unexpected',
      )
      logger.fail(
        formatHumanGate(
          browserSessionGate(
            `driving the add-certificate flow hit an unrecognized page state: ${errorMessage(e)}.`,
            screenshotPath
              ? `open the fronted Chrome window and compare it against ${screenshotPath} — finish the flow by hand if the page looks right, else close it and re-run.`
              : 'open the fronted Chrome window and check what it shows — finish the flow by hand if it looks right, else close it and re-run.',
            'say "front the Apple window" and I bring the Chrome page back to the front — only you can judge an unrecognized page.',
            'this run stops here instead of retrying a click it cannot verify; re-run once the portal is back to a known state.',
          ),
        ).join('\n'),
      )
      return 1
    }
    const subject = await readDerSubject({
      certPath: downloadPath,
      cwd: rootPath,
    })
    const verify = verifyDeveloperIdSubject(subject)
    if (!verify.ok) {
      logger.fail(
        [
          'What: the issued certificate does not match this identity.',
          `Where: ${downloadPath}`,
          `Saw: ${verify.reason}.`,
          'Wanted: a certificate whose subject matches the Developer ID identity.',
          'Fix: do not import this certificate — verify the account and the CSR, then re-run.',
        ].join('\n'),
      )
      return 1
    }
    const imported = await importCertificate({
      certPath: downloadPath,
      cwd: rootPath,
    })
    if (imported.code !== 0) {
      logger.fail(
        [
          'What: importing the issued certificate into the keychain failed.',
          `Where: ${downloadPath}`,
          `Saw: security import exited ${imported.code}.`,
          'Wanted: the certificate imported, exit 0.',
          'Fix: confirm the login keychain is unlocked, then re-run the import by hand.',
        ].join('\n'),
      )
      return 1
    }
    const proof = await findCodesigningIdentity({
      cwd: rootPath,
      label: DEVELOPER_ID_IDENTITY_LABEL,
    })
    const reread = await readCertificatesListPage(session.page)
    logger.log(proof.stdout)
    logger.log(
      renderDeveloperIdStatus({
        keychainHasIdentity: proof.hasValidIdentity,
        portalRows: reread.rows,
      }),
    )
    if (!proof.hasValidIdentity) {
      logger.fail(
        [
          'What: the keychain does not show a valid identity after import.',
          `Where: security find-identity -v -p codesigning`,
          `Saw: ${DEVELOPER_ID_IDENTITY_LABEL} not listed as valid.`,
          'Wanted: the identity listed and valid.',
          'Fix: re-run `security find-identity -v -p codesigning` by hand and inspect the import.',
        ].join('\n'),
      )
      return 1
    }
    if (reread.rows !== priorRows + 1) {
      logger.warn(
        `Portal re-read shows ${reread.rows} Developer ID Application row(s); expected ${priorRows + 1}. ` +
          'The keychain identity is valid regardless — reconcile the portal listing by hand if the count looks wrong.',
      )
    }
    logger.success(
      `Imported ${DEVELOPER_ID_IDENTITY_LABEL} — verified via security find-identity and the re-read portal list.`,
    )
    return 0
  } finally {
    await safeDelete(tmpDir)
  }
}

async function runCreate(config: {
  allowAdditional: boolean
  drive: boolean
  profileDir?: string | undefined
}): Promise<number> {
  const cfg = { __proto__: null, ...config } as typeof config
  const keychain = await readKeychainState()
  const session = await openAppleSession({ profileDir: cfg.profileDir })
  try {
    const { rows, state } = await readCertificatesListPage(session.page)
    if (state !== 'readable') {
      logger.fail(describeUnreadableCertificatesList(state))
      return 1
    }
    // The team is SESSION state the operator picks in the portal's own
    // switcher — `?teamId=…` does not change it (measured live 2026-08-10:
    // the page rendered the personal team while the URL named Socket Inc.).
    // Read it and refuse on a mismatch: a certificate minted on the wrong
    // team is the one mistake in this flow that cannot be undone quietly.
    // Drive the portal's own switcher first — the team is keyed by data-id,
    // so this is deterministic. Only if that does not take do we fall back to
    // asking the operator, which costs them a manual step mid-run.
    let teamId = await readPortalTeamId(session.page)
    if (teamId !== DEVELOPER_ID_TEAM_ID) {
      logger.log(`Switching the portal to ${DEVELOPER_ID_ORG_NAME}…`)
      teamId = await switchPortalTeam(session.page, DEVELOPER_ID_TEAM_ID)
    }
    if (teamId !== DEVELOPER_ID_TEAM_ID) {
      teamId = await waitForPortalTeam(session.page, {
        onWait: () => {
          logger.log(
            `Could not switch automatically. Select ${DEVELOPER_ID_ORG_NAME} in the Chrome window; waiting…`,
          )
          void showOperatorNote(session.page, {
            body: `This session is on the wrong team, and the certificate must be created on ${DEVELOPER_ID_ORG_NAME}.`,
            kicker: 'Waiting for you',
            steps: [
              'Click your name at the top right',
              `Choose ${DEVELOPER_ID_ORG_NAME}`,
              'The agent continues by itself',
            ],
            title: 'Switch the team',
            tone: 'wait',
          })
        },
        wantedTeamId: DEVELOPER_ID_TEAM_ID,
      })
    }
    if (teamId !== DEVELOPER_ID_TEAM_ID) {
      logger.fail(
        [
          'What: the portal session is scoped to the wrong team.',
          `Where: ${CERTIFICATES_LIST_URL}`,
          `Saw: team ${teamId ?? '(unreadable)'} — wanted ${DEVELOPER_ID_TEAM_ID} (${DEVELOPER_ID_ORG_NAME}).`,
          'Fix: in the Chrome window, use the account switcher at the top of',
          `      the page to select ${DEVELOPER_ID_ORG_NAME}, then re-run.`,
        ].join('\n'),
      )
      return 1
    }
    const decision = decideDeveloperIdCertPlan({
      allowAdditional: cfg.allowAdditional,
      keychainHasIdentity: keychain.hasValidIdentity,
      portalRows: rows,
    })
    logger.log(renderDeveloperIdPlan(decision))
    if (decision.kind === 'skip') {
      return 0
    }
    if (decision.kind === 'refuse') {
      return 1
    }
    if (!cfg.drive) {
      // A dry run READS the add page too. Without this it returned before
      // ever touching it, so `--drive` would meet the write-path selectors
      // for the first time DURING the write — the exact thing the
      // read → dry-run → drive ladder exists to prevent. This is still
      // read-only: it loads the page and reports which option state it
      // found, and clicks nothing.
      const { optionState } = await readCertificateAddPage(session.page)
      logger.log(
        optionState === 'available'
          ? `add page: "${DEVELOPER_ID_CERTIFICATE_TYPE_LABEL}" is offered and enabled.`
          : describeMissingDeveloperIdOption({
              optionState,
              url: CERTIFICATES_ADD_URL,
            }),
      )
      return optionState === 'available' ? 0 : 1
    }
    return await driveCreate(session, rows)
  } finally {
    await session.close()
  }
}

async function runExportP12(config: {
  outputPath?: string | undefined
}): Promise<number> {
  const cfg = { __proto__: null, ...config } as typeof config
  const passphrase = process.env[P12_PASSPHRASE_ENV]
  if (!passphrase) {
    logger.fail(
      [
        'What: export-p12 needs a passphrase and none was set.',
        `Where: the ${P12_PASSPHRASE_ENV} environment variable.`,
        'Saw: the variable is unset or empty.',
        'Wanted: a passphrase to protect the exported .p12.',
        `Fix: export ${P12_PASSPHRASE_ENV}=<passphrase>, then re-run.`,
      ].join('\n'),
    )
    return 1
  }
  const outputPath = cfg.outputPath ?? path.join(RUN_DIR, 'developer-id.p12')
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  const result = await exportP12({ cwd: rootPath, outputPath, passphrase })
  if (result.code !== 0) {
    logger.fail(
      [
        'What: exporting the identity as a .p12 failed.',
        `Where: ${outputPath}`,
        `Saw: security export exited ${result.code}.`,
        'Wanted: a password-protected .p12 file, exit 0.',
        'Fix: confirm the login keychain holds the identity, then re-run.',
      ].join('\n'),
    )
    return 1
  }
  logger.success(`Exported to ${outputPath}.`)
  logger.log(
    [
      'Next (run these yourself — the passphrase never leaves this machine):',
      `  gh secret set APPLE_DEVELOPER_ID_P12_B64 --body "$(base64 -i ${outputPath})"`,
      `  gh secret set APPLE_DEVELOPER_ID_P12_PASSWORD --body "$${P12_PASSPHRASE_ENV}"`,
    ].join('\n'),
  )
  return 0
}

export interface CliArgs {
  allowAdditional: boolean
  drive: boolean
  inputPath?: string | undefined
  mode: 'create' | 'csr' | 'export-p12' | 'import' | 'status'
  outputPath?: string | undefined
  profileDir?: string | undefined
}

const USAGE =
  'Usage: developer-id-cert.mts status|csr|import|create|export-p12 ' +
  '[--drive] [--allow-additional] [--profile-dir <dir>] [--output <path>] ' +
  '[--input <path>]'

export const CLI_MODES: ReadonlyArray<CliArgs['mode']> = [
  'create',
  'csr',
  'export-p12',
  'import',
  'status',
]

/**
 * Whether `value` names a mode this CLI implements. A type guard rather than
 * a bare `includes`, so the parsed mode narrows for the caller.
 */
export function isCliMode(value: string | undefined): value is CliArgs['mode'] {
  return value !== undefined && CLI_MODES.includes(value as CliArgs['mode'])
}

/**
 * Parse the CLI mode word and its flags. Exits, usage error, on an unknown
 * mode/flag or a value-taking flag with no value. Pure over its input plus
 * process.exit — exported for tests.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const mode = argv[0]
  if (!isCliMode(mode)) {
    logger.fail(USAGE)
    process.exit(1)
  }
  let allowAdditional = false
  let drive = false
  let inputPath: string | undefined
  let outputPath: string | undefined
  let profileDir: string | undefined
  for (let i = 1, { length } = argv; i < length; i += 1) {
    const arg = argv[i]!
    if (arg === '--drive') {
      drive = true
      continue
    }
    if (arg === '--allow-additional') {
      allowAdditional = true
      continue
    }
    if (arg === '--input' || arg === '--output' || arg === '--profile-dir') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) {
        logger.fail(`Flag ${arg} needs a value.`)
        process.exit(1)
      }
      if (arg === '--input') {
        inputPath = value
      } else if (arg === '--output') {
        outputPath = value
      } else {
        profileDir = value
      }
      i += 1
      continue
    }
    logger.fail(`Unknown flag: ${arg}`)
    logger.error(USAGE)
    process.exit(1)
  }
  return { allowAdditional, drive, inputPath, mode, outputPath, profileDir }
}

/**
 * `csr`: generate the keypair HERE and emit only the CSR, so a certificate
 * can be minted by someone else without the private key ever leaving this
 * machine. Apple reserves Developer ID creation for a team's Account Holder,
 * and whoever generates the key holds it — so the naive delegation, "the
 * Account Holder makes the whole thing and sends it over", puts the signing
 * key on their laptop and moves a secret between people. A CSR is not
 * secret: it carries the public key and the subject, nothing more.
 */
export async function runCsr(config: {
  outputPath?: string | undefined
}): Promise<number> {
  const cfg = { __proto__: null, ...config } as typeof config
  const dest = path.resolve(
    cfg.outputPath ?? path.join(RUN_DIR, 'developer-id.csr'),
  )
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'socket-developer-id-csr-'),
  )
  try {
    const { csrPath } = await generateAndImportCsr({ tmpDir })
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.copyFile(csrPath, dest)
    logger.log(
      [
        `CSR written: ${dest}`,
        'The private key is in your login keychain and never leaves this machine.',
        '',
        'Hand the CSR to the team Account Holder. They upload it at',
        `  ${CERTIFICATES_ADD_URL}`,
        `  choosing "${DEVELOPER_ID_CERTIFICATE_TYPE_LABEL}", then send back the .cer.`,
        '',
        'Then run: developer-id-cert.mts import --input <the .cer>',
      ].join('\n'),
    )
    return 0
  } finally {
    await safeDelete(tmpDir)
  }
}

/**
 * `import`: take the `.cer` the Account Holder issued from our CSR, verify
 * its subject BEFORE it touches the keychain, import it, and prove the
 * identity from `security find-identity` rather than from the import's own
 * exit code.
 */
export async function runImport(config: {
  inputPath?: string | undefined
}): Promise<number> {
  const cfg = { __proto__: null, ...config } as typeof config
  if (!cfg.inputPath) {
    logger.fail(
      [
        'What: import needs the certificate the Account Holder issued.',
        'Where: --input was not passed.',
        'Saw: no path — wanted the .cer downloaded from the portal.',
        'Fix: developer-id-cert.mts import --input ~/Downloads/developerID_application.cer',
      ].join('\n'),
    )
    return 1
  }
  const certPath = path.resolve(cfg.inputPath)
  if (!existsSync(certPath)) {
    logger.fail(
      [
        'What: the certificate to import does not exist.',
        `Where: ${certPath}`,
        'Saw: no file at that path — wanted the issued .cer.',
        'Fix: pass the path the portal download actually landed at.',
      ].join('\n'),
    )
    return 1
  }
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'socket-developer-id-import-'),
  )
  try {
    // Verify the subject BEFORE the keychain sees it: a .cer for the wrong
    // team or the wrong org is a wrong artifact, and importing first would
    // mean discovering that after the fact.
    const verdict = verifyDeveloperIdSubject(
      await readDerSubject({ certPath, cwd: tmpDir }),
    )
    if (!verdict.ok) {
      logger.fail(
        [
          'What: the issued certificate is not the Socket Developer ID identity.',
          `Where: ${certPath}`,
          `Saw: ${verdict.reason}.`,
          `Wanted: a ${DEVELOPER_ID_CERTIFICATE_TYPE_LABEL} for ${DEVELOPER_ID_ORG_NAME} (${DEVELOPER_ID_TEAM_ID}).`,
          'Fix: confirm the Account Holder uploaded THIS machine’s CSR on the Socket team, then re-run.',
        ].join('\n'),
      )
      return 1
    }
    const imported = await importCertificate({ certPath, cwd: tmpDir })
    if (imported.code !== 0) {
      logger.fail(
        [
          'What: importing the Developer ID certificate failed.',
          `Where: ${certPath}`,
          `Saw: security import exited ${imported.code}.`,
          'Wanted: exit 0 and the identity present in the login keychain.',
          'Fix: read the security output above; a missing private key means the CSR came from a different machine.',
        ].join('\n'),
      )
      return 1
    }
    const keychain = await readKeychainState()
    if (!keychain.hasValidIdentity) {
      logger.fail(
        [
          'What: the certificate imported but no usable signing identity appeared.',
          'Where: the login keychain.',
          `Saw: security find-identity lists no valid "${DEVELOPER_ID_IDENTITY_LABEL}".`,
          'Wanted: that identity, valid.',
          'Fix: the private key for this certificate is missing — generate a fresh CSR here with `csr` and have it re-issued.',
        ].join('\n'),
      )
      return 1
    }
    logger.log(`Imported. ${DEVELOPER_ID_IDENTITY_LABEL} is ready to sign.`)
    return 0
  } finally {
    await safeDelete(tmpDir)
  }
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.mode === 'status') {
    process.exitCode = await runStatus({ profileDir: args.profileDir })
    return
  }
  if (args.mode === 'csr') {
    process.exitCode = await runCsr({ outputPath: args.outputPath })
    return
  }
  if (args.mode === 'import') {
    process.exitCode = await runImport({ inputPath: args.inputPath })
    return
  }
  if (args.mode === 'create') {
    process.exitCode = await runCreate({
      allowAdditional: args.allowAdditional,
      drive: args.drive,
      profileDir: args.profileDir,
    })
    return
  }
  process.exitCode = await runExportP12({ outputPath: args.outputPath })
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'reads and creates the Socket Inc. Developer ID Application signing identity via the Apple Developer portal',
  help: `${USAGE}

  --drive               take the wheel of the signed-in session and execute (create is dry-run by default)
  --allow-additional    allow creating a certificate even when the portal already lists one
  --profile-dir <dir>   use another browser profile directory
  --output <path>       csr's / export-p12's output path
  --input <path>        import's source .cer

Modes:
  status       what the keychain and the portal each hold, read-only
  csr          generate the keypair HERE and emit only the request, for an
               Account Holder to upload; the private key never leaves
  import       install the .cer they send back, subject-verified first
  create       do it all in one session — needs Account Holder yourself
  export-p12   export the identity for CI custody

  Apple reserves Developer ID creation for the team's ACCOUNT HOLDER, so
  csr + import is the path when you are not that role.

  export-p12 reads its passphrase from ${P12_PASSPHRASE_ENV}, never from argv.`,
}

// Entrypoint-guarded: importing this module (unit tests of its exported
// helpers) must not launch a browser.
if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
