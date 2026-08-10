# Fix at the source, not the mirror

A cascaded file exists twice: the canonical copy under `template/base/`, and
the live mirror the cascade wrote. **Every fix goes to the source.** The mirror
is an output, and editing an output is how a file forks.

## The rule

- **Edit `template/base/`, then cascade.** The live copy under `.claude/`,
  `docs/`, `.github/`, or `scripts/fleet/` is generated. A change made there is
  overwritten by the next cascade, or survives as drift the cascade did not
  make. Neither is a fix.
- **The mirror is chmod'd read-only on purpose.** `mirror-mode` marks cascaded
  files unwritable so a stray `cp`, a redirect, or a fixer's `writeFileSync`
  fails loudly instead of forking the file. Treat an `EACCES` on a cascaded
  path as the system working, not as an obstacle to route around. Never
  `chmod +w` a mirror to land an edit.
- **A `--fix` that meets a mirror skips it and says so.** Three behaviors, only
  one correct: throwing kills the run partway and leaves the tree half-fixed;
  swallowing the error reports success while the finding survives, so the check
  stays red with nothing explaining why; skipping loudly is right. Use
  `_shared/cascaded-mirrors.mts` rather than re-deriving it, and name the files
  so the reader knows the remaining work is a template edit plus a cascade.
- **A wheelhouse-only file still has a canonical source.** Not every canonical
  file lives in `template/base/`. A file scoped to one member lives under
  `template/overrides/<member>/`, which is canonical but not cascaded to
  everyone. "It is not in `template/base/`" does not make the live copy
  editable.
- **A skipped mirror means the job is not done.** The fixer stopping cleanly is
  not the finish line. The finding is still there until the template source is
  fixed and the cascade has run.

## Enforcement

- `no-fleet-fork-guard` (PreToolUse) blocks Edit/Write/MultiEdit and Bash
  writes (`cp`, `mv`, `tee`, `>` redirects) that target a fleet-canonical path,
  and names the `template/` path to edit instead. Bypass phrase in its README.
- `mirror-mode` (`sync-scaffolding/fixers/mirror-mode.mts`) chmods cascaded
  mirrors read-only, so the filesystem enforces this even where no hook runs.
- `_shared/cascaded-mirrors.mts` gives fixers `writeUnlessMirrored` and
  `reportSkippedMirrors`, so the skip-loudly behavior is inherited rather than
  reimplemented per fixer.

## Why

The em-dash fixer met this and handled it correctly: it skipped 6 read-only
files, wrote the `template/base/` sources, and named what it skipped. That
behavior was inline in one fixer, so the other twenty-two had nothing to
inherit and would each have had to rediscover it, most likely by shipping one
of the two wrong versions first.

The failure mode this prevents is quiet. A fixer that swallows the write error
prints a success line, the check stays red on the next run, and the two facts
sit far enough apart that the natural next step is to edit the mirror by hand,
which forks the file and blocks every future fleet-wide change to it.
