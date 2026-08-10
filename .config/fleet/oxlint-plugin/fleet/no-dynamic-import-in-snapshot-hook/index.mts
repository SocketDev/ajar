/*
 * @file A hook frozen into the V8 dispatch snapshot must not reach for a
 *   dynamic `import()`.
 *
 *   A snapshot-booted process registers NO dynamic-import callback, so any
 *   `import()` inside it throws `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`. The
 *   blob still BUILDS — nothing fails until the hook actually runs, and
 *   `dispatch()` catches a throwing hook so one cannot wedge the dispatcher.
 *   The result is a guard that works under `node index.cjs`, which is what a
 *   developer runs by hand, and is inert under the snapshot, which is the path
 *   settings.json invokes. Nothing anywhere says so.
 *
 *   `headroom-proxy-start` sat in exactly that state. Its
 *   `await import('node:http')` had been added to make the hook
 *   snapshot-ELIGIBLE, and it did let the blob build while breaking the hook
 *   at runtime — the fix and the bug were the same line.
 *
 *   Two ways to clear a finding, and which one is right depends on WHY the
 *   import is there:
 *
 *   - A node builtin: `process.getBuiltinModule('node:x')`. Synchronous, needs
 *     no callback, and still defers a native module's bind past snapshot
 *     build, which is the property the lazy import was reaching for. Prefer
 *     this — the hook stays frozen and keeps the startup win.
 *   - A real package, or a path resolved at runtime: the hook cannot be
 *     snapshot-safe. Put `@dispatch-snapshot-exclude` in its header. The maker
 *     moves it to `excluded-fleet-pack.cjs`, spliced in at runtime where
 *     `import()` works normally. It still runs; it just gives up the frozen
 *     heap.
 *
 *   Scope: files under a `.claude/hooks/` tree. A file carrying the exclude
 *   marker is skipped, so a helper inside an excluded hook carries the marker
 *   too, which keeps the reason next to the code rather than one directory up.
 */

import { makeBypassChecker } from '../../lib/comment-markers.mts'
import { isPluginSelfFile } from '../../lib/fleet-paths.mts'
import type { AstNode, RuleContext } from '../../lib/rule-types.mts'

// The header marker that moves a hook out of the snapshot and into the
// runtime-spliced bundle. Read from the file under lint, never a sibling: a
// helper that needs the escape states it itself.
const EXCLUDE_MARKER = '@dispatch-snapshot-exclude'

// Only a `.claude/hooks/` tree is snapshot-bundled. A script, a test, or a
// package source may import() freely.
const HOOK_PATH_RE = /[\\/]\.claude[\\/]hooks[\\/]/

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A hook frozen into the V8 dispatch snapshot must not use a dynamic import(): a snapshot-booted process has no dynamic-import callback, so the call throws at runtime and the dispatcher swallows it.',
      category: 'Possible Errors',
      recommended: true,
    },
    // Deliberately NOT fixable. The right repair depends on WHAT is being
    // imported — getBuiltinModule for a builtin, a header marker for anything
    // else — and picking wrong either breaks the build or silently drops the
    // hook out of the snapshot. Both are author calls.
    messages: {
      dynamicImportInSnapshotHook:
        "A snapshot-booted process registers no dynamic-import callback, so this `import()` throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING at runtime and `dispatch()` swallows it — the hook goes inert with no signal. For a node builtin use `process.getBuiltinModule('node:x')`, which needs no callback and still defers the native bind past snapshot build. Otherwise mark the hook `@dispatch-snapshot-exclude` in its header so it is spliced in at runtime instead.",
    },
    schema: [],
  },

  create(context: RuleContext) {
    // This rule's own source carries the pattern as prose and fixtures.
    if (isPluginSelfFile(context)) {
      return {}
    }
    const filename = context.filename ?? context.getFilename?.() ?? ''
    if (!HOOK_PATH_RE.test(filename)) {
      return {}
    }
    const sourceCode = context.getSourceCode
      ? context.getSourceCode()
      : context.sourceCode
    const text = (sourceCode as { text?: string | undefined })?.text ?? ''
    // An excluded hook is spliced in at runtime, where import() is fine.
    if (text.includes(EXCLUDE_MARKER)) {
      return {}
    }
    const hasBypassComment = makeBypassChecker(
      context,
      'socket/no-dynamic-import-in-snapshot-hook',
    )
    return {
      ImportExpression(node: AstNode) {
        if (hasBypassComment(node)) {
          return
        }
        context.report({
          node,
          messageId: 'dynamicImportInSnapshotHook',
        })
      },
    }
  },
}

// The oxlint plugin contract requires a default-exported rule object.
// oxlint-disable-next-line socket/no-default-export -- plugin contract
export default rule
