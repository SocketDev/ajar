/*
 * @file Capabilities block of the socket-wheelhouse config: the top-level
 *   declaration of which languages beyond JS/TS a repo ships, and where that
 *   code lives. Declaring a capability is the switch that turns on the matching
 *   coverage lane in `pnpm run cover`, folds that lane into the README badge,
 *   and arms the check that a declared lane actually measures something.
 *   This schema and `VALID_CAPABILITIES` in
 *   scripts/repo/sync-scaffolding/repo-shape.mts name the SAME vocabulary and
 *   must match exactly — `capability-vocabulary.test.mts` asserts it, because
 *   a comment asking two lists to agree is what let `swift` land in one and
 *   not the other, and the drift only surfaced when a member declaring it
 *   failed schema validation.
 *   `LANE_BY_CAPABILITY` in scripts/fleet/cover/lanes.mts is a SUBSET, not a
 *   third copy: it holds the capabilities that own a coverage lane. A
 *   capability can be real without one — `swift` gates capability-tagged hooks
 *   and the fmt:swift / lint:swift scripts while having no lane to run.
 */

import { Type } from 'typebox'

export const CapabilitiesSchema = Type.Object(
  {
    cargo: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'This repo ships Rust; the value is the repo-relative paths of the package roots holding it (`["."]` when the Cargo workspace sits at the repo root). Declaring `cargo` activates the `rust` coverage lane in `pnpm run cover`, folds its line coverage into the README badge, and arms the coverage-lanes-are-wired check: a declared capability whose lane measures nothing fails the gate instead of passing silently, while a machine with no cargo toolchain reports an explicit skip. `cargo` also gates capability-tagged fleet hooks at cascade time — an artifact whose header declares `@socket-capability cargo` is installed only into a repo that declares this key (scripts/repo/sync-scaffolding/capabilities.mts).',
      }),
    ),
    cpp: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'This repo ships C/C++; the value is the repo-relative paths of the package roots holding it. Declaring `cpp` activates the `cpp` coverage lane in `pnpm run cover`, folds its line coverage into the README badge, and arms the coverage-lanes-are-wired check: a declared capability whose lane measures nothing fails the gate instead of passing silently, while a machine with no C/C++ toolchain reports an explicit skip.',
      }),
    ),
    go: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'This repo ships Go; the value is the repo-relative paths of the package roots holding it. Declaring `go` activates the `go` coverage lane in `pnpm run cover`, folds its line coverage into the README badge, and arms the coverage-lanes-are-wired check: a declared capability whose lane measures nothing fails the gate instead of passing silently, while a machine with no Go toolchain reports an explicit skip.',
      }),
    ),
    swift: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'This repo ships Swift; the value is the repo-relative paths of the package roots holding it (an Xcode project directory, or a SwiftPM package root). Declaring `swift` activates the `swift` coverage lane in `pnpm run cover`, folds its line coverage into the README badge, and arms the coverage-lanes-are-wired check: a declared capability whose lane measures nothing fails the gate instead of passing silently, while a machine with no Swift toolchain reports an explicit skip. The common shape is a hybrid member whose logic is Rust and whose macOS shell is SwiftUI, so `swift` usually appears beside `cargo` rather than alone.',
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      'Language capabilities beyond JS/TS. Keys must stay in lockstep with VALID_CAPABILITIES in scripts/repo/sync-scaffolding/repo-shape.mts and LANE_BY_CAPABILITY in scripts/fleet/cover/lanes.mts.',
  },
)
