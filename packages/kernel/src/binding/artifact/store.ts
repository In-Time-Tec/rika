import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"

const Persisted = Schema.Struct({ value: Schema.Unknown, mediaType: Schema.optionalKey(Schema.String) })
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(Persisted))
const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(Persisted))

export class ArtifactUnavailable extends Schema.TaggedError<ArtifactUnavailable>()("ArtifactUnavailable", {
  id: Schema.String,
  reason: Schema.Literals(["missing", "corrupt", "too-large", "io"]),
  message: Schema.String,
}) {}

export const Stored = Schema.Struct({ id: Schema.String, bytes: Schema.Int })

const maxBytes = 8 * 1024 * 1024

interface Interface {
  readonly put: (input: {
    readonly value: unknown
    readonly mediaType?: string | undefined
  }) => Effect.Effect<typeof Stored.Type, ArtifactUnavailable>
  readonly get: (id: string) => Effect.Effect<unknown, ArtifactUnavailable>
}

export class ArtifactStore extends Context.Service<ArtifactStore, Interface>()(
  "@rika/kernel/binding/artifact/store/ArtifactStore",
) {}

const identifier = (encoded: string): string => Bun.hash(encoded).toString(16).padStart(16, "0")

const unavailable = (id: string, reason: ArtifactUnavailable["reason"], message: string) =>
  ArtifactUnavailable.make({ id, reason, message })

const make = (dataRoot: string): Effect.Effect<Interface, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = path.join(dataRoot, "artifacts")
    const fileOf = (id: string) => path.join(directory, `${id}.json`)
    return {
      put: (input) =>
        Effect.gen(function* () {
          const persisted: typeof Persisted.Type = input.mediaType === undefined
            ? { value: input.value }
            : { value: input.value, mediaType: input.mediaType }
          const encoded = yield* encodeStored(persisted).pipe(
            Effect.mapError(() => unavailable("", "corrupt", "artifact value is not JSON")),
          )
          const bytes = new TextEncoder().encode(encoded).byteLength
          const id = identifier(encoded)
          if (bytes > maxBytes)
            return yield* unavailable(id, "too-large", `Artifact of ${bytes} bytes exceeds the ${maxBytes} byte bound`)
          yield* fileSystem
            .makeDirectory(directory, { recursive: true, mode: 0o700 })
            .pipe(Effect.mapError((error) => unavailable(id, "io", error.message)))
          /**
           * An id is a 64-bit hash of the content, so two different values can name one file. That
           * is rare enough never to be seen and silent when it happens, which is the wrong way round
           * for a store a model reads back by id.
           */
          const existing = yield* fileSystem
            .readFileString(fileOf(id))
            .pipe(Effect.catchTag("PlatformError", () => Effect.succeed("")))
          if (existing !== "" && existing !== encoded)
            return yield* unavailable(id, "corrupt", `A different artifact is already stored under ${id}`)
          yield* fileSystem
            .writeFileString(fileOf(id), encoded, { mode: 0o600 })
            .pipe(Effect.mapError((error) => unavailable(id, "io", error.message)))
          return { id, bytes }
        }),
      get: (id) =>
        fileSystem.readFileString(fileOf(id)).pipe(
          Effect.mapError(() => unavailable(id, "missing", `No artifact is stored under ${id}`)),
          Effect.flatMap((encoded) =>
            decodeStored(encoded).pipe(
              Effect.mapError(() => unavailable(id, "corrupt", `Artifact ${id} is not readable JSON`)),
              Effect.map((stored) => stored.value),
            ),
          ),
        ),
    }
  })

export const layer = (dataRoot: string): Layer.Layer<ArtifactStore, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(ArtifactStore, make(dataRoot))

export const layerTest = (implementation: Interface): Layer.Layer<ArtifactStore> =>
  Layer.succeed(ArtifactStore, ArtifactStore.of(implementation))
