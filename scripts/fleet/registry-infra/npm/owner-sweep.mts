/**
 * @file Bulk owner sweep — grants an npm account (default `socket-bot`)
 *   maintainer access on every package the operator owns in the named
 *   scopes plus any bare package names, so single-human ownership stops
 *   being the fleet's bus factor.
 *   Enumeration comes from the registry itself, never a hand-list: a scope's
 *   package set is read via `npm access list packages <org>` (search skips
 *   0.0.0 placeholders, the org listing does not), and each package's
 *   current maintainers via `npm owner ls`. A package already carrying the
 *   grantee is the success case and is skipped — the sweep re-run is a
 *   no-op, not a re-grant.
 *   Writes go through the web-auth PTY wrapper (`npm-auth.mts owner add`)
 *   because `npm owner add` is a 2FA-gated write: the wrapper re-opens the
 *   browser when the 2FA-fresh window lapses. Reads that error are FAIL
 *   CLOSED — an unauthenticated `owner ls` reads as empty, and acting on
 *   that empties-looking answer is the unauthenticated-reads-as-empty trap.
 *   Dry-run by default; `--drive` performs the adds. Fail-soft per package,
 *   2s spacing per the registry rate-limit guidance, summary at the end,
 *   non-zero exit if anything failed.
 *   Usage: node scripts/fleet/registry-infra/npm/owner-sweep.mts
 *   [--scope <org>]… [--pkg <name>]… [--grantee <account>] [--drive]
 */

import process from 'node:process'

import { errorMessage } from '@socketsecurity/lib-stable/errors/message'

import { isMainModule } from '../../_shared/is-main-module.mts'
import { runMain } from '../../_shared/run-main.mts'
import { logger, runCapture } from '../shared.mts'
import { sleep } from './browser-session.mts'
import { npmScratchCwd } from './shared.mts'
import {
  allowReauthOnce,
  outputNeedsReauth,
  runWebAuthTool,
} from './web-auth-batch.mts'

import type { ScriptMeta } from '../../_shared/run-main.mts'

const PACE_MS = 2000

/**
 * Raised when a read errors — never classify an errored read as "empty".
 */
export class OwnerReadDiedError extends Error {}

/**
 * List every package in an npm org, via the authenticated org listing.
 */
export async function listOrgPackages(org: string): Promise<string[]> {
  const { code, stdout } = await runCapture(
    'npm',
    ['access', 'list', 'packages', org, '--json'],
    npmScratchCwd(),
  )
  if (code !== 0) {
    throw new OwnerReadDiedError(
      `npm access list packages ${org} exited ${code} — ` +
        'an errored listing reads as empty, so the sweep fails closed. ' +
        'Fix: re-run `node scripts/fleet/npm-auth.mts login` and retry.',
    )
  }
  const jsonStart = stdout.indexOf('{')
  if (jsonStart === -1) {
    return []
  }
  const parsed = JSON.parse(stdout.slice(jsonStart)) as Record<string, string>
  return Object.keys(parsed).toSorted()
}

/**
 * Current maintainers of a package, from `npm owner ls`.
 */
export async function listOwners(pkg: string): Promise<string[]> {
  const { code, stdout } = await runCapture(
    'npm',
    ['owner', 'ls', pkg],
    npmScratchCwd(),
  )
  if (code !== 0) {
    throw new OwnerReadDiedError(
      `npm owner ls ${pkg} exited ${code} — ` +
        'an errored read reads as no-owners, so the sweep fails closed.',
    )
  }
  // Output shape: one username-then-email pair per line; keep the username.
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean)
}

async function ownerAdd(
  grantee: string,
  pkg: string,
): Promise<{ code: number; stdout: string }> {
  // Through the batch-policy wrapper seam for the 2FA-gated write (first
  // call may open the auth page, the rest stay headless); scratch cwd
  // dodges the repo's devEngines pnpm veto. A failure carrying the
  // auth-page shape means the 2FA window lapsed mid-batch: re-arm ONE
  // browser open and retry this package — the cooldown opt-in that open
  // performs puts the rest of the batch back on the headless path.
  const first = await runWebAuthTool(
    ['owner', 'add', grantee, pkg],
    npmScratchCwd(),
  )
  if (first.code === 0 || !outputNeedsReauth(first.stdout)) {
    return first
  }
  logger.warn(
    `${pkg}: the 2FA window lapsed — reopening the auth page once and retrying.`,
  )
  allowReauthOnce()
  return await runWebAuthTool(['owner', 'add', grantee, pkg], npmScratchCwd())
}

/**
 * Every package the signed-in account can access — the full personal
 * inventory from npm's access listing keyed by the account name, org grants
 * included. The caller reviews the dry-run list before driving: an
 * org-governed scope may manage access through teams, not per-package
 * owners.
 */
export async function listMyPackages(): Promise<string[]> {
  const who = await runCapture('npm', ['whoami'], npmScratchCwd())
  const user = who.stdout
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\r?\n/)
    .at(-1)
    ?.trim()
  if (who.code !== 0 || !user) {
    throw new OwnerReadDiedError(
      'npm whoami failed — the sweep cannot enumerate an anonymous inventory. ' +
        'Fix: node scripts/fleet/npm-auth.mts login',
    )
  }
  return await listOrgPackages(user)
}

interface SweepArgs {
  drive: boolean
  grantee: string
  mine: boolean
  pkgs: string[]
  scopes: string[]
}

function parseArgs(argv: string[]): SweepArgs {
  const args: SweepArgs = {
    drive: false,
    grantee: 'socket-bot',
    mine: false,
    pkgs: [],
    scopes: [],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!
    if (a === '--drive') {
      args.drive = true
    } else if (a === '--mine') {
      args.mine = true
    } else if (a === '--grantee') {
      args.grantee = argv[++i] ?? args.grantee
    } else if (a === '--scope') {
      const s = argv[++i]
      if (s) {
        args.scopes.push(s.replace(/^@/, ''))
      }
    } else if (a === '--pkg') {
      const p = argv[++i]
      if (p) {
        args.pkgs.push(p)
      }
    }
  }
  return args
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.scopes.length && !args.pkgs.length && !args.mine) {
    logger.fail(
      'owner-sweep: no targets. Where: the argv. ' +
        'Saw: none of --scope, --pkg, --mine. ' +
        'Fix: pass --scope <org>, --pkg <name>, or --mine.',
    )
    process.exitCode = 1
    return
  }

  const worklist: string[] = [...args.pkgs]
  if (args.mine) {
    const mine = await listMyPackages()
    logger.info(`--mine: ${mine.length} package(s) from the account inventory`)
    worklist.push(...mine)
  }
  for (const scope of args.scopes) {
    const pkgs = await listOrgPackages(scope)
    logger.info(`@${scope}: ${pkgs.length} package(s) from the org listing`)
    worklist.push(...pkgs)
  }

  const granted: string[] = []
  const invited: string[] = []
  const skipped: string[] = []
  const failed: Array<{ pkg: string; reason: string }> = []

  for (let i = 0, { length } = worklist; i < length; i += 1) {
    const pkg = worklist[i]!
    try {
      const owners = await listOwners(pkg)
      if (owners.includes(args.grantee)) {
        skipped.push(pkg)
        logger.success(`${pkg}: ${args.grantee} already a maintainer`)
        continue
      }
      if (!args.drive) {
        granted.push(pkg)
        logger.info(`→ ${pkg}: would add ${args.grantee} (dry-run)`)
        continue
      }
      const { code, stdout } = await ownerAdd(args.grantee, pkg)
      if (code !== 0) {
        // A 409 "already has a pending invite" is the re-run success case —
        // the earlier invite is still waiting on the grantee's acceptance.
        if (/already has a pending invite/i.test(stdout)) {
          invited.push(pkg)
          logger.success(
            `${pkg}: ${args.grantee} already invited — pending their acceptance`,
          )
        } else {
          failed.push({ pkg, reason: stdout.slice(-200) })
          logger.fail(`${pkg}: owner add exited ${code}`)
        }
      } else {
        // Verify from the registry's own answer, never the write's echo —
        // with one sanctioned intermediate state: npm sends an ownership
        // INVITE the grantee must accept, so "invited ... successfully" is
        // this sweep's success and the maintainer list flips on acceptance.
        const after = await listOwners(pkg)
        if (after.includes(args.grantee)) {
          granted.push(pkg)
          logger.success(`${pkg}: added ${args.grantee}`)
        } else if (/invited to package .* successfully/i.test(stdout)) {
          invited.push(pkg)
          logger.success(
            `${pkg}: ${args.grantee} invited — pending their acceptance`,
          )
        } else {
          failed.push({
            pkg,
            reason: 'add exited 0 but neither a grant nor an invite landed',
          })
          logger.fail(`${pkg}: add reported success but did not land`)
        }
      }
      await sleep(PACE_MS)
    } catch (e) {
      if (e instanceof OwnerReadDiedError) {
        throw e
      }
      failed.push({ pkg, reason: errorMessage(e) })
      logger.fail(`${pkg}: ${errorMessage(e)}`)
    }
  }

  const mode = args.drive ? 'granted' : 'would grant'
  logger.info(
    `owner-sweep: ${mode} ${granted.length}, invited ${invited.length}, ` +
      `already-covered ${skipped.length}, failed ${failed.length} of ${worklist.length}`,
  )
  if (failed.length) {
    for (let i = 0, { length } = failed; i < length; i += 1) {
      const f = failed[i]!
      logger.fail(`  ${f.pkg}: ${f.reason}`)
    }
    process.exitCode = 1
  }
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'grants an npm account maintainer access across whole scopes plus bare packages, registry-verified',
  help: `Usage: node scripts/fleet/registry-infra/npm/owner-sweep.mts [flags]

  --scope <org>       sweep every package in the org (repeatable)
  --pkg <name>        include a bare package (repeatable)
  --mine              sweep the signed-in account's full package inventory
  --grantee <account> account to add (default socket-bot)
  --drive             perform the adds (dry-run by default)`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
