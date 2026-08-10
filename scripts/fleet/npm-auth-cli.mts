/**
 * @file The CLI login lane of the npm auth family: a thin entry that runs
 *   `npm login` through the PTY-wrapped web-auth runner in npm-auth.mts, so
 *   the browser 2FA flow works from a non-interactive agent shell.
 *   Usage: node scripts/fleet/npm-auth-cli.mts [login args...].
 */

import process from 'node:process'

import { isMainModule } from './_shared/is-main-module.mts'
import { runMain } from './_shared/run-main.mts'
import { runNpmWebAuth } from './npm-auth.mts'

import type { ScriptMeta } from './_shared/run-main.mts'

export async function main(): Promise<number> {
  return runNpmWebAuth({
    argv: ['login', ...process.argv.slice(2)],
    platform: process.platform,
    isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    env: process.env,
  })
}

const SCRIPT_META: ScriptMeta = {
  describe: 'the CLI login lane of the npm auth family',
  help: 'Usage: node scripts/fleet/npm-auth-cli.mts [login args...]',
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
