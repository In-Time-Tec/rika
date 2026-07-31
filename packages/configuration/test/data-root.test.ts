import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Layer, Path } from "effect"
import { expect, test } from "vitest"
import { canonicalDataRoot } from "../src/data-root"

const withBunServices = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(effect, context))),
  )

test("uses one canonical directory for both resident databases", () =>
  withBunServices(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-data-root-" })
      const other = path.join(root, "other")
      const alias = path.join(root, "alias")
      yield* fs.makeDirectory(other)
      yield* fs.symlink(root, alias)
      expect(yield* canonicalDataRoot(path.join(root, "rika.db"), path.join(alias, "execution.db"))).toBe(
        yield* fs.realPath(root),
      )
      expect(
        (yield* Effect.exit(canonicalDataRoot(path.join(root, "rika.db"), path.join(other, "execution.db"))))._tag,
      ).toBe("Failure")
    }).pipe(Effect.scoped),
  ))

test("accepts any pair of database filenames that share one directory", () =>
  withBunServices(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-data-root-" })
      expect(yield* canonicalDataRoot(path.join(root, "product.db"), path.join(root, "durable.db"))).toBe(
        yield* fs.realPath(root),
      )
    }).pipe(Effect.scoped),
  ))
