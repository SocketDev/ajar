/**
 * @file Apple Developer ID keychain + CSR command plans: pure builders for
 *   every openssl/security invocation this driver needs — key generation,
 *   CSR creation, private-key/certificate import with the codesign ACL, the
 *   `find-identity` probe, the issued DER certificate's subject parse, and
 *   the operator-run `.p12` export — plus thin executors that run them
 *   through the same capturing spawn helper every other registry-infra
 *   driver uses (`runCapture` from `../shared.mts`). Every builder is a pure
 *   function returning an argv array: no execution, no filesystem, no
 *   network, so command construction is unit-tested from fixtures.
 *   Running openssl or security for real is out of scope for a test.
 */

import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import path from 'node:path'

import { runCapture } from '../shared.mts'
import {
  DEVELOPER_ID_COMMON_NAME,
  DEVELOPER_ID_SUBJECT_EMAIL,
  DEVELOPER_ID_TEAM_ID,
} from './developer-id-plan.mts'

export const CSR_KEY_ALGORITHM = 'RSA'
export const CSR_KEY_BITS = 2048

/**
 * The CSR subject exactly as the signing plan specifies it —
 * `emailAddress=jdalton@socket.dev, CN=Socket Inc. Developer ID` — in
 * openssl `-subj`'s slash-separated shape. No organization/unit here: those
 * belong to the certificate Apple ISSUES, not to the request.
 */
export const CSR_SUBJECT = `/emailAddress=${DEVELOPER_ID_SUBJECT_EMAIL}/CN=${DEVELOPER_ID_COMMON_NAME}`

/**
 * The function shape every executor below runs a command through:
 * `runCapture`'s signature, injectable so a test can prove an executor calls
 * the right binary with the right argv without ever spawning it.
 */
export type CommandRunner = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string }>

/**
 * `openssl genpkey` argv that writes a 2048-bit RSA private key to
 * `keyPath`. Pure — exported for tests.
 */
export function buildGenPkeyArgs(keyPath: string): string[] {
  return [
    'genpkey',
    '-algorithm',
    CSR_KEY_ALGORITHM,
    '-pkeyopt',
    `rsa_keygen_bits:${CSR_KEY_BITS}`,
    '-out',
    keyPath,
  ]
}

/**
 * `openssl req` argv that turns `keyPath`'s key into a CSR at `csrPath`,
 * subject fixed to {@link CSR_SUBJECT}. Pure — exported for tests.
 */
export function buildCsrArgs(config: {
  csrPath: string
  keyPath: string
}): string[] {
  const cfg = { __proto__: null, ...config } as typeof config
  return [
    'req',
    '-new',
    '-key',
    cfg.keyPath,
    '-out',
    cfg.csrPath,
    '-subj',
    CSR_SUBJECT,
  ]
}

/**
 * `security import` argv that imports `keyPath`'s private key into a
 * keychain with the codesign ACL — `-T /usr/bin/codesign` is what stops the
 * per-shell re-prompt loop every later `codesign` invocation would otherwise
 * hit. Pure — exported for tests.
 */
export function buildImportKeyArgs(config: {
  keychain?: string | undefined
  keyPath: string
}): string[] {
  const cfg = { __proto__: null, ...config } as typeof config
  const args = ['import', cfg.keyPath, '-T', '/usr/bin/codesign']
  if (cfg.keychain) {
    args.push('-k', cfg.keychain)
  }
  return args
}

/**
 * `security import` argv that imports a downloaded `.cer` into a keychain.
 * Pure — exported for tests.
 */
export function buildImportCertArgs(config: {
  certPath: string
  keychain?: string | undefined
}): string[] {
  const cfg = { __proto__: null, ...config } as typeof config
  const args = ['import', cfg.certPath]
  if (cfg.keychain) {
    args.push('-k', cfg.keychain)
  }
  return args
}

/**
 * `security find-identity` argv for the codesigning-policy probe. Pure —
 * exported for tests.
 */
export function buildFindIdentityArgs(): string[] {
  return ['find-identity', '-v', '-p', 'codesigning']
}

/**
 * `openssl x509` argv that reads a DER certificate's subject line without
 * touching any keychain. Pure — exported for tests.
 */
export function buildParseDerSubjectArgs(certPath: string): string[] {
  return ['x509', '-inform', 'der', '-in', certPath, '-noout', '-subject']
}

/**
 * `security export` argv for the operator-run PKCS#12 custody handoff. The
 * passphrase is an argv value because `security export` has no
 * stdin-piped passphrase form — the executor's caller owns not logging it;
 * this builder only shapes the command.
 */
export function buildExportP12Args(config: {
  outputPath: string
  passphrase: string
}): string[] {
  const cfg = { __proto__: null, ...config } as typeof config
  return [
    'export',
    '-t',
    'identities',
    '-f',
    'pkcs12',
    '-o',
    cfg.outputPath,
    '-P',
    cfg.passphrase,
  ]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether a `security find-identity -v -p codesigning` run's `stdout` shows
 * `label` as a VALID identity: present in a quoted match with nothing
 * trailing the closing quote on that line, and the summary's valid count at
 * least one. A revoked or expired identity still lists the label but appends
 * a parenthetical after the closing quote
 * (`"…" (CSSMERR_TP_CERT_REVOKED)`), which reads as absent, never present.
 * Pure — exported for tests.
 */
export function keychainHasValidIdentity(
  stdout: string,
  label: string,
): boolean {
  const lineMatch = new RegExp(`"${escapeRegExp(label)}"(.*)$`, 'm').exec(
    stdout,
  )
  if (!lineMatch || (lineMatch[1] ?? '').trim() !== '') {
    return false
  }
  const countMatch = /(\d+)\s+valid identities found/.exec(stdout)
  return countMatch ? Number(countMatch[1]) > 0 : false
}

/**
 * The fields this driver cares about out of an X.509 subject line: the
 * common name and organizational unit.
 */
export interface DerSubjectFields {
  commonName?: string | undefined
  organizationalUnit?: string | undefined
}

function applyDerField(
  fields: DerSubjectFields,
  key: string,
  value: string,
): void {
  if (key === 'CN') {
    fields.commonName = value
  } else if (key === 'OU') {
    fields.organizationalUnit = value
  }
}

/**
 * Parse `openssl x509 -noout -subject`'s one-line output into
 * {@link DerSubjectFields}. Handles both shapes openssl versions render: the
 * legacy slash-separated form (`subject= /CN=…/OU=…/O=…/C=…`) and the
 * modern comma-separated form (`subject=CN = …, OU = …, O = …, C = …`).
 * Pure — exported for tests.
 */
export function parseDerSubjectOutput(stdout: string): DerSubjectFields {
  const line =
    stdout.split(/\r?\n/).find(l => l.startsWith('subject=')) ?? stdout
  const body = line.replace(/^subject=\s*/, '').trim()
  const fields: DerSubjectFields = {}
  const parts = body.startsWith('/') ? body.split('/') : body.split(',')
  for (let i = 0, { length } = parts; i < length; i += 1) {
    const part = parts[i]!.trim()
    if (!part) {
      continue
    }
    const eq = part.indexOf('=')
    if (eq === -1) {
      continue
    }
    applyDerField(fields, part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  return fields
}

/**
 * Whether an issued certificate's subject fields match this identity's
 * required shape: CN exactly {@link DEVELOPER_ID_COMMON_NAME} and OU exactly
 * the team id. A mismatch on either is refused before the certificate ever
 * touches a keychain. Pure — exported for tests.
 */
export function verifyDeveloperIdSubject(fields: DerSubjectFields): {
  ok: boolean
  reason?: string | undefined
} {
  if (fields.commonName !== DEVELOPER_ID_COMMON_NAME) {
    return {
      ok: false,
      reason: `subject CN was ${fields.commonName ?? '(none)'}, wanted ${DEVELOPER_ID_COMMON_NAME}`,
    }
  }
  if (fields.organizationalUnit !== DEVELOPER_ID_TEAM_ID) {
    return {
      ok: false,
      reason: `subject OU was ${fields.organizationalUnit ?? '(none)'}, wanted ${DEVELOPER_ID_TEAM_ID}`,
    }
  }
  return { ok: true }
}

async function runOpenssl(
  args: string[],
  cwd: string,
  run: CommandRunner = runCapture,
): Promise<{ code: number; stdout: string }> {
  return run('openssl', args, cwd)
}

async function runSecurity(
  args: string[],
  cwd: string,
  run: CommandRunner = runCapture,
): Promise<{ code: number; stdout: string }> {
  return run('security', args, cwd)
}

/**
 * Generate the 2048-bit RSA private key at `keyPath`.
 */
export async function generatePrivateKey(config: {
  cwd: string
  keyPath: string
  run?: CommandRunner | undefined
}): Promise<{ code: number; stdout: string }> {
  const cfg = { __proto__: null, ...config } as typeof config
  return runOpenssl(buildGenPkeyArgs(cfg.keyPath), cfg.cwd, cfg.run)
}

/**
 * Generate the CSR at `csrPath` from `keyPath`'s key.
 */
export async function generateCsr(config: {
  csrPath: string
  cwd: string
  keyPath: string
  run?: CommandRunner | undefined
}): Promise<{ code: number; stdout: string }> {
  const cfg = { __proto__: null, ...config } as typeof config
  return runOpenssl(
    buildCsrArgs({ csrPath: cfg.csrPath, keyPath: cfg.keyPath }),
    cfg.cwd,
    cfg.run,
  )
}

/**
 * Import `keyPath`'s private key into a keychain with the codesign ACL.
 */
export async function importPrivateKey(config: {
  cwd: string
  keychain?: string | undefined
  keyPath: string
  run?: CommandRunner | undefined
}): Promise<{ code: number; stdout: string }> {
  const cfg = { __proto__: null, ...config } as typeof config
  return runSecurity(
    buildImportKeyArgs({ keychain: cfg.keychain, keyPath: cfg.keyPath }),
    cfg.cwd,
    cfg.run,
  )
}

/**
 * Import a downloaded `.cer` into a keychain.
 */
export async function importCertificate(config: {
  certPath: string
  cwd: string
  keychain?: string | undefined
  run?: CommandRunner | undefined
}): Promise<{ code: number; stdout: string }> {
  const cfg = { __proto__: null, ...config } as typeof config
  return runSecurity(
    buildImportCertArgs({ certPath: cfg.certPath, keychain: cfg.keychain }),
    cfg.cwd,
    cfg.run,
  )
}

/**
 * Probe the login keychain for a valid Developer ID Application identity.
 * Returns the raw stdout alongside the verdict so a caller can render it
 * (`status`'s report) without a second invocation.
 */
export async function findCodesigningIdentity(config: {
  cwd: string
  label: string
  run?: CommandRunner | undefined
}): Promise<{ hasValidIdentity: boolean; stdout: string }> {
  const cfg = { __proto__: null, ...config } as typeof config
  const { code, stdout } = await runSecurity(
    buildFindIdentityArgs(),
    cfg.cwd,
    cfg.run,
  )
  return {
    hasValidIdentity: code === 0 && keychainHasValidIdentity(stdout, cfg.label),
    stdout,
  }
}

/**
 * Read and parse an issued DER certificate's subject fields.
 */
export async function readDerSubject(config: {
  certPath: string
  cwd: string
  run?: CommandRunner | undefined
}): Promise<DerSubjectFields> {
  const cfg = { __proto__: null, ...config } as typeof config
  const { stdout } = await runOpenssl(
    buildParseDerSubjectArgs(cfg.certPath),
    cfg.cwd,
    cfg.run,
  )
  return parseDerSubjectOutput(stdout)
}

/**
 * Export the identity as a password-protected `.p12` — the operator-run
 * custody step (`export-p12`), never part of an unattended `create --drive`.
 */
export async function exportP12(config: {
  cwd: string
  outputPath: string
  passphrase: string
  run?: CommandRunner | undefined
}): Promise<{ code: number; stdout: string }> {
  const cfg = { __proto__: null, ...config } as typeof config
  return runSecurity(
    buildExportP12Args({
      outputPath: cfg.outputPath,
      passphrase: cfg.passphrase,
    }),
    cfg.cwd,
    cfg.run,
  )
}

/**
 * The CSR pipeline's result: the CSR the operator uploads, sitting alone in
 * `tmpDir` — the private key that produced it has already been imported
 * into the keychain and its temporary copy unlinked from disk.
 */
export interface CsrGenerationResult {
  csrPath: string
  tmpDir: string
}

/**
 * Run the private-key, import, and CSR steps in the order the signing plan
 * requires: generate the key, import it into a keychain with the codesign
 * ACL, generate the CSR from it, and only afterward unlink the temporary key
 * material — so the private key's disk lifetime is the few milliseconds
 * between the three commands rather than the whole run. Throws a
 * What/Where/Saw/Wanted/Fix block on the first failing step. The unlink
 * runs on every path once import has run, success or failure, since a key
 * already inside the keychain has no further use sitting in a tmpdir.
 */
export async function generateAndImportCsr(config: {
  keychain?: string | undefined
  run?: CommandRunner | undefined
  tmpDir: string
}): Promise<CsrGenerationResult> {
  const cfg = { __proto__: null, ...config } as typeof config
  const keyPath = path.join(cfg.tmpDir, 'developer-id.key')
  const csrPath = path.join(cfg.tmpDir, 'developer-id.csr')
  const genKey = await generatePrivateKey({
    cwd: cfg.tmpDir,
    keyPath,
    run: cfg.run,
  })
  if (genKey.code !== 0) {
    throw new Error(
      [
        'What: generating the Developer ID private key failed.',
        `Where: ${keyPath}`,
        `Saw: openssl genpkey exited ${genKey.code}.`,
        'Wanted: a 2048-bit RSA private key, exit 0.',
        'Fix: confirm openssl is installed and on PATH, then re-run.',
      ].join('\n'),
    )
  }
  try {
    const imported = await importPrivateKey({
      cwd: cfg.tmpDir,
      keychain: cfg.keychain,
      keyPath,
      run: cfg.run,
    })
    if (imported.code !== 0) {
      throw new Error(
        [
          'What: importing the Developer ID private key into the keychain failed.',
          `Where: ${keyPath}`,
          `Saw: security import exited ${imported.code}.`,
          'Wanted: the key imported with the codesign ACL, exit 0.',
          'Fix: confirm the login keychain is unlocked, then re-run.',
        ].join('\n'),
      )
    }
    const genCsr = await generateCsr({
      csrPath,
      cwd: cfg.tmpDir,
      keyPath,
      run: cfg.run,
    })
    if (genCsr.code !== 0) {
      throw new Error(
        [
          'What: generating the CSR from the imported private key failed.',
          `Where: ${csrPath}`,
          `Saw: openssl req exited ${genCsr.code}.`,
          'Wanted: a CSR file, exit 0.',
          'Fix: confirm openssl is installed and on PATH, then re-run.',
        ].join('\n'),
      )
    }
  } finally {
    await safeDelete(keyPath)
  }
  return { csrPath, tmpDir: cfg.tmpDir }
}
