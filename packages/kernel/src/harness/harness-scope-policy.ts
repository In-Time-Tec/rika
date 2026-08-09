import { Function, Schema } from "effect"

/**
 * The model-facing scope name. It is deliberately not the store's scope string: a cell may ask for
 * `thread` but can never choose WHICH thread, because the thread identity is ambient.
 */
export const ScopeName = Schema.Literals(["thread", "workspace", "global"])
export type ScopeName = typeof ScopeName.Type

export interface ScopeIdentity {
  readonly thread: string
  readonly workspaceDigest: string
}

const segment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * `HarnessScope` allows `:` but not `/`, so a raw workspace path can never be a scope. A caller that
 * supplies an unusable segment fails here rather than producing a scope the store cannot decode.
 */
export const scopeString: {
  (identity: ScopeIdentity): (name: ScopeName) => string
  (name: ScopeName, identity: ScopeIdentity): string
} = Function.dual(2, (name: ScopeName, identity: ScopeIdentity): string => {
  if (name === "global") return "global"
  const value = name === "workspace" ? identity.workspaceDigest : identity.thread
  if (!segment.test(value)) throw new TypeError(`Harness ${name} scope segment is unusable: ${value}`)
  return `${name}:${value}`
})

/** Outer to inner. `HarnessMerge.mergeStates` overlays each later scope on the accumulated earlier ones. */
export const mergeOrder: ReadonlyArray<ScopeName> = ["global", "workspace", "thread"]

/** The scope name one stored scope string belongs to, or undefined when the string is not ours. */
export const scopeName = (scope: string): ScopeName | undefined => {
  if (scope === "global") return "global"
  if (scope.startsWith("workspace:")) return "workspace"
  if (scope.startsWith("thread:")) return "thread"
  return undefined
}
