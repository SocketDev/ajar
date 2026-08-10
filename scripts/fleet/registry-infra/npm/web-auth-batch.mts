/**
 * @file The one spawn seam for MASS npm operations that ride the web-auth
 *   PTY wrapper (`npm-auth.mts`). Every bulk driver — owner-sweep,
 *   trust-sweep, any future batch over 2FA-gated npm writes — calls
 *   `runWebAuthTool` instead of hand-rolling wrapper path + capture spawn,
 *   so the batch policy lives in exactly one place:
 *   THE FIRST call in a process may open the auth page (it establishes the
 *   session and the challenge-cooldown opt-in); every later call carries
 *   `NPM_WEB_AUTH_NO_OPEN=1`, which the wrapper honors by printing the auth
 *   URL without spawning a browser. Before this policy a 35-package sweep
 *   opened 35 browser windows at the operator — one per add — when the
 *   2FA-fresh window meant none of them needed a click at all.
 */

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'

const WIN32 = process.platform === 'win32'

const AUTH_WRAPPER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../npm-auth.mts',
)

/**
 * The env sentinel the wrapper reads to skip the browser open.
 */
export const NO_OPEN_ENV = 'NPM_WEB_AUTH_NO_OPEN'

let callsSoFar = 0

/**
 * Test seam: reset the first-call-opens counter.
 */
export function resetBatchAuthPolicy(): void {
  callsSoFar = 0
}

/**
 * The 2FA-fresh window lapsed mid-batch (a call failed on the auth-page
 * shape): let the NEXT call open the browser once — the cooldown opt-in it
 * performs re-arms the headless run for the rest of the batch.
 */
export function allowReauthOnce(): void {
  callsSoFar = 0
}

// The wrapped tool printed its web-auth prompt — the fingerprint of a write
// that needed the browser. Under the no-open policy that write can only
// time out, so a failure carrying this shape means "reauth and retry", not
// "the operation is broken".
const AUTH_PROMPT_SHAPE_RE =
  /Authenticate your account at:|Open this URL in your browser to authenticate:|EOTP/i

/**
 * Whether a failed call's output says the 2FA window needs the browser.
 */
export function outputNeedsReauth(output: string): boolean {
  return AUTH_PROMPT_SHAPE_RE.test(output)
}

/**
 * Env for the next wrapper call under the batch policy: the first call in
 * this process inherits the environment untouched (browser open allowed),
 * every later one adds the no-open sentinel.
 */
export function batchAuthEnv(): NodeJS.ProcessEnv {
  callsSoFar += 1
  return callsSoFar === 1
    ? { ...process.env }
    : { ...process.env, [NO_OPEN_ENV]: '1' }
}

/**
 * Run one npm subcommand through the web-auth PTY wrapper under the batch
 * policy, capturing output. The wrapper owns TTY emulation and the auth
 * URL surfacing; this owns only spawn + policy.
 */
export async function runWebAuthTool(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string }> {
  return await new Promise((resolve, reject) => {
    const childPromise = spawn(process.execPath, [AUTH_WRAPPER, ...args], {
      cwd,
      env: batchAuthEnv(),
      shell: WIN32,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    // The enriched spawn promise rejects on non-zero exit; the exit handler
    // below resolves with the code regardless, so swallow the rejection.
    void childPromise.catch(() => undefined)
    const child = childPromise.process
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('exit', code => {
      resolve({ code: code ?? 0, stdout })
    })
  })
}
