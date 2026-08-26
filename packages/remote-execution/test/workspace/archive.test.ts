import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { createArchive, restoreArchive } from "../../src/workspace/archive"

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

describe("Workspace archive", () => {
  it.effect("creates deterministic scrubbed archives and restores them without replacing repository identity", () =>
    withPlatform(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const source = yield* fileSystem.makeTempDirectory({ prefix: "rika-archive-source-" })
        const target = yield* fileSystem.makeTempDirectory({ prefix: "rika-archive-target-" })
        yield* Effect.gen(function* () {
          yield* fileSystem.makeDirectory(`${source}/.git`, { recursive: true })
          yield* fileSystem.makeDirectory(`${source}/.agents/state/run`, { recursive: true })
          yield* fileSystem.writeFileString(`${source}/state.txt`, "durable state")
          yield* fileSystem.writeFileString(`${source}/.git/config`, "source identity")
          yield* fileSystem.writeFileString(`${source}/.agents/state/run/transient`, "transient")
          yield* fileSystem.writeFileString(`${source}/.env`, "TOKEN=excluded-secret")
          yield* fileSystem.writeFileString(`${source}/.env.staging`, "TOKEN=excluded-staging-secret")
          const first = yield* createArchive(source)
          const second = yield* createArchive(source)
          expect(first).toEqual(second)

          yield* fileSystem.makeDirectory(`${target}/.git`, { recursive: true })
          yield* fileSystem.writeFileString(`${target}/.git/config`, "authorized identity")
          yield* fileSystem.writeFileString(`${target}/stale.txt`, "stale")
          yield* restoreArchive(target, first, [])

          expect(yield* fileSystem.readFileString(`${target}/state.txt`)).toBe("durable state")
          expect(yield* fileSystem.readFileString(`${target}/.git/config`)).toBe("authorized identity")
          expect(yield* fileSystem.exists(`${target}/stale.txt`)).toBe(false)
          expect(yield* fileSystem.exists(`${target}/.agents/state`)).toBe(false)
          expect(yield* fileSystem.exists(`${target}/.env`)).toBe(false)
          expect(yield* fileSystem.exists(`${target}/.env.staging`)).toBe(false)
        }).pipe(
          Effect.ensuring(
            Effect.all(
              [
                fileSystem.remove(source, { recursive: true, force: true }),
                fileSystem.remove(target, { recursive: true, force: true }),
              ],
              { discard: true },
            ).pipe(Effect.ignore),
          ),
        )
      }),
    ),
  )

  it.effect("rejects authorized secret values and archive descriptor corruption", () =>
    withPlatform(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const source = yield* fileSystem.makeTempDirectory({ prefix: "rika-archive-secret-" })
        yield* Effect.gen(function* () {
          yield* fileSystem.writeFileString(`${source}/output.txt`, "setup wrote exact-secret-value")
          expect((yield* Effect.flip(createArchive(source, new Set(["exact-secret-value"])))).kind).toBe("secret")
          yield* fileSystem.writeFileString(`${source}/output.txt`, "safe")
          const archive = yield* createArchive(source)
          expect(
            (yield* Effect.flip(restoreArchive(source, { ...archive, contentDigest: `sha256:${"0".repeat(64)}` }, [])))
              .kind,
          ).toBe("archive")
        }).pipe(Effect.ensuring(fileSystem.remove(source, { recursive: true, force: true }).pipe(Effect.ignore)))
      }),
    ),
  )
})
