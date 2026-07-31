import "./sqlite-schema-1.test-support"
import "./sqlite-schema-2.test-support"
import { expect, test } from "vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Database as NativeDatabase } from "bun:sqlite"
import { Effect, FileSystem, Layer } from "effect"
import * as Database from "@rika/product-store/product-database-layer"
const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })

test("rejects partial and future schemas without changing them", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-schema-shape-" })
      const partial = `${directory}/partial.db`
      yield* Effect.sync(() => {
        const database = new NativeDatabase(partial)
        database.exec("CREATE TABLE rika_workspaces (path TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL)")
        database.close()
      })
      const partialBefore = yield* fileSystem.readFile(partial)
      const partialResult = yield* Effect.result(Effect.scoped(Layer.build(Database.layer(partial))))
      expect(partialResult._tag).toBe("Failure")
      if (partialResult._tag === "Failure")
        expect(String(partialResult.failure)).toContain("Use a fresh Rika data root")
      expect([...(yield* fileSystem.readFile(partial))]).toEqual([...partialBefore])

      const extra = `${directory}/extra.db`
      yield* Effect.scoped(Layer.build(Database.layer(extra)))
      yield* Effect.sync(() => {
        const database = new NativeDatabase(extra)
        database.exec(`
          INSERT INTO rika_migrations (migration_id, name) VALUES (15, 'future_schema');
          CREATE TABLE future_product_state (id TEXT PRIMARY KEY);
        `)
        database.close()
      })
      const extraBefore = yield* fileSystem.readFile(extra)
      const extraResult = yield* Effect.result(Effect.scoped(Layer.build(Database.layer(extra))))
      expect(extraResult._tag).toBe("Failure")
      if (extraResult._tag === "Failure") expect(String(extraResult.failure)).toContain("Use a fresh Rika data root")
      expect([...(yield* fileSystem.readFile(extra))]).toEqual([...extraBefore])
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})
