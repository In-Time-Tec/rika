import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Layer, Path } from "effect"
import { expect, test } from "vitest"
import { canonicalDataRoot } from "./canonical-data-root"

const withBunServices = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(effect, context))),
  )

test("returns the canonical product data directory", () =>
  withBunServices(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-data-root-" })
      const alias = path.join(root, "alias")
      yield* fs.symlink(root, alias)
      expect(yield* canonicalDataRoot(path.join(alias, "rika.db"))).toBe(yield* fs.realPath(root))
    }).pipe(Effect.scoped),
  ))

test("creates the product data directory", () =>
  withBunServices(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "rika-data-root-" })
      const root = path.join(parent, "profile")
      expect(yield* canonicalDataRoot(path.join(root, "rika.db"))).toBe(yield* fs.realPath(root))
    }).pipe(Effect.scoped),
  ))
