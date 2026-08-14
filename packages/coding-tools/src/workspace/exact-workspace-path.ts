import { Effect, Function, Path, PlatformError } from "effect"
import type { ExactLookup, Options } from "./local-path-contract"
import { LocalPathError } from "./local-path-error"

const contained = (root: string, candidate: string, path: Path.Path) => {
  if (root === candidate) return true
  const relative = path.relative(root, candidate)
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
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
    const lexicalRoot = options.path.resolve(options.base)
    const root = yield* lookup.realPath(lexicalRoot)
    const absolute = options.path.resolve(options.base, input)
    if (!contained(lexicalRoot, absolute, options.path))
      return yield* LocalPathError.make({ path: input, reason: "outside_workspace", candidates: [] })
    const relative = options.path.relative(lexicalRoot, absolute)
    const segments = relative.split(options.path.sep).filter((segment) => segment.length > 0)
    let current = lexicalRoot
    for (const segment of segments) {
      const names = yield* lookup.readDirectory(current)
      if (!names.includes(segment))
        return yield* LocalPathError.make({ path: input, reason: "not_found", candidates: [] })
      current = options.path.join(current, segment)
    }
    const canonical = yield* lookup.realPath(current)
    if (!contained(root, canonical, options.path))
      return yield* LocalPathError.make({ path: input, reason: "outside_workspace", candidates: [] })
    return current
  }),
)
