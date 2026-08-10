/**
 * @file Compat re-export of the old publish-shared surface — the
 *   registry-agnostic helpers (`registry-infra/shared.mts`) + the npm registry
 *   reads (`registry-infra/npm/registry.mts`) — for downstream repo-owned
 *   consumers (e.g. a skill's scripts/publish.mts) that still import
 *   `publish-shared.mts`; kept until the next cascade converges them.
 */

export * from './registry-infra/npm/registry.mts'
export * from './registry-infra/shared.mts'
