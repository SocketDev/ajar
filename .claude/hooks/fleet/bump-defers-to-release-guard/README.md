# bump-defers-to-release-guard

PreToolUse hook covering two things the release script owns: the version and
the CHANGELOG. The version is the user's decision, derived bumps are patch or
minor with patch the default, and MAJOR is never derived.

The two have separate exits because they are separate mistakes. Being told to
name a release target when you were fixing a typo in a changelog sends you
somewhere unrelated, and a guard that misdescribes what you did is one people
learn to bypass on reflex.

## What it blocks

**Version bumps**

- `node <path>/bump.mts` without `--dry-run` (a write run).
- `npm|pnpm|yarn version <arg>` - a bare `npm version` only prints and passes.
- A manual edit to `package.json`'s `version` field.

**CHANGELOG writes**

- Any hand-edit to `CHANGELOG.md`. Not only one containing a release heading:
  the file is generated end to end, so a hand-write is either overwritten by
  the next run or survives as drift the generator did not make. Matching on the
  heading alone also mis-fired on edits that merely sat next to one.

## What it allows

- `bump.mts --dry-run` - the evidence-gathering step is always open.
- A `X.Y.Z-prerelease` version hint. That is the sanctioned way to name the
  release TARGET without bumping, and the release tooling consumes it.
- Any run after the user types `Allow release-bump bypass`. A major run
  (`--release-as major|premajor`, `npm version major`) additionally requires
  `Allow major-bump bypass`.
- A CHANGELOG edit after the user types `Allow changelog-edit bypass`, which
  is the escape for a deliberate consolidation or cleanup.

## changelog.d

Repos using the news-fragment convention keep one file per change under
`changelog.d/`, assembled at release. Where that directory exists the block
message points there, since it is the sanctioned place to write.

Detected, never required. The fleet does not mandate the convention, and a repo
without the directory gets a message pointing at the release script instead. As
of writing, perry is the only fleet repo using it.

The convention exists because a single CHANGELOG is a merge-conflict magnet:
every PR edits the same top section, so two open PRs collide the moment either
lands. Two fragments are two filenames and cannot conflict.

## The release pipeline is never blocked

Worth stating plainly, because it looks like it should be and is not:

- **Workflows.** Hooks are a Claude Code feature and CI runs plain `node` /
  `pnpm` with no agent, so no PreToolUse hook fires there. That is why there is
  no CI check in the runner: none is needed.
- **Release and publish scripts.** The guard inspects tool calls, not
  filesystem writes. When `bump.mts` writes CHANGELOG.md through `writeFileSync`
  that happens inside the process, invisible to a hook, so a script editing the
  file and committing it is not blocked.
- **The sibling check agrees.** `changelog-is-commit-derived` regenerates the
  pending entry with bump.mts's own `deriveReleaseCommits` and asserts the
  derived bullets are present. It is built around the generator owning the file.

The one thing that still needs a phrase is an AGENT running `bump.mts` as a
write run, which is the pre-existing version-bump path, not this one. The
version stays the user's decision.

## CI

The hook never runs in CI. There, major happens only when a human manually
selects it on the release workflow's dispatch form; `bump.mts` itself refuses
to derive major from commit types.
