#!/usr/bin/env node
// Claude Code Stop hook — reply-ref-link-guard.
//
// Blocks turn-end when the chat reply references a GitHub PR or issue as a
// bare `#N`. Outside GitHub's own auto-linking surfaces a bare `#N` renders
// as dead text the owner cannot click (CLAUDE.md "Status and reports":
// reference a PR or issue as a clickable Markdown link). The rewrite is
// mechanical: `[#N](https://github.com/<owner>/<repo>/pull/N)` — or
// backtick a literal that is not a reference (a shard label, an ordinal).
//
// Two-digit floor: a single digit after `#` is usually an ordinal ("the #1
// priority"), and the references this rule exists for have long since
// crossed #10. A ref already inside a markdown link (`[#123](…)`) never
// fires, and code is exempt twice over — fenced blocks and inline spans are
// both stripped before the scan.
//
// No bypass: linking or backticking the ref always satisfies the guard, so
// it can never deadlock against another Stop guard (the same argument that
// keeps anti-prose-guard's reply path bypass-free).

import { block, defineHook, runHook } from '../_shared/guard.mts'
import type { GuardCheck, GuardResult } from '../_shared/guard.mts'
import type { ToolCallPayload } from '../_shared/payload.mts'
import {
  readLastAssistantTurnText,
  stripCodeFences,
} from '../_shared/transcript.mts'
import { verdictContinuation, verdictLine } from '../_shared/verdict.mts'

// A bare `#N` of two to five digits that is NOT already link text
// (`[#123]`), NOT inside inline code (spans are stripped before scanning;
// the backtick exclusion is a second belt for unbalanced ticks), and NOT
// part of a word or longer token (`abc#12`, `v1.2#34`). A following word
// char (`#12abc`, a hex color like `#12ab34`) disqualifies the match, and
// the five-digit cap keeps an all-numeric hex color (`#112233`) out: a
// six-digit token after `#` is far more likely a color than a ref, and no
// backtracked shorter match survives the trailing-digit lookahead.
const BARE_REF_RE = /(?<![`\w[#])#(\d{2,5})(?![\w#])/g

const SNIPPET_RADIUS = 28

export interface BareRefHit {
  ref: string
  snippet: string
}

/**
 * Remove inline code spans so a quoted `#123` never fires.
 */
export function stripInlineCode(text: string): string {
  return text.replace(/`[^`\n]*`/g, '')
}

export function findBareRefHits(text: string): BareRefHit[] {
  const hits: BareRefHit[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null = BARE_REF_RE.exec(text)
  while (match) {
    const ref = `#${match[1]!}`
    if (!seen.has(ref)) {
      seen.add(ref)
      const start = Math.max(0, match.index - SNIPPET_RADIUS)
      const end = Math.min(
        text.length,
        match.index + ref.length + SNIPPET_RADIUS,
      )
      hits.push({
        ref,
        snippet: text.slice(start, end).replaceAll('\n', ' '),
      })
    }
    match = BARE_REF_RE.exec(text)
  }
  return hits
}

export function findReplyRefVerdict(payload: ToolCallPayload): GuardResult {
  const rawText = readLastAssistantTurnText(payload.transcript_path)
  if (!rawText) {
    return undefined
  }
  const hits = findBareRefHits(stripInlineCode(stripCodeFences(rawText)))
  if (!hits.length) {
    return undefined
  }
  const lines: string[] = []
  for (let i = 0, { length } = hits; i < length; i += 1) {
    const hit = hits[i]!
    const body = `link "${hit.ref}" as [${hit.ref}](https://github.com/<owner>/<repo>/pull/${hit.ref.slice(1)}) or backtick a literal — …${hit.snippet}…`
    lines.push(
      i === 0
        ? verdictLine('block', 'reply-ref-link-guard', body)
        : verdictContinuation(body),
    )
  }
  // Like anti-prose-guard's reply path, this ignores `stop_hook_active` so
  // the verdict survives another guard's retry: a reply rewritten for a
  // different guard can introduce a fresh bare ref.
  return block(lines.join('\n'))
}

// Stop payloads carry no `tool_name`; nothing else should reach this hook,
// but a tool payload returning undefined keeps a miswired entry harmless.
export const check: GuardCheck = payload =>
  payload?.tool_name === undefined ? findReplyRefVerdict(payload) : undefined

export const hook = defineHook({
  check,
  event: 'Stop',
  // MACHINE-WIDE, same reasoning as anti-prose-guard: the reply surface has
  // no repo, and a dead `#N` is just as unclickable answering from a foreign
  // checkout.
  global: true,
  type: 'guard',
})

void runHook(hook, import.meta.url)
