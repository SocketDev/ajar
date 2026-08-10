/**
 * @file Forbid modern runtime built-ins whose `engines.node` floor predates the
 *   Node major that first shipped them — below that floor they throw
 *   `TypeError: ... is not a function` at runtime, which a type-checker
 *   targeting a newer lib won't catch. ENGINE-AWARE, not a blanket ban: the
 *   rule walks up to the nearest `package.json`, reads `engines.node`, and
 *   fires per feature only when the declared floor is below that feature's Node
 *   major. No engines field means evergreen — everything allowed. Coverage
 *   spans ES2023–2026; the feature → Node-major table is mirrored in
 *   MEMBER_METHOD_MAJORS / STATIC_METHOD_MAJORS below. Sources, safe rewrites,
 *   and the recheck cadence (verified 2026-06-11):
 *   docs/agents.md/fleet/runtime-feature-floors.md.
 */

/**
 * @type {import('eslint').Rule.RuleModule}
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { RUNTIME_FEATURE_FLOORS } from '../../lib/runtime-feature-floors.mts'
import type { AstNode, RuleContext } from '../../lib/rule-types.mts'

// Both maps below are DERIVED from lib/runtime-feature-floors.mts, the single
// source of truth. They used to be inline copies, and they had already drifted:
// findLast/findLastIndex sat at major 20 here and 18 there, so the rule under-
// reported on a Node 18 floor. Deriving means a new feature is added once.

// Member methods matched as `x.<name>(...)`, by name.
const MEMBER_METHOD_MAJORS = new Map<string, { major: number; fix: string }>(
  RUNTIME_FEATURE_FLOORS.filter(f => f.kind === 'member').map(f => [
    f.name,
    { major: f.major, fix: f.fix },
  ]),
)

// Static methods matched as `<Global>.<name>(...)`. A name can hang off more
// than one global (Object.groupBy and Map.groupBy), so the key is
// `<object>.<name>` rather than the bare name — which is what forced the old
// GROUP_BY_* special case that this replaces.
const STATIC_METHOD_MAJORS = new Map<string, { major: number; fix: string }>(
  RUNTIME_FEATURE_FLOORS.filter(f => f.kind === 'static').map(f => [
    `${f.object}.${f.name}`,
    { major: f.major, fix: f.fix },
  ]),
)

// The floor that applies to hook sources, regardless of engines.node.
//
// A file under `.claude/hooks/` is compiled into the .cjs dispatch bundles,
// and those run on a contributor's AMBIENT node — down to 18, which is what
// es-polyfills.mts targets. engines.node (>=24) describes who can develop the
// repo, not what executes the bundle, so reading it here would clear a feature
// the bundle then throws on. This is the surface that needed the rule most and
// was the one it could not see.
const HOOK_BUNDLE_FLOOR = 18

const HOOK_PATH_RE = /[\\/]\.claude[\\/]hooks[\\/]/

// Per-directory cache: directory → engines.node floor major (or undefined when
// none found / evergreen). Keyed by the directory walked up from a file, so
// repeated files in the same package don't re-read disk.
const floorCache = new Map<string, number | undefined>()

// The leading major version in a semver range string, or undefined when none
// parses. `>=18`, `>= 18.20.8`, `^18.0.0`, `18 || 20` → 18.
export function parseNodeFloorMajor(range: string): number | undefined {
  const m = /(?<major>\d+)/.exec(range)
  if (!m) {
    return undefined
  }
  /* c8 ignore start - m.groups is always defined when exec() matches a named-group pattern; \d+ always produces an integer */
  const n = Number(m.groups?.['major'])
  return Number.isInteger(n) ? n : undefined
  /* c8 ignore stop */
}

// Walk up from `fromDir` to the nearest package.json; return its engines.node
// floor major, or undefined when no package.json / no engines.node is found.
export function nearestEnginesNodeFloor(fromDir: string): number | undefined {
  let dir = fromDir
  // Bounded walk to the filesystem root.
  for (let i = 0; i < 64; i += 1) {
    const pkgPath = path.join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          engines?: { node?: unknown | undefined } | undefined
        }
        const node = pkg.engines?.node
        if (typeof node === 'string') {
          return parseNodeFloorMajor(node)
        }
      } catch {
        // Unreadable / malformed package.json — keep walking up.
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  return undefined
}

/**
 * True when `filename` is compiled into the hook dispatch bundles. Those .cjs
 * bundles run on a contributor's AMBIENT node, so they carry their own floor
 * rather than the repo's engines.node. Pure; exported for tests.
 */
export function isHookBundleSource(filename: string): boolean {
  return HOOK_PATH_RE.test(filename)
}

// The floor major for the file at `filename`, or undefined when none applies
// (assumed evergreen → every feature allowed).
//
// A hook source takes the LOWER of the bundle floor and any declared
// engines.node. engines.node says who can develop the repo; the bundle floor
// says what has to execute it, and only the second one throws at a user.
export function floorMajorFor(filename: string): number | undefined {
  if (isHookBundleSource(filename)) {
    const declared = enginesFloorFor(filename)
    return declared === undefined
      ? HOOK_BUNDLE_FLOOR
      : Math.min(declared, HOOK_BUNDLE_FLOOR)
  }
  return enginesFloorFor(filename)
}

// The engines.node floor major for the file at `filename`, or undefined when no
// engines field is found (assumed evergreen → every feature allowed).
export function enginesFloorFor(filename: string): number | undefined {
  const dir = path.dirname(filename)
  if (floorCache.has(dir)) {
    return floorCache.get(dir)
  }
  const floor = nearestEnginesNodeFloor(dir)
  floorCache.set(dir, floor)
  return floor
}

// Feature names whose suggested fix string contains `.sort(` and would
// therefore be autofixed back by unicorn/no-array-sort on the next --fix pass,
// causing repeated autofix oscillation. For these, the rule emits
// belowEngineFloorOscillates to name the convergent manual form that breaks
// the oscillation cycle. Derived from MEMBER_METHOD_MAJORS entries whose `fix`
// string contains `.sort(`.
export const OSCILLATING_FEATURES = new Set<string>(['toSorted'])

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Forbid modern runtime built-ins (ES2023–2026 array copy/find methods, Object/Map.groupBy, Promise.withResolvers, Array.fromAsync) in repos whose engines.node floor is below the feature's Node major.",
      category: 'Best Practices',
      recommended: true,
    },
    fixable: undefined,
    messages: {
      belowEngineFloor:
        '`{{name}}` requires Node {{major}}+, but this package declares `engines.node` below {{major}} — it throws at runtime on the supported floor. Rewrite as {{fix}} (no shim needed).',
      // Used instead of belowEngineFloor when the suggested fix contains .sort()
      // and would be autofixed back by unicorn/no-array-sort, causing oscillation.
      // Names the convergent manual form to break the cycle.
      belowEngineFloorOscillates:
        '`{{name}}` requires Node {{major}}+, but this package declares `engines.node` below {{major}} — it throws at runtime on the supported floor. Do NOT use `{{fix}}` — that triggers unicorn/no-array-sort and causes autofix oscillation. Convergent form: `arr.slice().sort(cmp)` with `// oxlint-disable-next-line unicorn/no-array-sort -- fresh copy`, or raise `engines.node` to `>=20`.',
    },
    schema: [],
  },

  create(context: RuleContext) {
    const filename = context.filename ?? context.getFilename?.() ?? ''
    if (!filename) {
      return {}
    }
    const floor = floorMajorFor(filename)
    // No engines field → assumed evergreen → nothing to flag.
    if (floor === undefined) {
      return {}
    }
    return {
      CallExpression(node: AstNode) {
        const callee = node.callee
        if (
          callee.type !== 'MemberExpression' ||
          callee.computed ||
          callee.property.type !== 'Identifier'
        ) {
          return
        }
        const name = callee.property.name
        // Member methods: `x.toSorted(...)`, `x.findLast(...)`, etc.
        const member = MEMBER_METHOD_MAJORS.get(name)
        if (member !== undefined) {
          if (floor < member.major) {
            // Features whose fix string contains .sort() would be autofixed
            // back by unicorn/no-array-sort, causing oscillation. Use the
            // oscillation-aware message that names the convergent manual form.
            const messageId = OSCILLATING_FEATURES.has(name)
              ? 'belowEngineFloorOscillates'
              : 'belowEngineFloor'
            context.report({
              node,
              messageId,
              data: { name, major: String(member.major), fix: member.fix },
            })
          }
          return
        }
        // Static methods: only when the object is the exact global identifier.
        if (callee.object.type !== 'Identifier') {
          return
        }
        const objectName = callee.object.name
        // Keyed by `<object>.<name>`, so Object.groupBy and Map.groupBy are
        // two ordinary entries rather than a special case.
        const qualified = `${objectName}.${name}`
        const staticEntry = STATIC_METHOD_MAJORS.get(qualified)
        if (staticEntry !== undefined && floor < staticEntry.major) {
          context.report({
            node,
            messageId: 'belowEngineFloor',
            data: {
              name: qualified,
              major: String(staticEntry.major),
              fix: staticEntry.fix,
            },
          })
        }
      },
    }
  },
}

// Oxlint plugin contract requires default-exported rule object.
// oxlint-disable-next-line socket/no-default-export -- oxlint plugin contract
export default rule
