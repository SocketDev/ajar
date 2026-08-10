#!/usr/bin/env node
/*
 * @file `check --all` gate: a PRIVATE workspace package must look unpublishable
 *   in every field a reader checks. Two invariants, one idea:
 *
 *   1. NAME: unscoped and `local-<own directory name>`, never path-derived.
 *   2. VERSION: always `0.0.0`, never anything else.
 *
 *   `@acorn/tests` at `1.0.0` reads exactly like a published package. It is a
 *   test corpus that never ships. That costs three ways:
 *
 *   - It is indistinguishable from a real package in a manifest, a lockfile, an
 *     install tree, or a release log. A reader must open the file to learn it
 *     never publishes.
 *   - A scope squats a namespace. `@acorn/*` implies an `acorn` npm org the
 *     repo may not own, and a name someone else could take.
 *   - A real-looking version invites version reasoning that has no meaning: a
 *     package that never publishes has no release history to be `1.0.0` of, and
 *     a bumper that walks the workspace will happily carry it along.
 *
 *   `0.0.0` is the fleet's existing "this is not a release" sentinel (the same
 *   value a local name reservation carries), so a private package sitting at
 *   `0.0.0` is self-evidently outside the release story.
 *
 *     packages/acorn/test   ->  local-test   @ 0.0.0
 *     packages/acorn/bench  ->  local-bench  @ 0.0.0
 *     <repo root>           ->  ultrathink   @ 0.0.0
 *
 *   `local-` rather than `private-`, because on npm a "private package" is a
 *   PUBLISHED one with restricted access — the prefix has to mean the opposite
 *   of publishable, not a flavour of it.
 *
 *   The name is the package's OWN directory, never its path. A path-derived
 *   name renames on every move, so relocating a directory rewrites every
 *   dependent manifest and the lockfile for a change that moved no code. It
 *   also grew 105-character names once per-hook and per-rule packages landed
 *   under dot-directories, and put a dot inside a package name.
 *
 *   THE DECLARED VERSION SOURCE IS EXEMPT from the version pin — the SPECIAL
 *   case, never the general one. A repo names it per-repo:
 *
 *     // .config/repo/socket-wheelhouse.json
 *     { "release": { "versionSource": "package.json" } }
 *
 *   Only that one file is spared, and only its VERSION (its name still has to
 *   be explicit). Two reasons a manifest holds a real version while private:
 *
 *   - Its release channel does not read npm. A `custom` repo ships to the VS
 *     Code / Open VSX marketplaces and a `binary` repo ships GitHub release
 *     assets; both keep the release number on a manifest npm never sees.
 *     Pinning it to 0.0.0 ships a 0.0.0 release.
 *   - It is the workspace version source the lockstep bump moves from, so
 *     zeroing it breaks the bump for every member of that workspace.
 *
 *   It is DECLARED rather than inferred because `private: true` plus a real
 *   version is the same bytes whether it is a marketplace release or an
 *   oversight. Inferring "the root is probably fine" would grant the exemption
 *   to every repo, including the ones that do not deserve it, and would leave a
 *   build with no single answer to "what version am I stamping?".
 *   `_shared/release-version-source.mts` is that answer, and builds read it too.
 *
 *   DECLARED PUBLISHES ARE SKIPPED. A package listed in
 *   `release.publishedPackages` is owned by
 *   `published-packages-are-release-ready`, which drops its `private` flag and
 *   syncs its version. Without this exclusion the two fixers would fight
 *   forever: that check un-privates the package, this one renames it back for
 *   being private. One package, one owning check.
 *
 *   `--fix` renames, resets the version, AND rewrites every tracked manifest
 *   that depends on the old name. A rename without the reference sweep breaks
 *   `pnpm install` for every dependent.
 *
 *   Exit: 0 — every private package is unmistakably unpublishable; 1 — one is
 *   scoped, misnamed, or carries a non-zero version.
 *
 *   Usage: node scripts/fleet/check/private-packages-are-unpublishable.mts [--fix] [--quiet]
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { normalizePath } from '@socketsecurity/lib-stable/paths/normalize'
import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'

import { REPO_ROOT } from '../paths.mts'
import {
  reportSkippedMirrors,
  writeUnlessMirrored,
} from '../_shared/cascaded-mirrors.mts'
import { TEMPLATE_PAYLOAD_DIRS } from '../_shared/template-payload-scope.mts'

// The canonical tier every live mirror hangs off.
const CANONICAL_TEMPLATE_PREFIX = 'template/base/'
import { isMainModule } from '../_shared/is-main-module.mts'
import { readVersionSource } from '../_shared/release-version-source.mts'
import { runMain } from '../_shared/run-main.mts'

import type { ScriptMeta } from '../_shared/run-main.mts'

const logger = getDefaultLogger()

const REPO_CONFIG_REL = '.config/repo/socket-wheelhouse.json'

/**
 * The fleet's "this is not a release" sentinel.
 */
export const PRIVATE_VERSION = '0.0.0'

/**
 * The prefix every non-root private package name carries. Stated once so the
 * check, the fixer, and the tests cannot drift on it.
 */
export const LOCAL_NAME_PREFIX = 'local-'

// The manifest fields that can name another workspace package. A rename has to
// sweep all of them or the workspace stops resolving.
const DEPENDENCY_FIELDS: readonly string[] = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

export interface PrivateViolation {
  actualName: string
  actualVersion: string
  expectedName: string
  manifestPath: string
  nameWrong: boolean
  versionWrong: boolean
}

export interface RepoDeclarations {
  publishedPackages: string[]
  repoName: string
}

/**
 * The repo's own name plus the packages it declares it publishes. The name
 * prefixes every derived name, which keeps a private package unique across the
 * fleet rather than only within its own repo; the publish list is the skip set.
 */
export function readRepoDeclarations(repoRoot: string): RepoDeclarations {
  let repoName = path.basename(repoRoot)
  let publishedPackages: string[] = []
  try {
    const cfg = JSON.parse(
      readFileSync(path.join(repoRoot, REPO_CONFIG_REL), 'utf8'),
    ) as {
      release?: { publishedPackages?: unknown | undefined } | undefined
      repoName?: unknown | undefined
    }
    if (typeof cfg.repoName === 'string' && cfg.repoName) {
      repoName = cfg.repoName
    }
    const declared = cfg.release?.publishedPackages
    if (Array.isArray(declared)) {
      publishedPackages = declared.filter(
        (n): n is string => typeof n === 'string',
      )
    }
  } catch {
    // Fall through to the directory name and an empty publish list.
  }
  return { publishedPackages, repoName }
}

/**
 * One directory segment as an npm-name segment: lowercase, dot-free, and
 * kebab-joined. A dot-directory (`.claude`, `.config`) would otherwise put a
 * dot in the middle of a package name, and a leading dot is illegal in an npm
 * name outright. Pure; exported for tests.
 */
export function sanitizeNameSegment(segment: string): string {
  return (
    segment
      .toLowerCase()
      // Any run of characters npm disallows in a name (a dot, an underscore, a
      // space) collapses to one dash.
      .replace(/[^a-z0-9-]+/g, '-')
      // `^-+` trims dashes at the start, which is where a dot-directory leaves
      // one; `-+$` trims them at the end. Alternation so one pass does both.
      .replace(/^-+|-+$/g, '')
  )
}

/**
 * The explicit name a private package at `manifestRelPath` must carry:
 * `local-<its own directory name>`. The repo-root manifest keeps the bare repo
 * name, which is the repo's identity rather than a workspace member's.
 *
 * `local-` rather than `private-`: on npm a "private package" is a PUBLISHED
 * one with restricted access, so a `private-` prefix would re-introduce the
 * ambiguity this check exists to remove. `local-` has no competing meaning —
 * it never leaves the repo.
 *
 * The name deliberately does NOT encode the path. A path-derived name renames
 * the package every time the directory moves, which means editing every
 * dependent manifest and the lockfile for a change that moved no code, and it
 * produced 105-character names once the fleet grew per-hook and per-rule
 * packages under dot-directories.
 *
 * Uniqueness is by directory name. When two private packages sit in
 * same-named directories (`perf/npm` and `test/npm` both end in `npm`),
 * `resolveExpectedNames` widens JUST the colliding group by one parent
 * segment at a time until each name is unique (`local-perf-npm`,
 * `local-test-npm`) — everyone else keeps the short own-dir name. Pure;
 * exported for tests.
 */
export function deriveExplicitName(
  repoName: string,
  manifestRelPath: string,
  segments = 1,
): string {
  const dir = path.posix.dirname(normalizePath(manifestRelPath))
  if (dir === '' || dir === '.') {
    return repoName
  }
  const tail = normalizePath(dir)
    .split('/')
    .filter(Boolean)
    .slice(-segments)
    .map(sanitizeNameSegment)
    .filter(Boolean)
    .join('-')
  return tail ? `${LOCAL_NAME_PREFIX}${tail}` : repoName
}

/**
 * The expected name for every private manifest at once, collisions widened.
 * Starts everyone at the own-dir name; a group that claims one name escalates
 * to parent-and-own, then further up, until each member's name is unique.
 * Terminates because a directory holds at most one manifest, so full paths
 * are unique and at full depth no two members can still share a name.
 */
export function resolveExpectedNames(
  repoName: string,
  relPaths: readonly string[],
): Map<string, string> {
  const resolved = new Map<string, string>()
  let pending = [...relPaths]
  let segments = 1
  while (pending.length) {
    const groups = new Map<string, string[]>()
    for (let i = 0, { length } = pending; i < length; i += 1) {
      const rel = pending[i]!
      const name = deriveExplicitName(repoName, rel, segments)
      groups.set(name, [...(groups.get(name) ?? []), rel])
    }
    const contested: string[] = []
    for (const { 0: name, 1: group } of groups) {
      if (group.length === 1) {
        resolved.set(group[0]!, name)
      } else {
        contested.push(...group)
      }
    }
    pending = contested
    segments += 1
  }
  return resolved
}

/**
 * True when `name` looks like a publishable npm package. A leading `@` is the
 * tell: a scope is the public-registry namespace.
 */
export function isScopedName(name: string): boolean {
  return name.startsWith('@')
}

/**
 * True when `manifestRelPath` is the repo's DECLARED release version source
 * (`release.versionSource`). Exported so the exemption is testable without a
 * repo on disk.
 *
 * This is deliberately a declaration rather than "the root looks fine": a
 * private-and-versioned manifest is the same bytes whether it is a marketplace
 * release's version source or an oversight, so the difference has to be stated.
 */
export function isDeclaredVersionSource(
  manifestRelPath: string,
  versionSourceRelPath: string | undefined,
): boolean {
  if (!versionSourceRelPath) {
    return false
  }
  return normalizePath(manifestRelPath) === normalizePath(versionSourceRelPath)
}

/**
 * True when a manifest lives in a cascaded live-mirror tree of the wheelhouse
 * checkout. A mirror is a byte-copy of its `template/base/` source, so it can
 * only ever carry the TEMPLATE copy's name — a location-derived name for the
 * mirror path would contradict the byte-mirror invariant. The template copy
 * is the gated canonical; the mirror is generated output, and generated files
 * are never gated. Members never hit this: their fleet payload is untracked
 * (pack-fetched), so tracked-only listing already excludes it.
 */
export function isCascadedMirrorManifest(relPath: string): boolean {
  const normalized = normalizePath(relPath)
  for (let i = 0, { length } = TEMPLATE_PAYLOAD_DIRS; i < length; i += 1) {
    const dir = TEMPLATE_PAYLOAD_DIRS[i]!
    if (dir.startsWith(CANONICAL_TEMPLATE_PREFIX)) {
      const mirrorRoot = dir.slice(CANONICAL_TEMPLATE_PREFIX.length)
      if (normalized.startsWith(`${mirrorRoot}/`)) {
        return true
      }
    }
  }
  return false
}

// A manifest under a fixtures dir is test corpus: its name and version ARE
// the test data (a scanner fixture simulating a real project at a real
// version), and a fixtures dir is never a workspace member, so it can never
// reach a publish. Renaming one to the private-identity shape corrupts what
// the fixture represents.
const FIXTURE_MANIFEST_RE = /(?:^|\/)(?:__)?fixtures(?:__)?\//

/**
 * Tracked manifest paths. Tracked-only keeps generated build output (wasm-pack
 * `pkg-node/`, napi staging dirs) out of the set — those manifests are
 * rewritten by their generator on every build, so renaming one is both futile
 * and a source of phantom drift. Cascaded live mirrors are excluded for the
 * same reason: the cascade regenerates them from `template/base/`, which is
 * where their canonical (gated) copy lives. Fixture manifests are corpus, not
 * identity, and stay out entirely.
 */
export function listTrackedManifests(repoRoot: string): string[] {
  const result = spawnSync('git', ['ls-files', '*package.json'], {
    cwd: repoRoot,
    stdio: 'pipe',
    stdioString: true,
  })
  if (result.status !== 0) {
    return []
  }
  return String(result.stdout ?? '')
    .replace(/\r\n/g, '\n')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(rel => !isCascadedMirrorManifest(rel))
    .filter(rel => !FIXTURE_MANIFEST_RE.test(rel))
}

/**
 * Every private package violating either invariant. A package named in
 * `publishedPackages` is skipped: `published-packages-are-release-ready` owns
 * it. Pure over the manifests it is handed; exported for tests.
 */
export function findViolations(
  repoName: string,
  publishedPackages: readonly string[],
  manifests: ReadonlyArray<{
    name: string | undefined
    private: boolean
    relPath: string
    version: string
  }>,
  versionSourceRelPath?: string | undefined,
): PrivateViolation[] {
  const declared = new Set(publishedPackages)
  const out: PrivateViolation[] = []
  // Names derive from a directory name rather than a path, so two private
  // packages in same-named directories would claim one name — a real
  // conflict, pnpm resolves one of them. resolveExpectedNames widens the
  // colliding group with parent segments until every name is unique.
  const privatePaths: string[] = []
  for (let i = 0, { length } = manifests; i < length; i += 1) {
    const entry = manifests[i]!
    if (entry.private && entry.name && !declared.has(entry.name)) {
      privatePaths.push(entry.relPath)
    }
  }
  const expectedNames = resolveExpectedNames(repoName, privatePaths)
  for (let i = 0, { length } = manifests; i < length; i += 1) {
    const entry = manifests[i]!
    if (!entry.private || !entry.name || declared.has(entry.name)) {
      continue
    }
    // The DECLARED release version source is exempt from the version pin. It
    // is the special case, never the general one: a repo states outright which
    // manifest holds its release version, and only that file is spared. A
    // marketplace (`custom`) or GitHub-release (`binary`) repo keeps a real
    // version on a private manifest because its channel does not read npm, and
    // a workspace's version source is what the lockstep bump moves from.
    // Pinning either to 0.0.0 ships a 0.0.0 release.
    const isVersionSource = isDeclaredVersionSource(
      entry.relPath,
      versionSourceRelPath,
    )
    const expectedName =
      expectedNames.get(entry.relPath) ??
      deriveExplicitName(repoName, entry.relPath)
    const nameWrong = entry.name !== expectedName
    // Only the VERSION pin is waived for the version source. Its NAME still has
    // to be explicit, and for a root manifest the derived name is the repo's
    // own name, which is what it already carries.
    const versionWrong = !isVersionSource && entry.version !== PRIVATE_VERSION
    if (nameWrong || versionWrong) {
      out.push({
        actualName: entry.name,
        actualVersion: entry.version,
        expectedName,
        manifestPath: entry.relPath,
        nameWrong,
        versionWrong,
      })
    }
  }
  return out
}

/**
 * Rewrite one manifest's dependency fields, swapping `from` to `to`. Returns
 * true when it changed. The spec value is preserved as-is, so a `workspace:*` /
 * `catalog:` / exact pin survives the rename untouched.
 */
export function rewriteReferences(
  manifest: Record<string, unknown>,
  from: string,
  to: string,
): boolean {
  let changed = false
  for (let i = 0, { length } = DEPENDENCY_FIELDS; i < length; i += 1) {
    const field = DEPENDENCY_FIELDS[i]!
    const deps = manifest[field]
    if (!deps || typeof deps !== 'object') {
      continue
    }
    const table = deps as Record<string, unknown>
    if (!Object.hasOwn(table, from)) {
      continue
    }
    table[to] = table[from]
    delete table[from]
    changed = true
  }
  return changed
}

export function main(): number {
  const fix = process.argv.includes('--fix')
  const quiet = process.argv.includes('--quiet')
  const { publishedPackages, repoName } = readRepoDeclarations(REPO_ROOT)
  const relPaths = listTrackedManifests(REPO_ROOT)

  const parsed: Array<{
    manifest: Record<string, unknown>
    name: string | undefined
    private: boolean
    relPath: string
    version: string
  }> = []
  for (let i = 0, { length } = relPaths; i < length; i += 1) {
    const relPath = relPaths[i]!
    try {
      const manifest = JSON.parse(
        readFileSync(path.join(REPO_ROOT, relPath), 'utf8'),
      ) as Record<string, unknown>
      parsed.push({
        manifest,
        name:
          typeof manifest['name'] === 'string' ? manifest['name'] : undefined,
        private: manifest['private'] === true,
        relPath,
        version:
          typeof manifest['version'] === 'string'
            ? manifest['version']
            : PRIVATE_VERSION,
      })
    } catch {
      // An unparseable manifest is another check's finding.
    }
  }

  const versionSource = readVersionSource(REPO_ROOT)
  const violations = findViolations(
    repoName,
    publishedPackages,
    parsed,
    versionSource?.relPath,
  )
  if (violations.length === 0) {
    if (!quiet) {
      logger.success(
        '[private-packages-are-unpublishable] every private package is unscoped, local-named, and at 0.0.0.',
      )
    }
    return 0
  }

  if (fix) {
    const renames = new Map(
      violations
        .filter(v => v.nameWrong)
        .map(v => [v.actualName, v.expectedName]),
    )
    const toReset = new Set(
      violations.filter(v => v.versionWrong).map(v => v.manifestPath),
    )
    let renamed = 0
    let reset = 0
    let referencesUpdated = 0
    const unwritable: string[] = []
    for (let i = 0, { length } = parsed; i < length; i += 1) {
      const entry = parsed[i]!
      let changed = false
      const target = entry.name ? renames.get(entry.name) : undefined
      if (target && entry.private) {
        entry.manifest['name'] = target
        changed = true
        renamed += 1
      }
      if (toReset.has(entry.relPath)) {
        entry.manifest['version'] = PRIVATE_VERSION
        changed = true
        reset += 1
      }
      for (const [from, to] of renames) {
        if (rewriteReferences(entry.manifest, from, to)) {
          changed = true
          referencesUpdated += 1
        }
      }
      if (changed) {
        // A cascaded live mirror is read-only on purpose; the template copy
        // is the one to fix, and the cascade moves the mirror.
        if (
          !writeUnlessMirrored(
            path.join(REPO_ROOT, entry.relPath),
            `${JSON.stringify(entry.manifest, undefined, 2)}\n`,
          )
        ) {
          unwritable.push(entry.relPath)
        }
      }
    }
    logger.success(
      `[private-packages-are-unpublishable] renamed ${renamed}, reset ${reset} version(s) to ${PRIVATE_VERSION}, updated ${referencesUpdated} dependent manifest(s). Run \`pnpm install\` to relink the workspace.`,
    )
    reportSkippedMirrors('private-packages-are-unpublishable', unwritable)
    return 0
  }

  const scoped = violations.filter(v => isScopedName(v.actualName))
  const versioned = violations.filter(v => v.versionWrong)
  logger.fail(
    '[private-packages-are-unpublishable] private packages are dressed as publishable ones:',
  )
  logger.error(
    `  What:   ${violations.length} private package(s) break the rule${scoped.length ? `; ${scoped.length} use an npm SCOPE, which reads as a published product and squats the namespace` : ''}${versioned.length ? `; ${versioned.length} carry a version other than ${PRIVATE_VERSION}, inviting release reasoning about something that never ships` : ''}.`,
  )
  logger.error('  Where:  each package.json listed below.')
  for (let i = 0, { length } = violations; i < length; i += 1) {
    const v = violations[i]!
    const parts: string[] = []
    if (v.nameWrong) {
      parts.push(`${v.actualName} -> ${v.expectedName}`)
    }
    if (v.versionWrong) {
      parts.push(`${v.actualVersion} -> ${PRIVATE_VERSION}`)
    }
    logger.substep(`${parts.join(', ')}  (${v.manifestPath})`)
  }
  logger.error(
    `  Saw:    a private package wearing a publishable identity; wanted an unscoped \`<repo>-<dir-path>\` name at ${PRIVATE_VERSION}, so both fields state it never ships and the name says where it lives.`,
  )
  logger.error(
    '  Fix:    run this check with --fix. It renames, resets the version, and rewrites every dependent manifest; then run `pnpm install` to relink. If the package SHOULD publish, drop `"private": true` and add it to release.publishedPackages instead.',
  )
  return 1
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'a private package is unscoped, named <repo>-<dir-path>, and pinned at 0.0.0',
  help: `Usage: node scripts/fleet/check/private-packages-are-unpublishable.mts [--fix] [--quiet]`,
}

/* c8 ignore start - entry-point wiring, exercised by running the script. */
if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
/* c8 ignore stop */
