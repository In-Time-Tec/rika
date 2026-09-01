import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { ensureRemoteStage, parseRemoteStage, readRemoteStage, remoteStageIdentity } from "../scripts/development/stack"

const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

it.effect("creates one persistent private personal Railway stage", () =>
  live(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-railway-stage-" })
      const first = yield* ensureRemoteStage(root)
      const second = yield* ensureRemoteStage(root)
      const identity = path.join(root, remoteStageIdentity)

      expect(first).toMatch(/^dev-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
      expect(second).toBe(first)
      expect((yield* fileSystem.readFileString(identity)).trim()).toBe(first)
      expect((yield* fileSystem.stat(path.join(root, ".alchemy"))).mode & 0o777).toBe(0o700)
      expect((yield* fileSystem.stat(identity)).mode & 0o777).toBe(0o600)
    }),
  ),
)

it.effect("refuses protected and malformed remote stage identities", () =>
  live(
    Effect.gen(function* () {
      for (const stage of [
        "production",
        "staging",
        "pr-42",
        "dev-user",
        "dev-ABCDEF0123456789",
        "dev-01234567-89ab-1cde-8fab-0123456789ab",
      ])
        expect(() => parseRemoteStage(stage)).toThrow()

      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-railway-stage-" })
      yield* ensureRemoteStage(root)
      yield* fileSystem.writeFileString(path.join(root, remoteStageIdentity), "production\n")
      const error = yield* Effect.flip(readRemoteStage(root))
      expect(String(error)).toContain("protected Railway stage")
    }),
  ),
)

it.effect("rejects a symbolic-link stage identity", () =>
  live(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-railway-stage-" })
      const target = path.join(root, "stage-target")
      yield* fileSystem.writeFileString(target, "dev-01234567-89ab-4cde-8fab-0123456789ab\n", { mode: 0o600 })
      yield* fileSystem.makeDirectory(path.join(root, ".alchemy"), { mode: 0o700 })
      yield* fileSystem.symlink(target, path.join(root, remoteStageIdentity))
      const error = yield* Effect.flip(readRemoteStage(root))
      expect(String(error)).toContain("symbolic link")

      const parentRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-railway-stage-parent-" })
      const redirected = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-railway-stage-redirected-" })
      yield* fileSystem.writeFileString(
        path.join(redirected, "rika-dev-stage"),
        "dev-01234567-89ab-4cde-8fab-0123456789ab\n",
        { mode: 0o600 },
      )
      yield* fileSystem.chmod(redirected, 0o755)
      yield* fileSystem.symlink(redirected, path.join(parentRoot, ".alchemy"))
      const ensureParentError = yield* Effect.flip(ensureRemoteStage(parentRoot))
      expect(String(ensureParentError)).toContain("symbolic link")
      expect((yield* fileSystem.stat(redirected)).mode & 0o777).toBe(0o755)
      const parentError = yield* Effect.flip(readRemoteStage(parentRoot))
      expect(String(parentError)).toContain("symbolic link")
    }),
  ),
)

it.effect("concurrent starts adopt the same complete stage identity", () =>
  live(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-railway-stage-" })
      const stages = yield* Effect.all(
        Array.from({ length: 8 }, () => ensureRemoteStage(root)),
        { concurrency: 8 },
      )
      expect(new Set(stages)).toEqual(new Set([stages[0]]))
    }),
  ),
)

it.effect("reading for destroy fails closed without creating an identity", () =>
  live(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-railway-stage-" })
      expect((yield* Effect.exit(readRemoteStage(root)))._tag).toBe("Failure")
      expect(yield* fileSystem.exists(path.join(root, remoteStageIdentity))).toBe(false)
    }),
  ),
)
