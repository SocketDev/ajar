# Report in ASD-STE100 Simplified Technical English

Write every report to the operator in ASD-STE100 style. STE is the aerospace
standard for controlled technical English. The fleet adopts its writing rules
(Part 1 of the specification). The fleet keeps its own technical vocabulary:
git, npm, cascade, and tool names are Technical Names under STE section 1.

## The rules, with spec references

- One word has one meaning. Do not use a synonym for variety. (STE §1.1)
- Use a verb as a verb only. Write "we made a check", not "we checked
  it out". (STE §1.2)
- Keep a noun cluster to three nouns or fewer. Break a longer cluster with
  "of" or a hyphen. (STE §2.1)
- Use the active voice. Name the actor. (STE §3.5)
- Use simple tenses: past, present, future. Do not stack auxiliaries.
  (STE §3.2)
- One topic per sentence. Maximum 20 words in an instruction. Maximum 25
  words in a description. (STE §4, §5.1)
- One instruction per sentence, in the imperative. "Run the check. Read the
  result." (STE §5.2)
- One topic per paragraph. Maximum six sentences. The first sentence states
  the topic. (STE §6.1, §6.2)
- Put a warning before the action it protects, never after. (STE §7)

## The ADHD mapping

The operator guidance (ayghri/i-have-adhd) maps onto the same rules:

- Lead with the outcome. Delete a first sentence that announces intent.
- Number multi-step work. One bounded action per step.
- Cap a list at five items. Split longer lists into priority tiers.
- Give time in concrete units. "Two minutes", never "shortly".
- Use literal language. No idioms, no figurative phrases.
- State an error as cause and fix. No apology, no hedge.
- End with one concrete next action, or with nothing.
- Do not ask the reader to "keep in mind" anything. Working memory is
  small. Put the fact where the reader needs it.

## How this composes with the prose doctrine

The prose skill's banned patterns (throat-clearers, hedge-stacking, filler)
are STE violations too, so the two systems agree. Where they differ, STE is
stricter: it also caps sentence length, bans synonym variation, and demands
one instruction per sentence. Apply both. The `<details>` fold convention
stays: the verdict outside the fold, the depth inside, each written in STE.

Supporting copy is opt-in, never default. Do not add a subtitle, helper
text, or descriptive copy under a heading or label. One concise,
self-explanatory heading carries it. Add supporting copy only to prevent a
misunderstanding or an error. Never restate the heading. This is the prose
twin of `socket/no-parenthetical-aside`: an aside and a helper line are the
same reflex, explaining a thing that should explain itself.
