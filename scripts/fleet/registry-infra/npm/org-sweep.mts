/**
 * @file Reconciles npm ORG membership to the fleet's ownership law — the
 *   sibling of `owner-sweep.mts` for the org half the package sweep cannot
 *   reach (org roles govern scoped-package access wholesale; per-package
 *   owner adds cannot touch them, which is why the first fleet grant needed
 *   hand transfers). The law, from the socketregistry org's shape:
 *   `feross` holds `owner`, `socket-bot` holds `developer` (the web UI's
 *   "member"). The sweep SETS the missing roles it can and REPORTS the ones
 *   only a human can complete — npm refuses demoting the last owner, so
 *   stepping the acting account down from owner is reported as the
 *   remaining human move whenever it is refused.
 *   Reads come from `npm org ls ORGNAME --json` under the signed-in
 *   account; an errored read FAILS CLOSED (an unauthenticated org listing
 *   reads as empty — the same trap the owner sweep guards).
 *   Writes ride the shared batch-auth seam: the first 2FA-gated
 *   `npm org set` may open the auth page, the rest stay headless.
 *   KNOWN LIMIT (2026-08-08): the registry 404s the web-auth done-poll for
 *   `npm org set` performed by the bot account — three straight sessions
 *   died unapprovable, consistent with npm's account-changes 2FA
 *   restriction. When the sweep reports that failure shape, the working
 *   lane is the WEB UI as a signed-in org owner:
 *   npmjs.com/settings/ORGNAME/members — Invite the user (invitations
 *   expire after 7 days and land in the default team), then set roles
 *   after acceptance. Re-run this sweep afterwards as the verifier; its
 *   dry-run reporting all sites already-covered is the receipt.
 *   Dry-run by default; `--drive` performs the role sets.
 *   Usage: node scripts/fleet/registry-infra/npm/org-sweep.mts
 *   --org NAME [--org NAME]… [--drive]
 */

import process from 'node:process'

import { errorMessage } from '@socketsecurity/lib-stable/errors/message'

import { isMainModule } from '../../_shared/is-main-module.mts'
import { runMain } from '../../_shared/run-main.mts'
import { logger, runCapture } from '../shared.mts'
import { sleep } from './browser-session.mts'
import { sendOrgInvite } from './org-web.mts'
import { npmScratchCwd } from './shared.mts'
import { runWebAuthTool } from './web-auth-batch.mts'

import type { NpmBrowserSession } from './browser-session.mts'
import type { ScriptMeta } from '../../_shared/run-main.mts'

const PACE_MS = 2000

/**
 * The org-role law, stated once: username to required npm org role.
 */
export const ORG_ROLE_LAW: ReadonlyMap<string, string> = new Map([
  ['feross', 'owner'],
  ['socket-bot', 'developer'],
])

/**
 * Raised when a read errors — never classify an errored read as "empty".
 */
export class OrgReadDiedError extends Error {}

/**
 * An org's current membership as username-to-role, from the authenticated
 * org listing.
 */
export async function listOrgRoles(org: string): Promise<Map<string, string>> {
  const { code, stdout } = await runCapture(
    'npm',
    ['org', 'ls', org, '--json'],
    npmScratchCwd(),
  )
  if (code !== 0) {
    throw new OrgReadDiedError(
      `npm org ls ${org} exited ${code} — an errored listing reads as ` +
        'empty, so the sweep fails closed. ' +
        'Fix: node scripts/fleet/npm-auth.mts login (as an org owner).',
    )
  }
  const jsonStart = stdout.indexOf('{')
  if (jsonStart === -1) {
    return new Map()
  }
  const parsed = JSON.parse(stdout.slice(jsonStart)) as Record<string, string>
  return new Map(Object.entries(parsed))
}

async function orgSetRole(
  org: string,
  user: string,
  role: string,
): Promise<{ code: number; stdout: string }> {
  return await runWebAuthTool(['org', 'set', org, user, role], npmScratchCwd())
}

// One seeded browser session shared across every web-lane invite in the
// run, opened lazily and closed at exit by main().
let webSession: NpmBrowserSession | undefined

async function orgWebSession(): Promise<NpmBrowserSession> {
  if (!webSession) {
    const { openNpmBrowserSession } = await import('./browser-session.mts')
    webSession = await openNpmBrowserSession({ scope: 'org-sweep' })
  }
  return webSession
}

interface SweepArgs {
  drive: boolean
  orgs: string[]
}

function parseArgs(argv: string[]): SweepArgs {
  const args: SweepArgs = { drive: false, orgs: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!
    if (a === '--drive') {
      args.drive = true
    } else if (a === '--org') {
      const o = argv[++i]
      if (o) {
        args.orgs.push(o.replace(/^@/, ''))
      }
    }
  }
  return args
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.orgs.length) {
    logger.fail(
      'org-sweep: no targets. Where: the argv. Saw: no --org. ' +
        'Fix: pass --org NAME (repeatable).',
    )
    process.exitCode = 1
    return
  }

  const set: string[] = []
  const covered: string[] = []
  const humanMoves: string[] = []
  const failed: Array<{ reason: string; site: string }> = []

  for (let i = 0, { length } = args.orgs; i < length; i += 1) {
    const org = args.orgs[i]!
    let roles: Map<string, string>
    try {
      roles = await listOrgRoles(org)
    } catch (e) {
      failed.push({ site: org, reason: errorMessage(e) })
      logger.fail(`${org}: ${errorMessage(e)}`)
      continue
    }
    for (const [user, wanted] of ORG_ROLE_LAW) {
      const site = `${org}:${user}`
      const current = roles.get(user)
      if (current === wanted) {
        covered.push(site)
        logger.success(`${site}: already ${wanted}`)
        continue
      }
      if (!args.drive) {
        set.push(site)
        logger.info(
          `→ ${site}: would set ${wanted}${current ? ` (now ${current})` : ' (not a member)'}`,
        )
        continue
      }
      // A non-member cannot be role-set — they must be INVITED first, and
      // no npm/pnpm command sends an org invitation, so this rides the
      // web-context lane. The role set happens on a re-run after they
      // accept.
      if (!current) {
        try {
          const session = await orgWebSession()
          const outcome = await sendOrgInvite(session, org, user)
          set.push(`${site} (${outcome})`)
        } catch (e) {
          humanMoves.push(site)
          logger.warn(`${site}: ${errorMessage(e)}`)
        }
        await sleep(PACE_MS)
        continue
      }
      const res = await orgSetRole(org, user, wanted)
      if (res.code !== 0) {
        // npm refuses demoting the LAST owner — when the law demotes the
        // acting account and the refusal fires, that is the human move.
        if (/last owner|cannot.*owner/i.test(res.stdout)) {
          humanMoves.push(site)
          logger.warn(
            `${site}: npm refused the role change — an owner other than the ` +
              'acting account must perform it.',
          )
        } else {
          failed.push({ site, reason: res.stdout.slice(-200) })
          logger.fail(`${site}: org set exited ${res.code}`)
        }
      } else {
        const after = await listOrgRoles(org)
        if (after.get(user) === wanted) {
          set.push(site)
          logger.success(`${site}: set ${wanted}`)
        } else {
          failed.push({
            site,
            reason: 'org set exited 0 but the listing does not show the role',
          })
          logger.fail(`${site}: set reported success but did not land`)
        }
      }
      await sleep(PACE_MS)
    }
  }

  const mode = args.drive ? 'set' : 'would set'
  logger.info(
    `org-sweep: ${mode} ${set.length}, already-covered ${covered.length}, ` +
      `human-only ${humanMoves.length}, failed ${failed.length}`,
  )
  for (let i = 0, { length } = humanMoves; i < length; i += 1) {
    logger.warn(`  human move: ${humanMoves[i]}`)
  }
  if (failed.length) {
    for (let i = 0, { length } = failed; i < length; i += 1) {
      const f = failed[i]!
      logger.fail(`  ${f.site}: ${f.reason}`)
    }
    process.exitCode = 1
  }
  if (webSession) {
    // An unclosed session keeps the event loop alive — same contract as
    // the web-auth wrapper's auth browser.
    await webSession.close()
    webSession = undefined
  }
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'reconciles npm org membership to the fleet law — feross owner, socket-bot developer — via the batch-auth seam',
  help: `Usage: node scripts/fleet/registry-infra/npm/org-sweep.mts [flags]

  --org NAME   reconcile this org (repeatable)
  --drive      perform the role sets (dry-run by default)`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
