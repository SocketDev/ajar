/*
 * @file Writing a fix to the SOURCE, never to a cascaded mirror.
 *
 *   A cascaded file exists twice: the canonical copy under `template/base/`,
 *   and the live mirror the cascade wrote. `mirror-mode` chmods the mirror
 *   read-only precisely so a stray write fails instead of forking the file,
 *   which means a `--fix` that walks scanned paths will hit an EACCES on every
 *   mirror it tries to repair.
 *
 *   There are two wrong ways to handle that and one right one. Letting the
 *   write throw kills the run partway, leaving the earlier files fixed and the
 *   rest not. Swallowing the error silently reports success while the finding
 *   survives, so the check stays red with no explanation. The right handling is
 *   to skip the mirror, keep going, and say so at the end, naming the files so
 *   the operator knows the remaining work is a template edit plus a cascade.
 *
 *   That handling was written once, inline, in the em-dash fixer. This module
 *   is that logic extracted so the other fixers get it by construction rather
 *   than by each author remembering. See the `fix-at-the-source` rule.
 */

import { writeFileSync } from 'node:fs'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

/**
 * Write `content` to `absolutePath`, treating an unwritable target as a
 * cascaded mirror to skip rather than an error to throw.
 *
 * Returns true when the write landed. A false return is the mirror case and
 * the caller should record `relativePath` for {@link reportSkippedMirrors}.
 */
export function writeUnlessMirrored(
  absolutePath: string,
  content: string,
): boolean {
  try {
    writeFileSync(absolutePath, content, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Report the mirrors a `--fix` pass could not write, and what to do about it.
 *
 * Silence here is the failure this exists to prevent: the check stays red, the
 * fixer claimed success, and nothing connects the two. Emitted as a warning so
 * it survives a quiet run, and it names every file, because "3 files skipped"
 * without the names leaves the operator grepping.
 */
export function reportSkippedMirrors(
  checkName: string,
  skipped: readonly string[],
): void {
  if (!skipped.length) {
    return
  }
  const logger = getDefaultLogger()
  logger.warn(
    `[${checkName}] --fix skipped ${skipped.length} read-only mirror(s). Fix these under template/base/ and cascade:`,
  )
  for (let i = 0, { length } = skipped; i < length; i += 1) {
    logger.warn(`  ${skipped[i]!}`)
  }
}
