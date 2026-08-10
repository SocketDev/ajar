/**
 * @file THE fleet macOS code-signing path. Every member that ships a Mach-O
 *   binary signs through this module instead of carrying its own copy -
 *   `Developer ID Application` signs a CLI binary and an `.app` bundle the
 *   same way, because `codesign` treats both as Mach-O and there is no
 *   separate "CLI certificate". Consumers: node-smol's build output,
 *   socket-cli's SEA binary, sdxgen once perry compiles it to native code,
 *   depsight, and the Swift macOS apps agents-sleep-preventer and megaphone.
 *   `adHocSign` needs no certificate and satisfies the signature Gatekeeper
 *   requires to run a binary at all, notably on ARM64. `developerIdSign`
 *   signs with the Socket Inc. Developer ID Application identity (hardened
 *   runtime on by default) so the result can be notarized - see
 *   `apple-notarize.mts` for that step - and falls back to ad-hoc signing
 *   when the identity isn't installed in the keychain, the expected state on
 *   a machine that never had the Developer ID certificate provisioned.
 */

import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { errorMessage } from '@socketsecurity/lib-stable/errors/message'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'

const logger = getDefaultLogger()

// The Socket Inc. Developer ID Application identity, used when neither the
// caller nor APPLE_DEVELOPER_ID_IDENTITY names one.
const DEFAULT_DEVELOPER_ID_IDENTITY =
  'Developer ID Application: Socket Inc. (PZRCDQ736X)'

// Mach-O magic numbers (big-endian and little-endian for 32/64-bit).
// 32-bit big-endian: FEEDFACE. 32-bit little-endian: CEFAEDFE.
// 64-bit big-endian: FEEDFACF. 64-bit little-endian: CFFAEDFE.
const MACH_O_MAGIC = Object.freeze({
  CEFAEDFE: true,
  CFFAEDFE: true,
  FEEDFACE: true,
  FEEDFACF: true,
  __proto__: null,
})

/**
 * Ad-hoc code sign a binary for macOS. Ad-hoc signing needs no certificate
 * and satisfies the code-signing requirement a binary needs to run at all on
 * modern macOS, especially ARM64. Skips signing when the binary is already
 * validly signed (idempotent), and re-signs with `--force` when the existing
 * signature is invalid, for example right after stripping. Only signs actual
 * Mach-O binaries, verified by magic number, and only on darwin - everywhere
 * else this is a no-op. `beforeSign`, when given, runs right before the sign
 * call, only when signing is actually needed.
 */
export async function adHocSign(
  binaryPath: string,
  beforeSign?: (() => Promise<void> | void) | undefined,
): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }

  // Only sign actual Mach-O binaries (sniff magic number).
  // Skip non-binaries (.wasm, .js, .mts, etc.).
  if (!(await isMachOBinary(binaryPath))) {
    return
  }

  // Check if already signed (codesign --verify returns non-zero if not signed).
  try {
    await spawn('codesign', ['--verify', binaryPath], {
      stdio: 'ignore',
    })
    // Exit code 0 = already signed, skip.
    return
  } catch {
    // Exit code non-zero = not signed or invalid signature, continue to sign.
  }

  // Execute pre-signing callback (e.g., for logging).
  if (beforeSign) {
    await beforeSign()
  }

  // Sign the binary with --force so any invalid signature is replaced.
  try {
    logger.info(`Ad-hoc signing: ${path.basename(binaryPath)}`)
    await spawn('codesign', ['--sign', '-', '--force', binaryPath])
    logger.info('Binary signed successfully')
  } catch (e) {
    logger.fail(`Code signing failed: ${errorMessage(e)}`)
    throw e
  }
}

/**
 * Developer ID code sign a binary for macOS. Signs with a real Developer ID
 * Application certificate (hardened runtime by default) so the binary can
 * later be notarized. Falls back to ad-hoc signing, and returns `false`,
 * when the identity is not present in the keychain - the expected state on
 * a machine without the Developer ID certificate installed.
 */
export async function developerIdSign(
  binaryPath: string,
  options?: DeveloperIdSignOptions | undefined,
): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false
  }

  if (!(await isMachOBinary(binaryPath))) {
    return false
  }

  const resolvedOptions = {
    __proto__: null,
    ...options,
  } as DeveloperIdSignOptions
  const identity = resolveDeveloperIdIdentity(resolvedOptions.identity)

  if (!(await isIdentityInKeychain(identity))) {
    logger.info(
      `Developer ID identity signing unavailable ("${identity}" not found in keychain); falling back to ad-hoc signing.`,
    )
    await adHocSign(binaryPath)
    return false
  }

  try {
    logger.info(`Developer ID signing: ${path.basename(binaryPath)}`)
    await spawn('codesign', selectCodesignArgs(binaryPath, resolvedOptions))
    logger.info('Binary signed successfully with Developer ID identity')
    return true
  } catch (e) {
    throw new Error(
      [
        `What:  Developer ID code signing failed for ${path.basename(binaryPath)}.`,
        `Where: codesign ${selectCodesignArgs(binaryPath, resolvedOptions).join(' ')}`,
        `Saw:   ${errorMessage(e)} - wanted a clean exit (code 0).`,
        'Fix:   confirm the certificate is installed in the login keychain and its',
        '       common name matches APPLE_DEVELOPER_ID_IDENTITY, then re-run',
        '       codesign directly to inspect the failure.',
      ].join('\n'),
    )
  }
}

/**
 * Check whether a signing identity is present in the keychain, by looking
 * for it in `security find-identity`'s codesigning list.
 */
export async function isIdentityInKeychain(identity: string): Promise<boolean> {
  try {
    const { stdout } = await spawn('security', [
      'find-identity',
      '-v',
      '-p',
      'codesigning',
    ])
    return stdout.includes(identity)
  } catch {
    return false
  }
}

/**
 * Check whether a file is a Mach-O binary by reading its magic number.
 * Returns `false` for a missing file or any read failure.
 */
export async function isMachOBinary(filePath: string): Promise<boolean> {
  if (!existsSync(filePath)) {
    return false
  }

  try {
    const buffer = Buffer.allocUnsafe(4)
    const fd = await fs.open(filePath, 'r')
    try {
      await fd.read(buffer, 0, 4, 0)
    } finally {
      await fd.close()
    }

    const magic = buffer.toString('hex').toUpperCase()
    return magic in MACH_O_MAGIC
  } catch {
    return false
  }
}

/**
 * Options for Developer ID identity signing: an absolute path to an
 * entitlements plist to embed with `--entitlements`, whether the hardened
 * runtime is enabled via `--options runtime` (on by default; pass `false`
 * to disable), and the signing identity to pass to `--sign` (defaults to
 * `APPLE_DEVELOPER_ID_IDENTITY`, then the Socket Inc. identity).
 */
export interface DeveloperIdSignOptions {
  entitlementsPath?: string | undefined
  hardenedRuntime?: boolean | undefined
  identity?: string | undefined
}

/**
 * Resolve the Developer ID identity to sign with: an explicit identity wins,
 * then APPLE_DEVELOPER_ID_IDENTITY, then the Socket Inc. default.
 */
export function resolveDeveloperIdIdentity(
  identity: string | undefined,
): string {
  return (
    identity ||
    process.env['APPLE_DEVELOPER_ID_IDENTITY'] ||
    DEFAULT_DEVELOPER_ID_IDENTITY
  )
}

/**
 * Build the `codesign` argument list for Developer ID identity signing. A
 * pure function - no filesystem or process access - so it is directly
 * unit-testable without spawning `codesign`.
 */
export function selectCodesignArgs(
  binaryPath: string,
  config: DeveloperIdSignOptions,
): string[] {
  const { entitlementsPath, hardenedRuntime, identity } = {
    __proto__: null,
    ...config,
  } as typeof config

  return [
    '--sign',
    resolveDeveloperIdIdentity(identity),
    '--force',
    '--timestamp',
    ...(hardenedRuntime !== false ? ['--options', 'runtime'] : []),
    ...(entitlementsPath ? ['--entitlements', entitlementsPath] : []),
    binaryPath,
  ]
}
