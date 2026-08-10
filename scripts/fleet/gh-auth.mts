#!/usr/bin/env node
/*
 * @file Operator entry for gh auth, the gh twin of `npm:auth`
 *   (`pnpm run gh:auth [subcommand]`): one router so nobody types the
 *   hostname / protocol / scope flags by hand and nobody pastes a token.
 *
 *   - `status` (and bare) — read `gh auth status` and report it against the
 *     fleet contract (keyring, `workflow` scope). Exit 0 clean, 1 not.
 *   - `login` — the canonical browser flow. Verify-state-before-acting: an
 *     already-clean login exits 0 without opening anything; `--force` re-runs
 *     the flow anyway (account switch, scope repair). After the flow the
 *     state is RE-READ — the verdict is `gh auth status`, never gh's exit
 *     code. The device-code approval stays the operator's: this wrapper
 *     never authenticates on its own.
 *   - anything else (`logout`, `refresh`, `token`, `setup-git`, ...) — passed
 *     through verbatim to `gh auth <subcommand>`, the same any-subcommand
 *     router shape `npm:auth` gives npm.
 *
 *   Token hygiene (docs/agents.md/fleet/gh-token-hygiene.md): keyring
 *   storage only, browser auth only. The `workflow` scope rides along
 *   because the routine flows that send people here (npm:dispatch, the
 *   publish pipeline's preflight) dispatch workflows by name.
 *
 *   Usage: pnpm run gh:auth [status|login|<gh auth subcommand>] [--force]
 */

import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'

import { ghAuthProblems, readGhAuthState } from './registry-infra/gh-auth.mts'
import { isMainModule } from './_shared/is-main-module.mts'
import { runMain } from './_shared/run-main.mts'
import type { ScriptMeta } from './_shared/run-main.mts'

const logger = getDefaultLogger()

// The scopes the fleet's gh flows need by name — workflow (dispatch) and
// read:packages (resolving private ghcr image digests for
// container-refs-are-digest-pinned). Kept OFF of anything broader:
// gh-token-hygiene grants scopes per named need.
export const GH_LOGIN_SCOPES: readonly string[] = ['read:packages', 'workflow']

// The full argv of the canonical browser login. Exported so tests can hold
// it in lock-step with the Fix line formatGhAuthFailure prescribes.
export const GH_LOGIN_ARGS: readonly string[] = [
  'auth',
  'login',
  '--hostname',
  'github.com',
  '--git-protocol',
  'ssh',
  '--scopes',
  GH_LOGIN_SCOPES.join(','),
  '--web',
]

/**
 * The canonical login command as one pasteable string, for gates and docs.
 */
export function renderGhLoginCommand(): string {
  return `gh ${GH_LOGIN_ARGS.join(' ')}`
}

/**
 * Run the canonical browser login, pre-answering the prompt gh shows before
 * it opens the browser.
 *
 * Stdin is piped and fed a newline rather than inherited: `gh auth login
 * --web` pauses on "Press Enter to open the browser", and an agent session
 * has no TTY, so an inherited stdin either EOFs the prompt or hangs the
 * flow. The newline also clears the pause on a real terminal, so the
 * operator and the agent drive one identical command. stdout and stderr stay
 * inherited because the one-time code has to reach whoever is watching.
 *
 * Resolves to gh's exit code. That code is not the verdict on its own — a
 * closed tab or a retried code can end non-zero with the login intact — so
 * callers re-read `gh auth status` afterwards.
 */
export async function spawnGhLoginWith(
  spawnFn: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<number> {
  try {
    await spawnFn('gh', [...GH_LOGIN_ARGS], {
      input: '\n',
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    return 0
  } catch (e) {
    const code = (e as { code?: number | undefined })?.code
    return typeof code === 'number' && code !== 0 ? code : 1
  }
}

export async function spawnGhLogin(): Promise<number> {
  return await spawnGhLoginWith(
    spawn as unknown as (
      command: string,
      args: string[],
      options: Record<string, unknown>,
    ) => Promise<unknown>,
  )
}

function reportStatus(): number {
  const state = readGhAuthState()
  const problems = ghAuthProblems(state, GH_LOGIN_SCOPES)
  if (!problems.length) {
    logger.success(
      `gh:auth: authenticated${state.account ? ` as ${state.account}` : ''} — keyring token carrying ${GH_LOGIN_SCOPES.join(', ')}.`,
    )
    return 0
  }
  logger.fail(
    `gh:auth: ${problems.join('; ')}. Run \`pnpm run gh:auth login\` to fix.`,
  )
  process.exitCode = 1
  return 1
}

async function runLogin(config: { force: boolean }): Promise<number> {
  const cfg = { __proto__: null, ...config } as typeof config
  const before = ghAuthProblems(readGhAuthState(), GH_LOGIN_SCOPES)
  if (!before.length && !cfg.force) {
    logger.success(
      'gh:auth: already authenticated — keyring token carrying ' +
        `${GH_LOGIN_SCOPES.join(', ')}. Use --force to re-run the browser login anyway.`,
    )
    return 0
  }
  if (before.length) {
    logger.info(`gh:auth: ${before.join('; ')}.`)
  }
  logger.info(
    'gh:auth: starting the browser flow — gh prints a one-time code and ' +
      'the approval happens in your browser.',
  )
  // The exit code is deliberately ignored: the `gh auth status` re-read
  // below is the verdict, and a missing gh binary reads as unauthenticated
  // there too.
  await spawnGhLogin()
  const after = ghAuthProblems(readGhAuthState(), GH_LOGIN_SCOPES)
  if (after.length) {
    logger.fail(
      [
        'gh:auth: still not authenticated the way the fleet needs.',
        '  Where: `gh auth status`, re-read after the browser flow.',
        `  Saw vs. wanted: ${after.join('; ')}; wanted a keyring-stored login carrying ${GH_LOGIN_SCOPES.join(', ')}.`,
        `  Fix: re-run \`pnpm run gh:auth login\` and finish the browser approval (the flow wraps: ${renderGhLoginCommand()}).`,
      ].join('\n'),
    )
    process.exitCode = 1
    return 1
  }
  return reportStatus()
}

export async function main(): Promise<number> {
  // Raw argv routing rather than parseArgs: every unrecognized subcommand is
  // forwarded to `gh auth` verbatim, flags and all, so this router never has
  // to know gh's option surface.
  const argv = process.argv.slice(2)
  const subcommand = argv.find(a => !a.startsWith('-')) ?? 'status'
  if (subcommand === 'status') {
    return reportStatus()
  }
  if (subcommand === 'login') {
    return await runLogin({ force: argv.includes('--force') })
  }
  const rest = argv.filter(a => a !== subcommand)
  try {
    await spawn('gh', ['auth', subcommand, ...rest], { stdio: 'inherit' })
  } catch {
    process.exitCode = 1
    return 1
  }
  return 0
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'routes gh auth: fleet-contract status report, canonical browser login, any other subcommand passed through',
  help: `Usage: pnpm run gh:auth [subcommand] [flags]
  status    report the auth state against the fleet contract (the default)
  login     run the canonical browser login (keyring, ssh, workflow scope)
    --force   re-run the browser flow even when the current login is clean
  <other>   forwarded verbatim to \`gh auth <other>\` (logout, refresh, token, ...)`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
