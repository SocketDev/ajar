#!/usr/bin/env node
// Claude Code PreToolUse hook — private-package-name-guard.
//
// Blocks a `package.json` write that gives a `private: true` package a
// publishable-looking identity. `private-packages-are-unpublishable` already
// catches this, but at the GATE — by which point the name is in the manifest,
// possibly in a lockfile, and possibly referenced by a sibling. Renaming then
// costs a reference sweep. Renaming at the edit costs one keystroke.
//
// Three ways a private package reads as publishable, all blocked here:
//   - a SCOPE (`@acme/tests`), which squats a namespace the repo may not own
//   - a name that is not `local-<own directory>`
//   - a version other than `0.0.0`, which invites release reasoning about
//     something that never ships
//
// The name is the package's OWN directory, never its path. A path-derived name
// renames on every move, so relocating a directory would rewrite every
// dependent manifest and the lockfile for a change that moved no code.
//
// `local-` rather than `private-`: on npm a "private package" is a PUBLISHED
// one with restricted access, so that prefix would mean the opposite of what
// it says here.
//
// Two identities are left alone: the repo ROOT manifest, which carries the
// repo's own name, and a manifest a repo declares as its
// `release.versionSource`, whose version is a real release number on a channel
// npm never sees.
//
// Bypass: `Allow private-package-name bypass`.

import path from 'node:path'

import { normalizePath } from '@socketsecurity/lib-stable/paths/normalize'

import { block, defineHook, editGuard, runHook } from '../_shared/guard.mts'
import { verdictLine } from '../_shared/verdict.mts'

import type { GuardResult } from '../_shared/guard.mts'

const PRIVATE_VERSION = '0.0.0'

const LOCAL_NAME_PREFIX = 'local-'

/**
 * One directory segment as an npm-name segment: lowercase, dot-free, kebab.
 * Mirrors `sanitizeNameSegment` in the check of the same name — the guard runs
 * from a bundle that cannot import the check's entry module, so the rule is
 * restated here and `private-package-name-guard.test.mts` pins the two to the
 * same answers.
 */
export function sanitizeNameSegment(segment: string): string {
  return (
    segment
      .toLowerCase()
      // Any run of characters npm disallows in a name collapses to one dash.
      .replace(/[^a-z0-9-]+/g, '-')
      // `^-+` trims dashes at the start, where a dot-directory leaves one;
      // `-+$` trims them at the end.
      .replace(/^-+|-+$/g, '')
  )
}

/**
 * The name a private package at `manifestPath` must carry, or undefined for a
 * repo-root manifest, whose name is the repo's own identity.
 */
export function expectedLocalName(manifestPath: string): string | undefined {
  const dir = path.posix.dirname(normalizePath(manifestPath))
  if (dir === '' || dir === '.') {
    return undefined
  }
  const ownDir = normalizePath(dir).split('/').filter(Boolean).at(-1) ?? ''
  const segment = sanitizeNameSegment(ownDir)
  return segment ? `${LOCAL_NAME_PREFIX}${segment}` : undefined
}

export interface PrivateNameFinding {
  readonly expected: string | undefined
  readonly reason: 'scoped' | 'version' | 'wrong-name'
  readonly saw: string
}

/**
 * The finding for a manifest's proposed content, or undefined when it is fine.
 * Pure over the parsed manifest so the decision is testable without a file.
 */
export function findPrivateNameProblem(
  manifestPath: string,
  manifest: {
    name?: unknown | undefined
    private?: unknown | undefined
    version?: unknown | undefined
  },
): PrivateNameFinding | undefined {
  if (manifest.private !== true) {
    return undefined
  }
  const name = typeof manifest.name === 'string' ? manifest.name : ''
  if (!name) {
    return undefined
  }
  const expected = expectedLocalName(manifestPath)
  if (name.startsWith('@')) {
    return { expected, reason: 'scoped', saw: name }
  }
  // A root manifest has no directory to name itself after, so only its version
  // is judged here. The check owns the fuller root story.
  if (expected !== undefined && name !== expected) {
    return { expected, reason: 'wrong-name', saw: name }
  }
  const version = typeof manifest.version === 'string' ? manifest.version : ''
  if (version && version !== PRIVATE_VERSION) {
    return { expected, reason: 'version', saw: version }
  }
  return undefined
}

/**
 * The block text for a finding.
 */
export function message(
  manifestPath: string,
  finding: PrivateNameFinding,
): string {
  const lines = [`  ${manifestPath}`, '']
  if (finding.reason === 'version') {
    lines.push(
      `  saw:   version ${finding.saw}`,
      `  want:  ${PRIVATE_VERSION}`,
      '',
      '  A package that never publishes has no release to be that version of,',
      '  and a workspace bumper will carry it along.',
    )
  } else {
    lines.push(
      `  saw:   ${finding.saw}`,
      `  want:  ${finding.expected ?? '(the repo name, for a root manifest)'}`,
      '',
      finding.reason === 'scoped'
        ? '  A scope squats a namespace the repo may not own, and reads as a'
        : '  The name is the package OWN directory, never its path, so moving',
      finding.reason === 'scoped'
        ? '  published package in every manifest and lockfile that names it.'
        : '  the directory never drags a rename through dependent manifests.',
    )
  }
  return verdictLine(
    'block',
    'private-package-name-guard',
    `a private package is wearing a publishable identity\n${lines.join('\n')}`,
  )
}

export const check = editGuard((filePath, content): GuardResult => {
  if (path.basename(normalizePath(filePath)) !== 'package.json' || !content) {
    return undefined
  }
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(content) as Record<string, unknown>
  } catch {
    // Malformed JSON is another guard's finding, never this one's.
    return undefined
  }
  const finding = findPrivateNameProblem(filePath, manifest)
  return finding ? block(message(filePath, finding)) : undefined
})

export const hook = defineHook({
  bypass: ['private-package-name'],
  check,
  event: 'PreToolUse',
  matcher: ['Edit', 'Write', 'MultiEdit'],
  type: 'guard',
})

void runHook(hook, import.meta.url)
