import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { Database as NativeDatabase } from "bun:sqlite"
import * as Database from "@rika/product-store/product-database-layer"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import oracle from "./fixtures/product-migration-oracle-v28.fixture.json"

const makeDatabase = (filename: string) => Effect.scoped(Layer.build(Database.layer(filename)))

const prepareV27 = (filename: string, routeText: string) =>
  Effect.sync(() => {
    const database = new NativeDatabase(filename)
    try {
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
    } finally {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      database.close()
    }
  })

const updateRoute = (filename: string, routeText: string) =>
  Effect.sync(() => {
    const database = new NativeDatabase(filename)
    try {
      database.query("UPDATE rika_turns SET execution_route_json = ? WHERE id = 'oracle-turn'").run(routeText)
    } finally {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      database.close()
    }
  })

const migrationVersion = (filename: string) =>
  Effect.sync(() => {
    const database = new NativeDatabase(filename)
    try {
      const row = database.query("SELECT max(migration_id) AS migration_id FROM rika_migrations").get() as {
        migration_id: number | null
      }
      return row.migration_id
    } finally {
      database.close()
    }
  })

const removeSidecars = (filename: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    for (const path of databaseSidecars(filename).slice(1))
      if (yield* fileSystem.exists(path)) yield* fileSystem.remove(path)
  })

const vacuumCopy = (source: string, target: string) =>
  Effect.sync(() => {
    const database = new NativeDatabase(source)
    try {
      database.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
    } finally {
      database.close()
    }
  })

const makeV27Template = (directory: string, routeText: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const source = `${directory}/source/rika.db`
    const filename = `${directory}/template/rika.db`
    yield* fileSystem.makeDirectory(`${directory}/source`, { recursive: true })
    yield* fileSystem.makeDirectory(`${directory}/template`, { recursive: true })
    yield* makeDatabase(source)
    yield* prepareV27(source, routeText)
    yield* vacuumCopy(source, filename)
    yield* removeSidecars(source)
    expect(yield* migrationVersion(filename)).toBe(27)
    for (const path of databaseSidecars(filename).slice(1)) expect(yield* fileSystem.exists(path)).toBe(false)
    return filename
  })

const copyTemplate = (template: string, filename: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    yield* fileSystem.makeDirectory(filename.slice(0, filename.lastIndexOf("/")), { recursive: true })
    yield* fileSystem.writeFile(filename, yield* fileSystem.readFile(template))
    for (const path of databaseSidecars(filename).slice(1)) expect(yield* fileSystem.exists(path)).toBe(false)
  })

class V28Template extends Context.Service<V28Template, string>()(
  "@rika/product-store/test/product-migration-oracle-v28.test/V28Template",
) {}

const primaryRecipe = oracle.acceptedLegacyRouteRecipes[0]!

const v28TemplateLayer = Layer.effect(
  V28Template,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-v28-template-" })
    const routeText = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(primaryRecipe.legacyRoute)
    return yield* makeV27Template(directory, routeText)
  }),
)

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

const databaseSidecars = (filename: string) => [filename, `${filename}-wal`, `${filename}-shm`]

const readDatabaseBytes = (filename: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const bytes = new Map<string, Uint8Array>()
    for (const path of databaseSidecars(filename))
      if (yield* fileSystem.exists(path)) bytes.set(path, yield* fileSystem.readFile(path))
    return bytes
  })

const expectUnchanged = (before: Map<string, Uint8Array>, filename: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    for (const path of databaseSidecars(filename)) {
      const exists = yield* fileSystem.exists(path)
      expect(exists).toBe(before.has(path))
      if (exists) expect(yield* fileSystem.readFile(path)).toEqual(before.get(path))
    }
  })

const rejectRoutes = (directory: string, template: string, routes: Iterable<readonly [string, string]>) =>
  Effect.forEach(
    routes,
    ([name, routeText]) =>
      Effect.gen(function* () {
        const filename = `${directory}/${name}/rika.db`
        yield* copyTemplate(template, filename)
        yield* updateRoute(filename, routeText)
        yield* removeSidecars(filename)
        const before = yield* readDatabaseBytes(filename)
        expect(before.has(filename)).toBe(true)
        expect(before.has(`${filename}-wal`)).toBe(false)
        expect(before.has(`${filename}-shm`)).toBe(false)
        const result = yield* Effect.result(makeDatabase(filename))
        expect(result._tag).toBe("Failure")
        yield* expectUnchanged(before, filename)
      }),
    { concurrency: 4 },
  )

const malformedJsonRoutes = () =>
  oracle.malformedJsonCases.map((kind) => {
    let routeText = "[]"
    if (kind === "truncated-object") routeText = '{"version":1'
    else if (kind === "scalar") routeText = "null"
    return [`json-${kind}`, routeText] as const
  })

const malformedIdentityRoutes = (encodedRoute: string) =>
  oracle.malformedConnectionIdentityCases.map((kind) => {
    let replacement = '"connectionIdentity":{"opaque":1}'
    if (kind === "primitive") replacement = '"connectionIdentity":"opaque"'
    else if (kind === "array") replacement = '"connectionIdentity":[]'
    const marker = '"connectionIdentity":{"opaque":"connection-main"}'
    return [`identity-${kind}`, encodedRoute.replace(marker, replacement)] as const
  })

const rejectMalformedRoutes = (prefix: string, routes: Iterable<readonly [string, string]>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix })
      yield* rejectRoutes(directory, yield* V28Template, routes)
    }),
  )

const rejectIdentityCase = (prefix: string, index: number) =>
  Effect.gen(function* () {
    const route = {
      ...primaryRecipe.legacyRoute,
      main: {
        ...primaryRecipe.legacyRoute.main,
        providerRuntime: {
          ...primaryRecipe.legacyRoute.main.providerRuntime,
          connectionIdentity: { opaque: "connection-main" },
        },
      },
    }
    const encodedRoute = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.UnknownFromJsonString))(route)
    yield* rejectMalformedRoutes(prefix, malformedIdentityRoutes(encodedRoute).slice(index, index + 1))
  })

it.layer(BunServices.layer)("v28 migration oracle", (test) => {
  test.layer(v28TemplateLayer)((templateTest) => {
    for (const recipe of oracle.acceptedLegacyRouteRecipes)
      templateTest.effect(`rewrites ${recipe.name} and preserves every canonical field`, () =>
        Effect.scoped(
          Effect.gen(function* () {
            expect(oracle.migrationCount).toBe(28)
            expect(oracle.migrationName).toBe("product_route_snapshot")
            const fileSystem = yield* FileSystem.FileSystem
            const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-v28-oracle-" })
            const routeText = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(recipe.legacyRoute)
            const filename = yield* makeV27Template(`${directory}/valid`, routeText)
            yield* makeDatabase(filename)
            expect(yield* readRoute(filename)).toEqual(recipe.expectedSnapshot)
          }),
        ),
      )

    templateTest.effect("preserves a valid account runtime and arbitrary string connection identity", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-v28-account-runtime-" })
          const route = {
            ...primaryRecipe.legacyRoute,
            main: {
              ...primaryRecipe.legacyRoute.main,
              providerRuntime: {
                adapter: "openai-account",
                credentialIdentity: "account-main",
                connectionIdentity: { profile: "", region: "test-region" },
              },
              openAiAccountFingerprint: "account-main",
            },
          }
          const expected = {
            ...primaryRecipe.expectedSnapshot,
            main: {
              ...primaryRecipe.expectedSnapshot.main,
              providerConnection: {
                ...primaryRecipe.expectedSnapshot.main.providerConnection,
                authentication: "account",
                credentialIdentity: "account-main",
              },
            },
          }
          const routeText = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(route)
          const filename = yield* makeV27Template(directory, routeText)
          yield* makeDatabase(filename)
          expect(yield* readRoute(filename)).toEqual(expected)
        }),
      ),
    )

    for (const [index, kind] of oracle.malformedJsonCases.entries())
      templateTest.effect(`rejects malformed JSON ${kind} without changing database or sidecars`, () =>
        rejectMalformedRoutes(`rika-v28-malformed-json-${index}-`, malformedJsonRoutes().slice(index, index + 1)),
      )

    for (const [index, kind] of oracle.malformedConnectionIdentityCases.entries())
      templateTest.effect(`rejects malformed connection identity ${kind} without changing database or sidecars`, () =>
        rejectIdentityCase(`rika-v28-malformed-identity-${index}-`, index),
      )

    templateTest.effect("rejects every declared future version before writing database or sidecar bytes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-v28-reject-" })
          const template = yield* V28Template
          yield* Effect.forEach(
            oracle.rejectedVersions,
            (version) =>
              Effect.gen(function* () {
                const filename = `${directory}/${version}/rika.db`
                yield* copyTemplate(template, filename)
                const futureRoute = { ...primaryRecipe.legacyRoute, version }
                const routeText = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.UnknownFromJsonString))(
                  futureRoute,
                )
                yield* updateRoute(filename, routeText)
                yield* removeSidecars(filename)
                const before = yield* readDatabaseBytes(filename)
                expect(before.has(filename)).toBe(true)
                expect(before.has(`${filename}-wal`)).toBe(false)
                expect(before.has(`${filename}-shm`)).toBe(false)
                const result = yield* Effect.result(makeDatabase(filename))
                expect(result._tag).toBe("Failure")
                yield* expectUnchanged(before, filename)
              }),
            { concurrency: 2 },
          )
        }),
      ),
    )
  })
})
