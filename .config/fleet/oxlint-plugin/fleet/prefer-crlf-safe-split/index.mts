/*
 * @file Per fleet doctrine (the line-ending cousin of
 *   `normalize-path-before-match`): text that came from a file, a spawn, or
 *   the network can carry CRLF line endings, and `.split('\n')` leaves a
 *   trailing `\r` on every line on Windows — the classic source of
 *   phantom-mismatch bugs in parsers, whoami probes, and log scans. Flags a
 *   `.split()` whose separator is the string literal `'\n'` and autofixes it
 *   to the CRLF-safe regex form `.split(/\r?\n/)`.
 *   What this does NOT touch: splits on any other separator, regex splits
 *   (already explicit), and joins — `join('\n')` composes output and owns
 *   its endings. A split that genuinely must preserve `\r` (a byte-exact
 *   round-trip, a fixture asserting CR content) takes the escape hatch:
 *   `// oxlint-disable-next-line socket/prefer-crlf-safe-split`.
 */

import { makeBypassChecker } from '../../lib/comment-markers.mts'
import { isPluginSelfFile } from '../../lib/fleet-paths.mts'
import type { AstNode, RuleContext, RuleFixer } from '../../lib/rule-types.mts'

const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        "Split lines with the CRLF-safe `/\\r?\\n/` instead of the literal `'\\n'` — a `\\n`-only split strands a trailing `\\r` on every line on Windows.",
      category: 'Possible Errors',
      recommended: true,
    },
    fixable: 'code',
    messages: {
      lfOnlySplit:
        "`.split('\\n')` strands a trailing `\\r` on every line when the text carries CRLF endings — split with `/\\r?\\n/` instead. For a byte-exact split that must preserve `\\r`, add `// oxlint-disable-next-line socket/prefer-crlf-safe-split`.",
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
      'socket/prefer-crlf-safe-split',
    )

    return {
      CallExpression(node: AstNode) {
        const call = node as {
          arguments?: AstNode[] | undefined
          callee?:
            | {
                computed?: boolean | undefined
                property?: { name?: string | undefined } | undefined
                type?: string | undefined
              }
            | undefined
        }
        const callee = call.callee
        if (
          callee?.type !== 'MemberExpression' ||
          callee.computed ||
          callee.property?.name !== 'split'
        ) {
          return
        }
        const sep = call.arguments?.[0]
        if (!sep || sep.type !== 'Literal') {
          return
        }
        const value = (sep as { value?: unknown | undefined }).value
        if (value !== '\n') {
          return
        }
        if (hasBypassComment(node)) {
          return
        }
        context.report({
          node: sep,
          messageId: 'lfOnlySplit',
          fix(fixer: RuleFixer) {
            return fixer.replaceText(sep, '/\\r?\\n/')
          },
        })
      },
    }
  },
}

export default rule
