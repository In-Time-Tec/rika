import { Effect, Path, PlatformError } from "effect"

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
