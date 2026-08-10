/*
 * @file The fleet logger's semantic methods (`success`, `fail`, `warn`,
 *   `info`, `done`, `skip`) already prefix their own status glyph — a
 *   hand-written `✔` / `✖` in the message doubles the mark on those methods
 *   and hand-fakes the semantic on the generic ones. The message states the
 *   fact; the METHOD states the verdict. Flags any `logger.<method>(...)`
 *   whose first string argument opens with a status glyph (✔ ✓ √ ✖ ✗ × ⚠).
 *   Autofix strips the glyph run, and on a generic method (`log`, `info`,
 *   `error`, `warn`) whose glyph names a verdict it also renames the call to
 *   the matching semantic method: `logger.error('✖ …')` becomes
 *   `logger.fail('…')`, `logger.info('✔ …')` becomes `logger.success('…')`.
 *   Escape hatch for a glyph that is genuinely data (a table row, a diff
 *   sample): `// oxlint-disable-next-line socket/no-logger-glyph-prefix`.
 */

import { makeBypassChecker } from '../../lib/comment-markers.mts'
import { isPluginSelfFile } from '../../lib/fleet-paths.mts'
import type { AstNode, RuleContext, RuleFixer } from '../../lib/rule-types.mts'

// The glyphs the logger owns, with the semantic method each one implies.
// `⚠` maps to warn; the check/cross families map to success/fail.
const GLYPH_METHOD: ReadonlyMap<string, string> = new Map([
  ['✔', 'success'],
  ['✓', 'success'],
  ['√', 'success'],
  ['✖', 'fail'],
  ['✗', 'fail'],
  ['×', 'fail'],
  ['⚠', 'warn'],
])

// A leading status-glyph run in a message: optional whitespace, one owned
// glyph, optional variation selector, then at least one space or the end.
const LEADING_GLYPH_RE = /^(\s*)([✔✓√✖✗×⚠])(️?)(\s+|$)/u

// Logger methods whose messages this rule polices. The semantic set doubles
// the glyph; the generic set hand-fakes a verdict the semantic set states.
const LOGGER_METHODS: ReadonlySet<string> = new Set([
  'done',
  'error',
  'fail',
  'info',
  'log',
  'skip',
  'step',
  'success',
  'warn',
])

// Generic methods the fixer may RENAME to the glyph's semantic method.
const RENAMABLE: ReadonlySet<string> = new Set(['error', 'info', 'log'])

const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'The logger method owns the status glyph — never hand-prefix ✔/✖/⚠ in the message; use logger.success/fail/warn and plain text.',
      category: 'Stylistic Issues',
      recommended: true,
    },
    fixable: 'code',
    messages: {
      glyphPrefix:
        'The message opens with `{{glyph}}`, but the logger method owns the status glyph — `logger.{{wanted}}()` prints it for you. Drop the glyph and let the method carry the verdict. For a glyph that is genuinely data, add `// oxlint-disable-next-line socket/no-logger-glyph-prefix`.',
    },
    schema: [],
  },

  create(context: RuleContext) {
    // This rule's own source + fixtures carry the glyphs as data.
    if (isPluginSelfFile(context)) {
      return {}
    }

    const hasBypassComment = makeBypassChecker(
      context,
      'socket/no-logger-glyph-prefix',
    )
    const sourceCode = context.getSourceCode
      ? context.getSourceCode()
      : context.sourceCode

    return {
      CallExpression(node: AstNode) {
        const call = node as {
          arguments?: AstNode[] | undefined
          callee?:
            | {
                object?: { name?: string | undefined } | undefined
                property?: { name?: string | undefined } | undefined
                type?: string | undefined
              }
            | undefined
        }
        const callee = call.callee
        if (
          callee?.type !== 'MemberExpression' ||
          callee.object?.name !== 'logger'
        ) {
          return
        }
        const method = callee.property?.name
        if (!method || !LOGGER_METHODS.has(method)) {
          return
        }
        const first = call.arguments?.[0]
        if (!first) {
          return
        }
        // The message text: a plain string literal, or the FIRST quasi of a
        // template literal — a glyph prefix always sits before the first
        // interpolation.
        let text: string | undefined
        if (first.type === 'Literal') {
          const v = (first as { value?: unknown | undefined }).value
          if (typeof v === 'string') {
            text = v
          }
        } else if (first.type === 'TemplateLiteral') {
          const quasi = (
            first as {
              quasis?:
                | Array<{ value?: { cooked?: string | undefined } | undefined }>
                | undefined
            }
          ).quasis?.[0]
          text = quasi?.value?.cooked
        }
        if (typeof text !== 'string') {
          return
        }
        const m = LEADING_GLYPH_RE.exec(text)
        if (!m) {
          return
        }
        if (hasBypassComment(node)) {
          return
        }
        const glyph = m[2]!
        const semantic = GLYPH_METHOD.get(glyph)
        const wanted = semantic && RENAMABLE.has(method) ? semantic : method
        context.report({
          node,
          messageId: 'glyphPrefix',
          data: { glyph, wanted },
          fix(fixer: RuleFixer) {
            const raw = sourceCode.getText(node) as string
            // Strip the first glyph run from the call's source text (it sits
            // inside the first string/template argument), then rename a
            // generic method when the glyph names its semantic twin.
            let fixed = raw.replace(LEADING_GLYPH_RE_SOURCE, '$1')
            if (semantic && RENAMABLE.has(method)) {
              fixed = fixed.replace(
                new RegExp(`^logger\\.${method}\\b`),
                () => `logger.${semantic}`,
              )
            }
            return fixer.replaceText(node, fixed)
          },
        })
      },
    }
  },
}

// The source-text twin of LEADING_GLYPH_RE: the glyph run as it appears just
// after the opening quote/backtick in the call's raw text. `$1` keeps the
// quote; the glyph, its variation selector, and the following spaces go.
const LEADING_GLYPH_RE_SOURCE = /(["'`]\s*)[✔✓√✖✗×⚠]️?\s*/u

export default rule
