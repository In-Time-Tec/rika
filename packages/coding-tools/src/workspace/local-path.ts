import { Effect, Function, Path, PlatformError, Schema } from "effect"

export const LocalPathReason = Schema.Literals(["not_found", "ambiguous_case", "outside_workspace"])
export type LocalPathReason = typeof LocalPathReason.Type

export class LocalPathError extends Schema.TaggedErrorClass<LocalPathError>()("LocalPathError", {
  path: Schema.String,
  reason: LocalPathReason,
  candidates: Schema.Array(Schema.String),
}) {}

export interface Lookup {
  readonly exists: (path: string) => Effect.Effect<boolean, PlatformError.PlatformError>
  readonly readDirectory: (path: string) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError>
}

export interface ExactLookup extends Lookup {
  readonly realPath: (path: string) => Effect.Effect<string, PlatformError.PlatformError>
}

export interface Options {
  readonly path: Path.Path
  readonly base: string
  readonly home?: string
}

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
