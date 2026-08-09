import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, layer as testLayer } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Path, PlatformError } from "effect"
import { ArtifactStore, layer } from "../src/binding/artifact-store"

const withStore = <A, E>(
  use: (store: ArtifactStore["Service"]) => Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E | PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const dataRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-artifacts-" })
      const context = yield* Layer.build(layer(dataRoot))
      return yield* use(Context.get(context, ArtifactStore))
    }),
  )

testLayer(BunServices.layer)("artifact store", (it) => {
  it.effect("returns the value a put stored under the identifier it minted", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const stored = yield* store.put({ value: { answer: 42 } })
        expect(stored.id).toMatch(/^[0-9a-f]{16}$/)
        expect(yield* store.get(stored.id)).toEqual({ answer: 42 })
        // The identifier is derived from the content, so two different values cannot share one and
        // the same value put twice does not store a second copy.
        const other = yield* store.put({ value: { answer: 43 } })
        expect(other.id).not.toBe(stored.id)
        expect((yield* store.put({ value: { answer: 42 } })).id).toBe(stored.id)
      }),
    ),
  )

  it.effect("reports an identifier it holds nothing under rather than reading elsewhere", () =>
    withStore((store) =>
      Effect.gen(function* () {
        // The reason a reader is given decides what they do next, so an absent artifact is not a
        // corrupt one.
        const outcome = yield* Effect.exit(store.get("0000000000000000"))
        expect(outcome._tag === "Failure" && String(outcome.cause).includes("No artifact is stored")).toBe(true)
      }),
    ),
  )

  it.effect("refuses to overwrite an artifact whose identifier a different value already names", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Identifiers are a 64-bit hash of the content, so two values can name one file. Overwriting
        // silently would hand a later read a value its own id did not describe.
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dataRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-artifact-collision-" })
        const context = yield* Layer.build(layer(dataRoot))
        const store = Context.get(context, ArtifactStore)
        const stored = yield* store.put({ value: { first: true } })
        yield* fileSystem.writeFileString(
          path.join(dataRoot, "artifacts", `${stored.id}.json`),
          `{"value":{"second":true}}`,
        )
        const collided = yield* Effect.exit(store.put({ value: { first: true } }))
        expect(collided._tag).toBe("Failure")
        expect(yield* store.get(stored.id)).toEqual({ second: true })
      }),
    ),
  )
})
