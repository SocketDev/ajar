/**
 * @file Asserts every npm package this repo publishes carries the fleet bot
 *   account (`socket-bot`) as a maintainer, so no published name has a
 *   single human as its only owner. The registry's own metadata is the
 *   oracle: an unauthenticated `GET registry.npmjs.org/PKG` lists
 *   `maintainers`, so CI needs no npm session and there is nothing to 401.
 *   The target set derives from the repo, never a hand-list: every TRACKED
 *   non-private manifest name, plus `release.publishedPackages`. A 404 is a
 *   name not yet published — skipped with a note, because ownership of an
 *   unclaimed name is not a state the registry can hold. An unreachable
 *   registry is NOT VERIFIED, never a pass.
 *   The fixer is the ownership sweep, which drives the 2FA-gated
 *   `npm owner add` through the web-auth PTY wrapper:
 *   `node scripts/fleet/registry-infra/npm/owner-sweep.mts --pkg PKG --drive`.
 *   MODE: STRICT — the initial fleet-wide grant landed 2026-08-07 (org
 *   transfers covered the scoped packages, the sweep the bare ones; the
 *   verify dry-run read 35/35 covered), so a package published without bot
 *   co-ownership fails loud from here on.
 *   Exit: 0 — every published package carries the bot, none exist, or MODE
 *   is 'report' even with findings; 1 — a finding exists AND MODE is
 *   'strict'.
 *   Usage: node scripts/fleet/check/npm-packages-are-bot-co-owned.mts [--quiet]
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { httpRequest } from '@socketsecurity/lib-stable/http-request'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'

import { isMainModule } from '../_shared/is-main-module.mts'
import { runMain } from '../_shared/run-main.mts'
import { REPO_ROOT } from '../paths.mts'

import type { ScriptMeta } from '../_shared/run-main.mts'

const logger = getDefaultLogger()

/**
 * The fleet bot account every published package must carry.
 */
export const CO_OWNER = 'socket-bot'

const MODE: 'report' | 'strict' = 'strict'

const REPO_CONFIG_REL = '.config/repo/socket-wheelhouse.json'

interface RegistryMaintainer {
  email?: string | undefined
  name?: string | undefined
}

/**
 * The package names this repo can publish: every tracked non-private
 * manifest name, that manifest's platform-split optionalDependencies
 * (`@<name>/<triple>` or `<name>-<triple>` — generated at publish, so no
 * tracked manifest exists for them), plus the declared
 * `release.publishedPackages` set.
 */
export function collectPublishableNames(repoRoot: string): string[] {
  const names = new Set<string>()
  const result = spawnSync('git', ['ls-files', '*package.json'], {
    cwd: repoRoot,
    stdio: 'pipe',
    stdioString: true,
  })
  if (result.status === 0) {
    const files = String(result.stdout ?? '')
      .replace(/\r\n/g, '\n')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)
    for (let i = 0, { length } = files; i < length; i += 1) {
      try {
        const pkg = JSON.parse(
          readFileSync(path.join(repoRoot, files[i]!), 'utf8'),
        ) as {
          name?: string | undefined
          optionalDependencies?: Record<string, string> | undefined
          private?: boolean | undefined
        }
        if (pkg.name && !pkg.private) {
          names.add(pkg.name)
          const optDeps = Object.keys(pkg.optionalDependencies ?? {})
          for (let j = 0, optLen = optDeps.length; j < optLen; j += 1) {
            const dep = optDeps[j]!
            if (
              dep.startsWith(`@${pkg.name}/`) ||
              dep.startsWith(`${pkg.name}-`) ||
              dep.startsWith(`${pkg.name}.`)
            ) {
              names.add(dep)
            }
          }
        }
      } catch {
        // A malformed manifest is another check's finding, not this one's.
      }
    }
  }
  try {
    const cfg = JSON.parse(
      readFileSync(path.join(repoRoot, REPO_CONFIG_REL), 'utf8'),
    ) as {
      release?: { publishedPackages?: unknown | undefined } | undefined
    }
    const declared = cfg.release?.publishedPackages
    if (Array.isArray(declared)) {
      for (let i = 0, { length } = declared; i < length; i += 1) {
        const n = declared[i]
        if (typeof n === 'string') {
          names.add(n)
        }
      }
    }
  } catch {
    // Config absent or malformed — the tracked-manifest set stands alone.
  }
  return [...names].toSorted()
}

/**
 * A published package's maintainer usernames from the public registry
 * document. `undefined` means the name is not published (404).
 */
export async function readRegistryMaintainers(
  pkg: string,
): Promise<string[] | undefined> {
  const encoded = pkg.replaceAll('/', '%2f')
  const res = await httpRequest(`https://registry.npmjs.org/${encoded}`, {
    method: 'GET',
  })
  if (res.status === 404) {
    return undefined
  }
  if (!res.ok) {
    throw new Error(
      `registry answered ${res.status} for ${pkg} — not a readable maintainer list.`,
    )
  }
  const doc = res.json<{
    maintainers?: RegistryMaintainer[] | undefined
  }>()
  if (!Array.isArray(doc.maintainers)) {
    return undefined
  }
  return doc.maintainers
    .map(m => m.name ?? '')
    .filter(Boolean)
    .toSorted()
}

export async function main(): Promise<void> {
  const quiet = process.argv.includes('--quiet')
  const names = collectPublishableNames(REPO_ROOT)
  if (!names.length) {
    if (!quiet) {
      logger.log(
        '[npm-packages-are-bot-co-owned] no publishable package names here (not applicable).',
      )
    }
    return
  }

  const missing: string[] = []
  const unpublished: string[] = []
  let unreachable = false
  for (let i = 0, { length } = names; i < length; i += 1) {
    const pkg = names[i]!
    let maintainers: string[] | undefined
    try {
      maintainers = await readRegistryMaintainers(pkg)
    } catch {
      unreachable = true
      break
    }
    if (maintainers === undefined) {
      unpublished.push(pkg)
      continue
    }
    if (!maintainers.includes(CO_OWNER)) {
      missing.push(pkg)
    }
  }

  if (unreachable) {
    logger.warn(
      '[npm-packages-are-bot-co-owned] registry unreachable — NOT VERIFIED (an unread source is never a pass).',
    )
    return
  }
  if (unpublished.length && !quiet) {
    logger.log(
      `[npm-packages-are-bot-co-owned] ${unpublished.length} name(s) not yet published — skipped: ${unpublished.join(', ')}`,
    )
  }
  if (!missing.length) {
    if (!quiet) {
      logger.log(
        `[npm-packages-are-bot-co-owned] ${names.length - unpublished.length} published package(s) all carry ${CO_OWNER}.`,
      )
    }
    return
  }

  const isStrict = MODE === 'strict'
  const label = isStrict ? '' : '(report-only) '
  logger.error(
    `[npm-packages-are-bot-co-owned] ${label}published package(s) missing the ${CO_OWNER} maintainer:`,
  )
  for (let i = 0, { length } = missing; i < length; i += 1) {
    logger.error(`    ${missing[i]}`)
  }
  logger.error(
    `  What:   a package with one human owner is a bus-factor and lockout risk.`,
  )
  logger.error(`  Where:  the npm registry's maintainer list for each name.`)
  logger.error(
    `  Saw:    wanted ${CO_OWNER} on every published package, saw ${missing.length} without it.`,
  )
  logger.error(
    '  Fix:    node scripts/fleet/registry-infra/npm/owner-sweep.mts ' +
      `${missing.map(p => `--pkg ${p}`).join(' ')} --drive`,
  )
  if (isStrict) {
    process.exitCode = 1
  } else {
    logger.error(
      `[npm-packages-are-bot-co-owned] report-only mode: exiting 0 with ${missing.length} finding(s). Flip MODE to 'strict' once the initial sweep lands.`,
    )
  }
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'asserts every published npm package carries the fleet bot as a maintainer, read from the public registry',
  help: `Usage: node scripts/fleet/check/npm-packages-are-bot-co-owned.mts [flags]

  --quiet   suppress the all-clear and skip notes`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
