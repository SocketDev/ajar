#!/usr/bin/env node
// Blocks a raw `gh auth login` in favor of the fleet wrapper
// `pnpm run gh:auth login`.
//
// Why: the raw command's flag set is a re-derivation trap. The canonical
// login is one exact argv — keyring web flow, ssh git protocol, and the
// named-need scope set (GH_LOGIN_SCOPES: read:packages + workflow) — and a
// hand-typed variant silently drops whichever piece the operator forgot.
// Both failure shapes have already happened: a login without the scopes left
// the very next ghcr digest read 403ing, and a login from an environment gh
// resolved to file storage put the token in ~/.config/gh/hosts.yml (the Nx
// Console exfil path gh-token-hygiene-guard exists to block). The wrapper
// (`scripts/fleet/gh-auth.mts`) spells the argv once, keeps it lock-stepped
// with the failure message its preflight prescribes, and is the surface the
// fleet evolves when a new scope earns its name.
//
// Scope: `gh auth login` only. Other `gh auth` verbs (status, logout,
// refresh, token) stay unblocked — the wrapper forwards them verbatim, so
// the raw and wrapped forms cannot drift. The wrapper's own child spawn is a
// node subprocess, not a Bash tool call, so this guard never blocks it.
//
// Reads a Claude Code PreToolUse JSON payload from stdin:
//   { "tool_name": "Bash", "tool_input": { "command": "..." }, ... }
//
// Exit codes:
//   0 — pass, not Bash, or no raw `gh auth login` present.
//   2 — block, with the wrapper command to run instead.

import { commandsFor } from '../_shared/shell-command.mts'

import { bashGuard, block, defineHook, runHook } from '../_shared/guard.mts'

/**
 * True when one parsed command segment is a `gh auth login` invocation. Both
 * verbs must appear as non-flag args — `auth` alone (status/logout/refresh)
 * and `login` as a value of some unrelated flag both stay clean.
 */
export function isRawGhAuthLogin(command: string): boolean {
  for (const cmd of commandsFor(command, 'gh')) {
    const words = cmd.args.filter(a => !a.startsWith('-'))
    if (words[0] === 'auth' && words.includes('login')) {
      return true
    }
  }
  return false
}

export const check = bashGuard(command => {
  if (!isRawGhAuthLogin(command)) {
    return undefined
  }
  return block(
    [
      '[no-raw-gh-auth-login-guard] Blocked: raw `gh auth login`.',
      '',
      '  The canonical login is one exact argv (keyring web flow, ssh, the',
      '  named-need scope set) and a hand-typed variant silently drops',
      '  whichever piece was forgotten — a scope-less login 403s the next',
      '  packages read, and a file-storage login parks the token on disk.',
      '',
      '  Run the wrapper instead:',
      '    pnpm run gh:auth login',
      '',
      '  Other auth verbs forward verbatim through the same wrapper:',
      '    pnpm run gh:auth status | logout | refresh ...',
    ].join('\n'),
  )
})

export const hook = defineHook({
  bypass: ['raw-gh-auth'],
  check,
  event: 'PreToolUse',
  matcher: ['Bash'],
  scope: 'convention',
  type: 'guard',
})

void runHook(hook, import.meta.url)
