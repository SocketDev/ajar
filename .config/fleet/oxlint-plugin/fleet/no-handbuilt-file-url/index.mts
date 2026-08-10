/*
 * @file Per fleet doctrine (the entry-guard cousin of
 *   `prefer-crlf-safe-split`): a hand-built `file://` URL from a filesystem
 *   path never matches `import.meta.url` on Windows — `process.argv[1]` is a
 *   backslashed drive-letter path while `import.meta.url` is
 *   `file:///D:/...`, so ``import.meta.url === `file://${process.argv[1]}` ``
 *   is always false there and the CLI entry silently no-ops with exit 0.
 *   Flags a template literal or string concatenation that builds a URL from
 *   a `file://` prefix plus an interpolated path. The fix is
 *   `pathToFileURL(thePath).href` from `node:url`, which encodes the
 *   platform differences (backslashes, drive letters, percent-encoding).
 *   What this does NOT touch: a constant `file://...` literal with no
 *   interpolation (a fixture or a doc string is data, not a path
 *   conversion). A genuinely intentional hand-built URL takes the escape
 *   hatch: `// oxlint-disable-next-line socket/no-handbuilt-file-url`.
 */

import { makeBypassChecker } from '../../lib/comment-markers.mts'
import { isPluginSelfFile } from '../../lib/fleet-paths.mts'
import type { AstNode, RuleContext, RuleFixer } from '../../lib/rule-types.mts'

const FILE_URL_PREFIX = 'file://'

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Build file URLs with `pathToFileURL(...).href`, never a hand-built `file://` prefix — the string form never matches `import.meta.url` on Windows, so an entry guard built with it silently no-ops.',
      category: 'Possible Errors',
      recommended: true,
    },
    fixable: 'code',
    messages: {
      handbuiltFileUrl:
        'A hand-built `file://` URL never matches `import.meta.url` on Windows (backslashed drive-letter paths, percent-encoding) — use `pathToFileURL(<path>).href` from `node:url` instead. For a URL that is genuinely data, add `// oxlint-disable-next-line socket/no-handbuilt-file-url`.',
    },
    schema: [],
  },

  create(context: RuleContext) {
    // This rule's own source + fixtures carry the pattern as data.
    if (isPluginSelfFile(context)) {
      return {}
    }

    const hasBypassComment = makeBypassChecker(
      context,
      'socket/no-handbuilt-file-url',
    )

    return {
      TemplateLiteral(node: AstNode) {
        const tpl = node as {
          expressions?: AstNode[] | undefined
          quasis?:
            | Array<{
                value?: { cooked?: string | undefined } | undefined
              }>
            | undefined
        }
        const expressions = tpl.expressions
        if (!expressions || expressions.length === 0) {
          return
        }
        const head = tpl.quasis?.[0]?.value?.cooked
        if (typeof head !== 'string' || !head.startsWith(FILE_URL_PREFIX)) {
          return
        }
        if (hasBypassComment(node)) {
          return
        }
        // Fix only the exact one-interpolation shape `file://${X}` — anything
        // richer (extra prefix bytes, several expressions) needs a human to
        // decide what the path expression is.
        const soleExpression =
          expressions.length === 1 &&
          head === FILE_URL_PREFIX &&
          tpl.quasis?.length === 2 &&
          tpl.quasis[1]?.value?.cooked === ''
            ? expressions[0]
            : undefined
        const range = (soleExpression as { range?: number[] | undefined })
          ?.range
        const sourceText = (
          context as {
            sourceCode?: { text?: string | undefined } | undefined
          }
        ).sourceCode?.text
        context.report({
          node,
          messageId: 'handbuiltFileUrl',
          ...(soleExpression && range && typeof sourceText === 'string'
            ? {
                fix(fixer: RuleFixer) {
                  const pathExpr = sourceText.slice(range[0], range[1])
                  return fixer.replaceText(
                    node,
                    `pathToFileURL(${pathExpr}).href`,
                  )
                },
              }
            : {}),
        })
      },
      BinaryExpression(node: AstNode) {
        const bin = node as {
          left?: AstNode | undefined
          operator?: string | undefined
          right?: AstNode | undefined
        }
        if (bin.operator !== '+') {
          return
        }
        const left = bin.left as
          | { type?: string | undefined; value?: unknown | undefined }
          | undefined
        if (
          left?.type !== 'Literal' ||
          typeof left.value !== 'string' ||
          !left.value.startsWith(FILE_URL_PREFIX)
        ) {
          return
        }
        if (hasBypassComment(node)) {
          return
        }
        context.report({
          node,
          messageId: 'handbuiltFileUrl',
        })
      },
    }
  },
}

export default rule
