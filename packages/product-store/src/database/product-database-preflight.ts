import { Effect, FileSystem, Layer, Schema } from "effect"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { decodeLegacyExecutionRoute } from "../migration/execution/product-migration-028-product-route-snapshot"
import { ProductDatabaseError } from "./product-database-layer"
import { inspectExisting, readPrefix, sqliteHeader, validateKnown } from "./product-database-inspection"

const fail = (message: string) => ProductDatabaseError.make({ message })

export const isFreshDatabaseFile = Effect.fn("ProductDatabase.isFreshDatabaseFile")(function* (filename: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const bytes = yield* readPrefix(filename, 105).pipe(
    Effect.mapError((error) => fail(`Could not inspect the Rika product database file: ${String(error)}`)),
  )
  const structurallyFresh = (() => {
    if (bytes.length === 0) return true
    if (bytes.length < 105 || sqliteHeader.some((byte, index) => bytes[index] !== byte)) return false
    const pageCount = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(28)
    const cellCount = ((bytes[103] ?? 0) << 8) | (bytes[104] ?? 0)
    return pageCount === 1 && bytes[100] === 13 && cellCount === 0
  })()
  if (!structurallyFresh) return false
  const [walExists, shmExists] = yield* Effect.all([
    fileSystem.exists(`${filename}-wal`),
    fileSystem.exists(`${filename}-shm`),
  ]).pipe(Effect.mapError((error) => fail(`Could not inspect the Rika product database files: ${String(error)}`)))
  if (!walExists && !shmExists) return true
  if (bytes.length === 0 || !walExists) return yield* fail("Rika product database does not match the current schema. Use a fresh Rika data root.")
  const wal = yield* readPrefix(`${filename}-wal`, 32).pipe(
    Effect.mapError((error) => fail(`Could not inspect the Rika product database WAL: ${String(error)}`)),
  )
  if (wal.length < 32) return yield* fail("Rika product database does not match the current schema. Use a fresh Rika data root.")
  const walMagic = new DataView(wal.buffer, wal.byteOffset, wal.byteLength).getUint32(0)
  if (walMagic !== 0x377f0682 && walMagic !== 0x377f0683)
    return yield* fail("Rika product database does not match the current schema. Use a fresh Rika data root.")
  return false
})

export const validateRoutePayloads = (filename: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-route-inspect-" })
      const inspectionFilename = `${directory}/rika.db`
      for (const suffix of ["", "-wal"] as const) {
        const source = `${filename}${suffix}`
        if (yield* fileSystem.exists(source))
          yield* fileSystem.writeFile(`${inspectionFilename}${suffix}`, yield* fileSystem.readFile(source))
      }
      const context = yield* Layer.build(SqliteClient.layer({ filename: inspectionFilename }))
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient
        const rows = yield* sql<{ readonly id: string; readonly route: string }>`
          SELECT id, execution_route_json AS route
          FROM rika_turns
          WHERE execution_route_json IS NOT NULL
        `
        for (const row of rows) {
          const value = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(row.route).pipe(
            Effect.mapError((error) => fail(`Malformed execution route JSON for turn ${row.id}: ${String(error)}`)),
          )
          yield* Effect.try({
            try: () => decodeLegacyExecutionRoute(value),
            catch: (error) => fail(`Malformed execution route for turn ${row.id}: ${String(error)}`),
          })
        }
      }).pipe(Effect.provide(context))
    }),
  )

export const preflight = Effect.fn("ProductDatabase.preflight")(function* (filename: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const exists = yield* fileSystem
    .exists(filename)
    .pipe(Effect.mapError((error) => fail(`Could not inspect the Rika product database path: ${String(error)}`)))
  if (!exists) return "fresh" as const
  if (yield* isFreshDatabaseFile(filename)) return "fresh" as const
  const state = yield* inspectExisting(filename)
  const status = yield* validateKnown(state)
  if (status === "tracked" && state.migrationRows.length === 27) yield* validateRoutePayloads(filename)
  return status
})
