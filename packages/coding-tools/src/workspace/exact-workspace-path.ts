import { Effect, Function, PlatformError } from "effect"
import type { ExactLookup, Options } from "./local-path-contract"
import { LocalPathError } from "./local-path-error"

/**
 * A path is resolved relative to the workspace and then walked segment by segment so the casing a
 * caller wrote is the casing that exists on disk. The walk starts at the deepest ancestor the
 * resolved path shares with the workspace, because a path outside the workspace has no relative
 * form from it and would otherwise be rejected rather than checked.
 *
 * Reachability is deliberately not decided here. The kernel runs with the Server user's authority,
 * and the shell it exposes can already reach any path this resolver could refuse, so refusing here
 * only pushed agents onto the unaudited shell path for the same work. `local-safety-policy` remains
 * the one gate that refuses a destructive invocation.
 */
const walkFrom = (
  options: Options,
  absolute: string,
): { readonly start: string; readonly segments: ReadonlyArray<string> } => {
  const root = options.path.resolve(options.base)
  const relative = options.path.relative(root, absolute)
  const escapes = relative.length === 0 ? false : relative.startsWith("..") || options.path.isAbsolute(relative)
  if (!escapes)
    return { start: root, segments: relative.split(options.path.sep).filter((segment) => segment.length > 0) }
  const parts = absolute.split(options.path.sep).filter((segment) => segment.length > 0)
  return { start: options.path.sep, segments: parts }
}

export const resolveExactWorkspacePath: {
  (
    input: string,
    options: Options,
  ): (lookup: ExactLookup) => Effect.Effect<string, LocalPathError | PlatformError.PlatformError>
  (
    lookup: ExactLookup,
    input: string,
    options: Options,
  ): Effect.Effect<string, LocalPathError | PlatformError.PlatformError>
} = Function.dual(3, (lookup: ExactLookup, input: string, options: Options) =>
  Effect.gen(function* () {
    const absolute = options.path.resolve(options.base, input)
    const { start, segments } = walkFrom(options, absolute)
    let current = start
    for (const segment of segments) {
      const names = yield* lookup.readDirectory(current)
      if (!names.includes(segment))
        return yield* LocalPathError.make({ path: input, reason: "not_found", candidates: [] })
      current = options.path.join(current, segment)
    }
    return current
  }),
)
