import { Effect, Function, Path, PlatformError } from "effect"
import type { Lookup, Options } from "./local-path-contract"
import { LocalPathError } from "./local-path-error"

const expandHome = (value: string, home: string | undefined) => {
  if (home === undefined || home.length === 0) return value
  if (value === "~") return home
  return value.startsWith("~/") ? `${home}/${value.slice(2)}` : value
}

const segmentsOf = (path: Path.Path, absolute: string) => {
  const root = path.parse(absolute).root
  return {
    root,
    segments: absolute
      .slice(root.length)
      .split(path.sep)
      .filter((segment) => segment.length > 0),
  }
}

const walk = (
  path: Path.Path,
  lookup: Lookup,
  input: string,
  absolute: string,
  allowMissing: boolean,
): Effect.Effect<string, LocalPathError | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const { root, segments } = segmentsOf(path, absolute)
    let current = root
    let missing = false
    for (const segment of segments) {
      if (missing) {
        current = path.join(current, segment)
        continue
      }
      const exact = path.join(current, segment)
      if (yield* lookup.exists(exact)) {
        current = exact
        continue
      }
      const listed = yield* Effect.result(lookup.readDirectory(current))
      if (listed._tag === "Failure") {
        if (!allowMissing && !(yield* lookup.exists(current)))
          return yield* LocalPathError.make({ path: input, reason: "not_found", candidates: [] })
        return yield* listed.failure
      }
      const folded = segment.toLowerCase()
      const matches = listed.success.filter((entry) => entry.toLowerCase() === folded)
      if (matches.length > 1)
        return yield* LocalPathError.make({ path: input, reason: "ambiguous_case", candidates: matches })
      if (matches.length === 1) {
        current = path.join(current, matches[0]!)
        continue
      }
      if (!allowMissing) return yield* LocalPathError.make({ path: input, reason: "not_found", candidates: [] })
      missing = true
      current = exact
    }
    return current
  })

const resolveWith = (lookup: Lookup, input: string, options: Options, allowMissing: boolean) =>
  Effect.gen(function* () {
    const absolute = options.path.resolve(options.base, expandHome(input, options.home))
    if (yield* lookup.exists(absolute)) return absolute
    return yield* walk(options.path, lookup, input, absolute, allowMissing)
  })

export const resolveExistingPath: {
  (
    input: string,
    options: Options,
  ): (lookup: Lookup) => Effect.Effect<string, LocalPathError | PlatformError.PlatformError>
  (lookup: Lookup, input: string, options: Options): Effect.Effect<string, LocalPathError | PlatformError.PlatformError>
} = Function.dual(3, (lookup: Lookup, input: string, options: Options) => resolveWith(lookup, input, options, false))

export const resolveWriteTarget: {
  (
    input: string,
    options: Options,
  ): (lookup: Lookup) => Effect.Effect<string, LocalPathError | PlatformError.PlatformError>
  (lookup: Lookup, input: string, options: Options): Effect.Effect<string, LocalPathError | PlatformError.PlatformError>
} = Function.dual(3, (lookup: Lookup, input: string, options: Options) => resolveWith(lookup, input, options, true))
