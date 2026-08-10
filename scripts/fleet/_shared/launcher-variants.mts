/**
 * @file The prebuilt dispatch-launcher variant contract — ONE list of
 *   (platform, arch) → filename shared by the release-bundle producer (which
 *   stages CI-built binaries under {@link LAUNCHER_VARIANTS_REL_DIR}), the
 *   dir-mirror skip list (so a hydrated binary never reads as drift), and
 *   `build-snapshot-launcher.mts` (which copies a matching prebuilt instead
 *   of invoking `cc`). The launcher is ABI-independent — it only `execv`s /
 *   `CreateProcess`es node, never links it — so a variant is keyed by OS and
 *   arch alone and survives every node version switch. darwin ships ONE fat
 *   universal binary staged under BOTH darwin keys; linux variants are
 *   static-musl builds, so one binary per arch serves glibc and musl systems
 *   alike; win32-arm64 has no cross toolchain on the POSIX builders and takes
 *   the compile-or-baseline fallback.
 */

export const LAUNCHER_VARIANTS_REL_DIR = '.claude/hooks/fleet/_dist/launchers'

export interface LauncherVariant {
  arch: string
  fileName: string
  platform: string
}

/**
 * The bundle filename for a (platform, arch) pair — `.exe` suffixed on
 * Windows, bare elsewhere. Arch names follow node's `process.arch` values
 * (`ia32`, not `x86`) so the builder's lookup needs no mapping table.
 */
export function launcherVariantFileName(
  platform: string,
  arch: string,
): string {
  const ext = platform === 'win32' ? '.exe' : ''
  return `dispatch-launcher-${platform}-${arch}${ext}`
}

/**
 * The bundle-relative path of a variant, for producers and fetch validators.
 */
export function launcherVariantRelPath(platform: string, arch: string): string {
  return `${LAUNCHER_VARIANTS_REL_DIR}/${launcherVariantFileName(platform, arch)}`
}

/**
 * Every variant the release bundle may carry. A platform+arch absent here
 * (win32-arm64, any BSD) falls back to the host `cc` compile, and past that
 * to the compile-cache baseline — the fail-open ladder is unchanged.
 */
export const LAUNCHER_VARIANTS: readonly LauncherVariant[] = [
  {
    arch: 'arm64',
    fileName: launcherVariantFileName('darwin', 'arm64'),
    platform: 'darwin',
  },
  {
    arch: 'x64',
    fileName: launcherVariantFileName('darwin', 'x64'),
    platform: 'darwin',
  },
  {
    arch: 'arm64',
    fileName: launcherVariantFileName('linux', 'arm64'),
    platform: 'linux',
  },
  {
    arch: 'x64',
    fileName: launcherVariantFileName('linux', 'x64'),
    platform: 'linux',
  },
  {
    arch: 'ia32',
    fileName: launcherVariantFileName('win32', 'ia32'),
    platform: 'win32',
  },
  {
    arch: 'x64',
    fileName: launcherVariantFileName('win32', 'x64'),
    platform: 'win32',
  },
]
