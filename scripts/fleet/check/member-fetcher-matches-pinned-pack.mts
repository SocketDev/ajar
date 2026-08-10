#!/usr/bin/env node
/*
 * @file `check --all` gate — the member half of the fetcher stamp: the
 *   member's dep-0 fetcher pair (scripts/repo/bootstrap/fleet.d.mts +
 *   fleet.mjs) matches the `fetcher` sha256 hashes stamped into the pinned
 *   fleet pack's release-bundle manifest. The fetcher is repo-owned and
 *   tracked in every member; no pack delivers it and hydration never
 *   rewrites it, so a fetcher fix reaches a member ONLY via a cascade
 *   commit — a member left behind keeps REPRODUCING retired fetcher bugs
 *   (2026-08-07: a stale member fetcher re-untracked .github/dependabot.yml,
 *   three separate times, after the fix had landed in the wheelhouse).
 *
 *   Sources: the pin — `bundle.ref` in the member's wheelhouse settings file
 *   (.config/repo/socket-wheelhouse.json); the expected hashes — the pinned
 *   release's release-bundle-manifest.json `fetcher` field; the actual — the
 *   on-disk pair's bytes. The manifest arrives via `gh release download`,
 *   the same release asset the fetcher's own fallback path consumes. The
 *   pair is tracked and nothing rewrites the working copy silently, so the
 *   disk read audits what the next commit ships without a spawn whose
 *   stdout trimming could corrupt a byte-exact hash.
 *
 *   Vacuous pass with no `bundle.ref`, which means the wheelhouse itself: it
 *   produces the bundle rather than consuming it. Every member is thin and
 *   carries the pin, so there is no fat-member case to exempt. Fails OPEN
 *   (exit 0, manual-verify note) when
 *   the pinned manifest can't be fetched or parsed — offline or a
 *   logged-out `gh` is an environment condition, never a code defect that
 *   should red-light the local gate (same rationale as
 *   prebakes-are-public) — and when the pinned pack predates the `fetcher`
 *   stamp, where the fix is a repin, not a red gate.
 *
 *   Exit codes: 0 — match / vacuous / fail-open; 1 — the member's fetcher
 *   pair drifts from the pinned pack's stamp.
 *
 *   Usage: node scripts/fleet/check/member-fetcher-matches-pinned-pack.mts [--quiet]
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { hash } from '@socketsecurity/lib-stable/crypto/hash'
import { errorMessage } from '@socketsecurity/lib-stable/errors/message'
import { safeDeleteSync } from '@socketsecurity/lib-stable/fs/safe'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'

import { loadSocketWheelhouseConfig, REPO_ROOT } from '../paths.mts'
import { isFleetPackProducer } from '../_shared/fleet-membership.mts'
import { isMainModule } from '../_shared/is-main-module.mts'
import { runMain } from '../_shared/run-main.mts'

import type { ScriptMeta } from '../_shared/run-main.mts'

const logger = getDefaultLogger()

// The releases repo every member's bundle pin resolves against — the same
// default the dep-0 fetcher carries.
export const WHEELHOUSE_REPO = 'SocketDev/socket-wheelhouse'

// The member-side fetcher pair, keyed the way the manifest's `fetcher` field
// keys its hashes: basenames under scripts/repo/bootstrap/.
export const FETCHER_DIR = path.join('scripts', 'repo', 'bootstrap')
export const FETCHER_PAIR = ['fleet.d.mts', 'fleet.mjs'] as const

const MANIFEST_NAME = 'release-bundle-manifest.json'

export interface FetcherFinding {
  // sha256 of the member's on-disk file, or undefined when the file is absent.
  readonly actual: string | undefined
  // Basename under scripts/repo/bootstrap/.
  readonly file: string
  // sha256 the pinned pack's manifest stamps.
  readonly pinned: string
}

export type FetchPinnedManifestFn = (config: {
  readonly ref: string
  readonly repo: string
}) => Promise<unknown>

/**
 * The `fetcher` stamp out of a parsed release-bundle manifest, or `undefined`
 * when the manifest predates the stamp or is not shaped like a manifest. Pure.
 */
export function extractFetcherStamp(
  manifest: unknown,
): Record<string, string> | undefined {
  if (typeof manifest !== 'object' || manifest === null) {
    return undefined
  }
  const stamp = (manifest as { fetcher?: unknown | undefined }).fetcher
  if (typeof stamp !== 'object' || stamp === null || Array.isArray(stamp)) {
    return undefined
  }
  const entries = Object.entries(stamp)
  if (
    entries.length === 0 ||
    entries.some(([, value]) => typeof value !== 'string')
  ) {
    return undefined
  }
  return Object.fromEntries(entries) as Record<string, string>
}

/**
 * Compare the member's actual hashes against the pinned stamp. Pure. One
 * finding per stamped file whose actual hash differs — an ABSENT member file
 * is a finding too (actual undefined), never a skip: a pinned thin member
 * without its fetcher cannot hydrate at all.
 */
export function evaluateFetcherMatch(config: {
  readonly actual: Record<string, string | undefined>
  readonly pinned: Record<string, string>
}): FetcherFinding[] {
  const cfg = { __proto__: null, ...config } as typeof config
  const findings: FetcherFinding[] = []
  const files = Object.keys(cfg.pinned).toSorted()
  for (let i = 0, { length } = files; i < length; i += 1) {
    const file = files[i]!
    const pinned = cfg.pinned[file]!
    const actual = cfg.actual[file]
    if (actual !== pinned) {
      findings.push({ actual, file, pinned })
    }
  }
  return findings
}

/**
 * Sha256 (hex) of each fetcher-pair file's on-disk bytes under `repoRoot`,
 * keyed by basename; `undefined` marks an absent file.
 */
export function readFetcherPairHashes(
  repoRoot: string,
): Record<string, string | undefined> {
  // the null-proto options-bag idiom: `{ __proto__: null }` builds a
  // prototype-less map at runtime, a shape TS object-literal typing cannot
  // express without this assertion.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- null proto
  const hashes: Record<string, string | undefined> = {
    __proto__: null,
  } as unknown as Record<string, string | undefined>
  for (let i = 0, { length } = FETCHER_PAIR; i < length; i += 1) {
    const name = FETCHER_PAIR[i]!
    const file = path.join(repoRoot, FETCHER_DIR, name)
    hashes[name] = existsSync(file)
      ? hash('sha256', readFileSync(file), 'hex')
      : undefined
  }
  return hashes
}

/**
 * The member's pinned `bundle.ref`, or `undefined` when the settings file is
 * absent or carries no pin — the not-a-thin-consumer vacuous-pass signal.
 */
export function pinnedBundleRef(repoRoot: string): string | undefined {
  const loaded = loadSocketWheelhouseConfig(repoRoot)
  const bundle = (
    loaded?.value as
      | { bundle?: { ref?: string | undefined } | undefined }
      | undefined
  )?.bundle
  const ref = bundle?.ref
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/**
 * Default manifest fetch: `gh release download` of the pinned release's
 * manifest asset into a tmpdir, parsed as JSON. Throws on any failure —
 * main() converts a throw into the fail-open note.
 */
export async function ghFetchPinnedManifest(config: {
  readonly ref: string
  readonly repo: string
}): Promise<unknown> {
  const cfg = { __proto__: null, ...config } as typeof config
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'fetcher-stamp-'))
  try {
    await spawn(
      'gh',
      [
        'release',
        'download',
        cfg.ref,
        '--repo',
        cfg.repo,
        '--pattern',
        MANIFEST_NAME,
        '--dir',
        tmp,
      ],
      { stdio: 'pipe', stdioString: true, timeout: 60_000 },
    )
    return JSON.parse(readFileSync(path.join(tmp, MANIFEST_NAME), 'utf8'))
  } finally {
    safeDeleteSync(tmp)
  }
}

export async function main(
  fetchFn?: FetchPinnedManifestFn | undefined,
): Promise<void> {
  const quiet = process.argv.includes('--quiet')
  const ref = pinnedBundleRef(REPO_ROOT)
  if (ref === undefined) {
    // The producer builds the pack, so it has nothing to pin. Every member is
    // thin and pins the bundle it hydrates from, so a member with no pin has no
    // fetcher to compare — it simply never fetches, which this must not pass.
    if (isFleetPackProducer(REPO_ROOT)) {
      if (!quiet) {
        logger.log(
          'member-fetcher-matches-pinned-pack: the fleet-pack producer has nothing to pin — nothing to compare.',
        )
      }
      process.exitCode = 0
      return
    }
    logger.fail(
      'member-fetcher-matches-pinned-pack: no bundle.ref pin, and this repo does not produce the fleet pack.',
    )
    logger.error(
      [
        'What:   a member with no bundle.ref has no pinned pack to match.',
        'Where:  the wheelhouse settings file that should carry the pin.',
        'Wanted: every member is thin and pins the bundle its fetcher hydrates.',
        'Fix:    restore the bundle.ref pin, or correct the roster entry.',
      ].join('\n'),
    )
    process.exitCode = 1
    return
  }

  let manifest: unknown
  try {
    manifest = await (fetchFn ?? ghFetchPinnedManifest)({
      ref,
      repo: WHEELHOUSE_REPO,
    })
  } catch (e) {
    logger.warn(
      `member-fetcher-matches-pinned-pack: could not read the pinned pack's manifest (${errorMessage(e)}). ` +
        'Offline or a logged-out gh is an environment condition — failing open. Verify manually:\n' +
        `    gh release download ${ref} --repo ${WHEELHOUSE_REPO} --pattern ${MANIFEST_NAME} --dir <tmp>`,
    )
    process.exitCode = 0
    return
  }

  const pinned = extractFetcherStamp(manifest)
  if (pinned === undefined) {
    logger.warn(
      `member-fetcher-matches-pinned-pack: the pinned pack ${ref} predates the manifest's fetcher stamp — nothing to compare. ` +
        'Repin to a newer fleet pack to activate this gate.',
    )
    process.exitCode = 0
    return
  }

  const findings = evaluateFetcherMatch({
    actual: readFetcherPairHashes(REPO_ROOT),
    pinned,
  })
  if (findings.length === 0) {
    if (!quiet) {
      logger.success(
        `member-fetcher-matches-pinned-pack: the fetcher pair matches the ${ref} stamp.`,
      )
    }
    process.exitCode = 0
    return
  }

  logger.fail(
    `member-fetcher-matches-pinned-pack: ${findings.length} fetcher file(s) drift from the pinned pack's stamp:`,
  )
  for (let i = 0, { length } = findings; i < length; i += 1) {
    const finding = findings[i]!
    logger.fail(
      `  ${FETCHER_DIR}/${finding.file}: saw ${finding.actual ?? 'ABSENT'}, pinned pack stamps ${finding.pinned}`,
    )
  }
  logger.fail(
    '  What:   the repo-owned dep-0 fetcher pair diverges from the build the\n' +
      '          pinned fleet pack was cut with. No pack delivers the fetcher\n' +
      '          and hydration never rewrites it, so this repo is running a\n' +
      '          retired fetcher until a cascade commit updates it.\n' +
      `  Where:  ${FETCHER_DIR}/ vs release ${ref} ${MANIFEST_NAME} "fetcher".\n` +
      '  Wanted: sha256 of each committed fetcher file equals its stamp.\n' +
      '  Fix:    re-cascade the fetcher pair from the wheelhouse — in the\n' +
      '          wheelhouse checkout run:\n' +
      `              node scripts/repo/sync-scaffolding/cli.mts --target ${REPO_ROOT} --fix\n` +
      `          then commit ${FETCHER_DIR}/ here.`,
  )
  process.exitCode = 1
}

/* c8 ignore start - entrypoint guard; exercised via subprocess */
const SCRIPT_META: ScriptMeta = {
  describe:
    "checks the member's dep-0 fetcher pair matches the hashes stamped in the pinned fleet pack's manifest",
  help: `Usage: node scripts/fleet/check/member-fetcher-matches-pinned-pack.mts [flags]
  --quiet  suppress the success / vacuous-pass lines`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
/* c8 ignore stop */
