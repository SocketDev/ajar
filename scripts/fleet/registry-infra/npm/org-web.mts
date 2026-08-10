/**
 * @file The npm ORG web-context lane — used ONLY where no npm or pnpm
 *   command exists. The CLI-first lane map, probed 2026-08-08:
 *   package owner ops ride `npm owner` through the web-auth wrapper
 *   (works); org member READS ride `npm org ls` (works); org role WRITES
 *   by the bot account die in npm's own web-auth handshake (the registry
 *   404s the done-poll); `pnpm owner` hits an owners route npmjs does not
 *   serve; `pnpm team add` requires the user to already be a member. That
 *   leaves org INVITATIONS, pending-invite reads, and team detail with no
 *   CLI at all — this module covers exactly those, the same way the web
 *   UI does.
 *   Every npm settings page ships its state as `window.__context__`, and
 *   an `x-spiferack: 1` fetch returns that same payload as JSON: members
 *   with roles, pending invitations, teams, and the `csrftoken` the
 *   invite form posts with. The invite IS a plain form POST to
 *   `/settings/ORGNAME/invite/create` with `entity`, `team`, `role`, and
 *   that csrftoken — no CLI handshake anywhere.
 *   Both read and write run INSIDE the seeded browser session
 *   (`openNpmBrowserSession`) so the page's own cookies authenticate, and
 *   every write is verified by RE-READING the pending-invitation list —
 *   npm's bot management is known to silently drop some driven-browser
 *   writes, and a write that cannot be read back is a failure, never a
 *   success (`verify-state-before-acting`).
 *   Context snapshots persist per account through socket-lib's cacache,
 *   REDACTED first via the account-inventory seam — the raw payload
 *   carries the live csrftoken, and a cached credential is a leak.
 */

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { redactContext } from './account-inventory.mts'
import { fetchInPage } from './browser-session.mts'

import type { NpmBrowserSession } from './browser-session.mts'

const logger = getDefaultLogger()

const NPM_ORIGIN = 'https://www.npmjs.com'

const CACHE_KEY_PREFIX = 'wheelhouse:npm-org-context'

export interface OrgMember {
  role: string
  user: string
}

export interface OrgWebContext {
  csrftoken: string | undefined
  members: OrgMember[]
  org: string
  pendingInvitations: string[]
  raw: unknown
}

interface SpiferackEnvelope {
  context?:
    | {
        csrftoken?: string | undefined
        invitations?: Array<{ name?: string | undefined }> | undefined
        list?:
          | {
              objects?:
                | Array<{
                    role?: string | undefined
                    user?: { name?: string | undefined } | undefined
                  }>
                | undefined
            }
          | undefined
        pendingInvitations?: Array<{ name?: string | undefined }> | undefined
      }
    | undefined
}

/**
 * Parse a spiferack JSON body defensively — npm renames envelope keys
 * without notice, so both observed pending-invite spellings are read.
 */
export function parseOrgContext(org: string, body: string): OrgWebContext {
  let parsed: SpiferackEnvelope = {}
  try {
    parsed = JSON.parse(body) as SpiferackEnvelope
  } catch {
    // A non-JSON body reads as an empty context; the caller fail-closes
    // on the missing csrftoken before any write.
  }
  const ctx = parsed.context
  const members: OrgMember[] = []
  const objects = ctx?.list?.objects
  if (Array.isArray(objects)) {
    for (let i = 0, { length } = objects; i < length; i += 1) {
      const o = objects[i]!
      const user = o.user?.name
      if (user) {
        members.push({ role: o.role ?? '', user })
      }
    }
  }
  const invites = ctx?.pendingInvitations ?? ctx?.invitations ?? []
  const pendingInvitations = Array.isArray(invites)
    ? invites.map(i => i.name ?? '').filter(Boolean)
    : []
  return {
    csrftoken: ctx?.csrftoken,
    members,
    org,
    pendingInvitations,
    raw: parsed,
  }
}

/**
 * The org's invite-page context: members, pending invitations, and the
 * csrftoken the invite form posts with.
 */
export async function readOrgWebContext(
  session: NpmBrowserSession,
  org: string,
): Promise<OrgWebContext> {
  const { body, status } = await fetchInPage(
    session.page,
    `${NPM_ORIGIN}/settings/${org}/invite`,
    'application/json',
  )
  if (!body || status >= 400) {
    throw new Error(
      `org-web: the ${org} invite context answered ${status} — an unread ` +
        'source is never a pass. Where: the seeded browser session. ' +
        'Fix: sign the shared profile in as an org owner and retry.',
    )
  }
  return parseOrgContext(org, body)
}

/**
 * Send an org invitation the way the web UI does: a form POST to the
 * invite/create route carrying the page's own csrftoken, verified by
 * re-reading the pending-invitation list. Returns 'already-member',
 * 'already-invited', or 'invited'; throws when the write cannot be
 * confirmed from the re-read.
 */
export async function sendOrgInvite(
  session: NpmBrowserSession,
  org: string,
  entity: string,
  team = 'developers',
): Promise<'already-invited' | 'already-member' | 'invited'> {
  const before = await readOrgWebContext(session, org)
  if (before.members.some(m => m.user === entity)) {
    return 'already-member'
  }
  if (before.pendingInvitations.includes(entity)) {
    return 'already-invited'
  }
  if (!before.csrftoken) {
    throw new Error(
      `org-web: no csrftoken in the ${org} invite context — the session is ` +
        'signed out or the page shape changed. Fix: re-seed the profile ' +
        'sign-in, or send the invite at ' +
        `${NPM_ORIGIN}/settings/${org}/invite in the browser.`,
    )
  }
  const postStatus = await session.page.evaluate(
    async ({ csrftoken, inviteEntity, inviteTeam, postUrl, role }) => {
      const form = new URLSearchParams()
      form.set('entity', inviteEntity)
      form.set('team', inviteTeam)
      form.set('role', role)
      form.set('csrftoken', csrftoken)
      // Runs in the npm page's MAIN world; only the page's cookies
      // authenticate this request.
      // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- page world
      const r = await fetch(postUrl, {
        body: form.toString(),
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-spiferack': '1',
        },
        method: 'POST',
      })
      return r.status
    },
    {
      csrftoken: before.csrftoken,
      inviteEntity: entity,
      inviteTeam: team,
      postUrl: `${NPM_ORIGIN}/settings/${org}/invite/create`,
      role: 'developer',
    },
  )
  // Verify from the registry's own answer, never the write's echo — npm's
  // bot management drops some driven-browser writes with a green-looking
  // status.
  const after = await readOrgWebContext(session, org)
  if (after.pendingInvitations.includes(entity)) {
    logger.success(`${org}: invited ${entity} — pending their acceptance`)
    return 'invited'
  }
  if (after.members.some(m => m.user === entity)) {
    return 'already-member'
  }
  throw new Error(
    `org-web: the ${org} invite POST answered ${postStatus} but the ` +
      're-read shows no pending invitation — npm dropped the driven write. ' +
      `Fix: send it at ${NPM_ORIGIN}/settings/${org}/invite in the browser.`,
  )
}

/**
 * Persist a REDACTED per-account snapshot of org contexts through
 * socket-lib's cacache, so team detail survives between sessions without
 * caching a credential. Dynamic import keeps cacache off the module's
 * load path for callers that never snapshot.
 */
export async function saveOrgSnapshot(
  account: string,
  contexts: OrgWebContext[],
): Promise<void> {
  const { put } = await import('@socketsecurity/lib-stable/cacache/write')
  const redacted = contexts.map(c => ({
    ...c,
    csrftoken: undefined,
    raw: redactContext(c.raw),
  }))
  await put(
    `${CACHE_KEY_PREFIX}:${account}`,
    JSON.stringify({ contexts: redacted, savedAt: Date.now() }),
  )
}

/**
 * The last saved snapshot for an account, or undefined when none exists.
 */
export async function loadOrgSnapshot(
  account: string,
): Promise<unknown | undefined> {
  const { safeGet } = await import('@socketsecurity/lib-stable/cacache/read')
  const entry = await safeGet(`${CACHE_KEY_PREFIX}:${account}`)
  if (!entry) {
    return undefined
  }
  try {
    return JSON.parse(String(entry.data))
  } catch {
    return undefined
  }
}
