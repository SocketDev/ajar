/*
 * @file Detector for `scripts/fleet/check/fixture-names-are-descriptive.mts`:
 *   find single-letter placeholder names inside quoted fixture paths in test
 *   source. A fixture name is fake but DESCRIPTIVE — `example.js`,
 *   `/path/to/example`, `@example/module` — never `x.js`, `./a.js`, or
 *   `/path/to/x`. A single-letter name carries no meaning at the call site,
 *   collides silently when a second fixture joins it, and greps for nothing.
 *
 *   The `@example` npm scope is SAFE as the fake module scope: it holds zero
 *   packages (registry search `scope:example` returns total 0 and
 *   `@example/module` 404s, verified 2026-08-08), so a fake module name under
 *   it can never shadow or typo-squat a real dependency.
 *
 *   Two shapes flag, both inside a quoted string in a test file:
 *   1. A path segment that is one letter plus a file extension — `x.js`,
 *      `dist/data/x.json`, `./a.mts`.
 *   2. A bare one-letter segment in a path that also carries a real
 *      multi-letter segment — `/path/to/x`, `helpers/x`. A string whose
 *      segments are ALL single letters (`a/b/c`) is path-shape algebra, not a
 *      named fixture, and stays legal.
 *
 *   Escape hatch, for a test whose SUBJECT is single-character names:
 *   `fixture-name: allow` on the line, `fixture-name: allow-file` anywhere in
 *   the file. This module owns detection only; the check owns the walk, the
 *   burn-down bookkeeping, and the verdict.
 */

export const FIXTURE_NAME_ALLOW_LINE = 'fixture-name: allow'
export const FIXTURE_NAME_ALLOW_FILE = 'fixture-name: allow-file'

export const FIXTURE_NAME_FIX =
  'rename the placeholder to a fake-but-descriptive name: `example.js`, ' +
  '`/path/to/example`, or `@example/module` (the @example npm scope is ' +
  'empty, so a fake module under it can never collide with a real one)'

// Matches a quoted string span in one source line.
// (["'`])   — capture the opening quote kind
// (?:\\.|(?!\1).)*? — escaped char, or any char that is not the closing quote
// \1        — the matching closing quote
// The escape branch must match before the any-char branch.
// oxlint-disable-next-line socket/sort-regex-alternations -- match order
const STRING_SPAN_RE = /(["'`])((?:\\.|(?!\1).)*?)\1/g

// Matches a path segment that is a single letter with a file extension.
// ^[A-Za-z]  — the one-letter stem
// \.         — the extension dot
// (?:…)$     — a known code/data extension, alternation sorted
const SINGLE_LETTER_FILE_RE =
  /^[A-Za-z]\.(?:cjs|cts|d\.cts|d\.mts|d\.ts|js|json|jsx|md|mjs|mts|ts|tsx|txt|yaml|yml)$/

// Matches a path segment that is exactly one bare letter.
const SINGLE_LETTER_BARE_RE = /^[A-Za-z]$/

// Matches a segment carrying two or more word characters — the "this string
// really is a named path" signal that arms the bare-letter shape.
const MULTI_LETTER_SEGMENT_RE = /\w{2,}/

export interface FixtureNameFinding {
  // 1-indexed line the placeholder sits on.
  readonly line: number
  // The full quoted span the placeholder was found in.
  readonly span: string
  // The offending single-letter segment.
  readonly segment: string
}

function findPlaceholderSegment(span: string): string | undefined {
  if (span.includes('://')) {
    return undefined
  }
  const segments = span.split('/')
  const { length: count } = segments
  let hasMultiLetterSegment = false
  let bareLetter: string | undefined
  for (let i = 0; i < count; i += 1) {
    const segment = segments[i]!
    if (SINGLE_LETTER_FILE_RE.test(segment)) {
      return segment
    }
    if (SINGLE_LETTER_BARE_RE.test(segment)) {
      bareLetter = segment
    } else if (MULTI_LETTER_SEGMENT_RE.test(segment)) {
      hasMultiLetterSegment = true
    }
  }
  if (bareLetter && hasMultiLetterSegment && count > 1) {
    return bareLetter
  }
  return undefined
}

/**
 * Scan one test file's content for single-letter fixture placeholders in
 * quoted strings. Honors the line and file allow markers.
 */
export function scanFixtureNames(content: string): FixtureNameFinding[] {
  const findings: FixtureNameFinding[] = []
  if (content.includes(FIXTURE_NAME_ALLOW_FILE)) {
    return findings
  }
  const lines = content.split(/\r?\n/)
  for (let i = 0, { length } = lines; i < length; i += 1) {
    const line = lines[i]!
    if (line.includes(FIXTURE_NAME_ALLOW_LINE)) {
      continue
    }
    STRING_SPAN_RE.lastIndex = 0
    let match = STRING_SPAN_RE.exec(line)
    while (match) {
      const span = match[2]!
      const segment = findPlaceholderSegment(span)
      if (segment) {
        findings.push({ line: i + 1, span, segment })
      }
      match = STRING_SPAN_RE.exec(line)
    }
  }
  return findings
}
