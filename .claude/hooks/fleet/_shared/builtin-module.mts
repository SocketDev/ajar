/*
 * @file Load a node builtin in a way that survives the V8 hook snapshot.
 *
 *   Three constraints meet here, and only one call shape satisfies all three:
 *
 *   1. Loading a native-handle module (`node:http` binds HTTPParser) at MODULE
 *      EVAL makes the snapshot build fail outright — V8 refuses to serialize
 *      those Foreign handles. So the load has to be deferred into a function.
 *   2. `await import()` defers it, but a snapshot-booted process registers no
 *      dynamic-import callback, so the call throws
 *      ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING at RUNTIME. The blob still
 *      builds, and `dispatch()` swallows the throw, so the hook goes inert
 *      with no signal. That is the failure this module exists to prevent.
 *   3. `process.getBuiltinModule` solves both, but only from Node 22.3. The
 *      hook bundles are polyfilled down to Node 18 (`es-polyfills.mts`), so on
 *      an older runtime it is undefined and the call is a TypeError — the same
 *      silent-inert outcome, reached a different way.
 *
 *   So: prefer `getBuiltinModule`, fall back to a `createRequire` require.
 *   `node:module` is a plain JS module with no native handles, so importing it
 *   at module eval is snapshot-clean, and `require` needs no dynamic-import
 *   callback.
 */

import module from 'node:module'
import process from 'node:process'

const requireBuiltin = module.createRequire(import.meta.url)

/**
 * The node builtin named by `specifier` (always a `node:` prefixed name),
 * loaded lazily and snapshot-safely. Call this INSIDE the function that needs
 * the module, never at module scope, or constraint 1 above bites.
 */
export function getBuiltin<T = unknown>(specifier: string): T {
  const get = process.getBuiltinModule as
    | ((name: string) => unknown)
    | undefined
  return (get ? get(specifier) : requireBuiltin(specifier)) as T
}
