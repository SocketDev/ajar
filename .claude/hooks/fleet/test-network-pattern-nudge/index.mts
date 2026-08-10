#!/usr/bin/env node
// Claude Code PreToolUse hook — test-network-pattern-nudge.
//
// Nudges when a test edit performs a real request with nothing intercepting
// it. A test that reaches the network is slow, flaky, and fails offline, and
// `no-live-network-in-tests` already says so — but knowing the rule does not
// tell you the SHAPE, and the shape lives scattered across whichever test file
// you happen to open. Finding it costs a grep for `nock`, a second grep for
// `disableNetConnect`, and a read of two unrelated suites. This puts the
// pattern in front of the edit that needs it.
//
// Trigger surface, test files only, by path:
//   test/**/*.test.{ts,mts,js,mjs} | tests/**/*.test.* | __tests__/**/*.test.*
// Plus content carrying a request call and no interception marker.
//
// Silent when the test is loopback-oriented: a fixture server on 127.0.0.1 is
// the one case where a real request IS the thing under test, and nock's
// passthrough exists for exactly that.
//
// Stderr reminder; never blocks.

import { normalizePath } from '@socketsecurity/lib-stable/paths/normalize'
import { defineHook, editGuard, notify, runHook } from '../_shared/guard.mts'

// A test file path: a `test/`, `tests/`, or `__tests__/` directory segment at
// any depth, then a filename ending `.test.` / `.spec.` and a JS/TS extension.
const TEST_FILE_RE =
  /(?:^|[\\/])(?:test|tests|__tests__)[\\/].+\.(?:spec|test)\.(?:[cm]?[jt]sx?)$/u

// A call that performs a request. Deliberately narrow: a bare `https://` in a
// string is a URL constant, not a request, and matching it would fire on most
// fixture files. Only a CALL counts.
const NETWORK_CALL_RE =
  /\b(?:fetch|httpRequest)\s*\(|\bhttps?\.(?:get|request)\s*\(|from\s+'(?:axios|got|node-fetch|undici)'/u

// Markers that the test already isolates the network. An injected `fetch`
// parameter (the style the registry-liveness gate uses) lands on the vi/jest
// arms or on a mock-shaped name.
const INTERCEPTED_RE =
  /\bnock\b|disableNetConnect|MockAgent|setupServer|\bmsw\b|fetchMock|mockFetch|fakeFetch|vi\.(?:fn|mock|stubGlobal)|jest\.(?:fn|mock)/u

// A loopback fixture server: the one case where the request IS the subject.
const LOOPBACK_RE = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1/u

/**
 * The request call the content carries, or undefined when it carries none.
 * Returned rather than a boolean so the reminder can quote what it saw.
 */
export function networkCallIn(content: string): string | undefined {
  return NETWORK_CALL_RE.exec(content)?.[0]?.trim()
}

/**
 * Whether a test edit earns the reminder: a test path, a request call, no
 * interception, and not a loopback fixture.
 */
export function shouldRemind(
  filePath: string,
  content: string | undefined,
): boolean {
  if (!content) {
    return false
  }
  if (!TEST_FILE_RE.test(normalizePath(filePath))) {
    return false
  }
  if (!networkCallIn(content)) {
    return false
  }
  if (INTERCEPTED_RE.test(content)) {
    return false
  }
  return !LOOPBACK_RE.test(content)
}

/**
 * The reminder text for a file whose edit carries `call`.
 */
export function message(filePath: string, call: string): string {
  return [
    `[test-network-pattern-nudge] ${filePath}: a request with nothing intercepting it.`,
    '',
    `  saw:  ${call}`,
    '',
    '  Pattern:',
    "    import nock from 'nock'",
    '',
    '    beforeAll(() => nock.disableNetConnect())',
    '    afterAll(() => nock.enableNetConnect())',
    '    afterEach(() => nock.cleanAll())',
    '',
    "    nock('https://registry.npmjs.org')",
    "      .get('/pkg')",
    '      .reply(200, { maintainers: [] })',
    '',
    '  Exemplar: test/repo/unit/check-npm-packages-are-bot-co-owned.test.mts',
    '  Rule:     docs/agents.md/fleet/no-live-network-in-tests.md',
    '',
  ].join('\n')
}

export const check = editGuard((filePath, content) => {
  const call = content ? networkCallIn(content) : undefined
  if (!call || !shouldRemind(filePath, content)) {
    return undefined
  }
  return notify(message(filePath, call))
})

export const hook = defineHook({
  check,
  event: 'PreToolUse',
  matcher: ['Edit', 'Write', 'MultiEdit'],
  type: 'nudge',
})

void runHook(hook, import.meta.url)
