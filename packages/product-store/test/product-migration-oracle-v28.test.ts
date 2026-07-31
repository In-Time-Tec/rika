import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { Database as NativeDatabase } from "bun:sqlite"
import * as Database from "@rika/product-store/product-database-layer"
import * as Turn from "@rika/product/turn-record"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import oracle from "./fixtures/product-migration-oracle-v28.fixture.json"
import routeFixture from "./fixtures/product-route-snapshot.fixture.json"

const legacyModel = (model: Turn.ExecutionModelRoute) => {
  const connection = model.providerConnection
  return {
    role: model.role,
    alias: model.alias,
    provider: connection.provider,
    model: model.model,
    registrationKey: model.registrationIdentity,
    providerProtocol: connection.protocol,
    providerBaseUrl: connection.baseUrl,
    ...(connection.apiKeyEnvironment === undefined ? {} : { providerApiKeyEnv: connection.apiKeyEnvironment }),
    effort: model.effort,
    fast: model.fast,
    requestVariant: model.requestVariant,
    ...(model.providerOptions === undefined ? {} : { providerOptions: model.providerOptions }),
    compaction: model.compaction,
  }
}

const legacyRoute = (route: Turn.ExecutionRoutePin) => ({
  version: 1,
  mode: route.mode,
  ...(route.tokenBudget === undefined ? {} : { tokenBudget: route.tokenBudget }),
  ...(route.title === undefined ? {} : { title: legacyModel(route.title) }),
  ...(route.compactionSummary === undefined ? {} : { compactionSummary: legacyModel(route.compactionSummary) }),
  main: legacyModel(route.main),
  oracle: legacyModel(route.oracle),
  ...(route.agents === undefined
    ? {}
    : {
        agents: Object.fromEntries(Object.entries(route.agents).map(([role, model]) => [role, legacyModel(model)])),
      }),
})

const makeDatabase = (filename: string) => Effect.scoped(Layer.build(Database.layer(filename)))

const prepareV27 = (filename: string, routeText: string) =>
  Effect.sync(() => {
    const database = new NativeDatabase(filename)
    database.exec("DELETE FROM rika_migrations WHERE migration_id = 28")
    database.exec("INSERT INTO rika_workspaces (path, created_at) VALUES ('/oracle', 1)")
    database.exec(
      "INSERT INTO rika_threads (id, workspace, title, labels_json, pinned, archived, created_at, updated_at) VALUES ('oracle-thread', '/oracle', 'Oracle', '[]', 0, 0, 1, 1)",
    )
    database
      .query(
        "INSERT INTO rika_turns (id, thread_id, prompt, status, execution_route_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("oracle-turn", "oracle-thread", "oracle", "completed", routeText, 1, 1)
    database.close()
  })

const readRoute = (filename: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Database.layer(filename))
      return yield* Effect.gen(function* () {
        const sql = yield* SqlClient
        const rows = yield* sql<{ readonly execution_route_json: string }>`
          SELECT execution_route_json FROM rika_turns WHERE id = 'oracle-turn'
        `
        return yield* Schema.decodeUnknownEffect(ExecutionRouteSnapshot)(
          yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(rows[0]!.execution_route_json),
        )
      }).pipe(Effect.provide(context))
    }),
  )

it.layer(BunServices.layer)("v28 migration oracle", (test) => {
  test.effect("rewrites every route role and preserves opaque identities", () =>
    Effect.scoped(
      Effect.gen(function* () {
        expect(oracle.migrationCount).toBe(28)
        expect(oracle.migrationName).toBe("product_route_snapshot")
        expect(routeFixture.roles).toHaveLength(10)
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-v28-oracle-" })
        const filename = `${directory}/rika.db`
        yield* makeDatabase(filename)
        const route = Turn.testExecutionRoute("high")
        const before = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(legacyRoute(route))
        yield* prepareV27(filename, before)
        yield* makeDatabase(filename)
        const snapshot = yield* readRoute(filename)
        expect(snapshot.version).toBe(1)
        expect(snapshot.mode).toBe("high")
        expect(snapshot.main.registrationIdentity).toBe("test")
        expect(Object.values(snapshot.agents ?? {}).map((model) => model.role)).toEqual([
          "librarian",
          "painter",
          "review",
          "readThread",
          "surgeon",
          "task",
        ])
        const text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(snapshot)
        for (const field of routeFixture.forbiddenFields) expect(text).not.toContain(field)
      }),
    ),
  )

  test.effect("rejects malformed and future route rows before writing any database bytes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-v28-reject-" })
        const futureRoute = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
          ...legacyRoute(Turn.testExecutionRoute()),
          version: 99,
        })
        for (const routeText of ["{", futureRoute]) {
          const filename = `${directory}/${routeText.length}/rika.db`
          yield* makeDatabase(filename)
          yield* prepareV27(filename, routeText)
          const before = yield* fileSystem.readFile(filename)
          const result = yield* Effect.result(makeDatabase(filename))
          expect(result._tag).toBe("Failure")
          const after = yield* fileSystem.readFile(filename)
          expect(Array.from(after)).toEqual(Array.from(before))
        }
      }),
    ),
  )
})
