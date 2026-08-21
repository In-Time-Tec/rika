import { expect, it } from "@effect/vitest"
import { identityMigrations, runMigration } from "@rika/identity"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import * as ExecutionPostgres from "@rika/execution/postgres"
import { Context, Effect, Exit, Layer, Random, Redacted, Scope } from "effect"
import { Pool } from "pg"
import { HostedApplication, layer as hostedApplicationLayer } from "../src/hosted-application"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL

const query = (pool: Pool, text: string) => Effect.promise(() => pool.query(text))
const waitForHostPoll = Effect.promise(() => Bun.sleep(10))

it.effect.skipIf(databaseUrl === undefined)(
  "retains hosted execution resources until the application scope closes",
  () =>
    Effect.gen(function* () {
      const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
      const database = `rika_hosted_application_${suffix}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* query(admin, `CREATE DATABASE "${database}"`)
      const parsed = new URL(databaseUrl!)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      const pool = new Pool({ connectionString: url })
      const resourceScope = yield* Scope.make()
      try {
        for (const migration of [...identityMigrations, ...productMigrations]) {
          const sql = yield* Effect.promise(() => Bun.file(migration.url).text())
          yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
        }
        yield* ExecutionPostgres.applySchema({ url, source: "rika-api" })
        const context = yield* Layer.buildWithScope(
          hostedApplicationLayer({
            database: { url: Redacted.make(url), maxConnections: 8 },
            databaseUrl: Redacted.make(url),
            providerCredentialKey: Redacted.make("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
            executor: {
              appId: "rika-test",
              deploymentId: "deployment-test",
              templateId: "template-test",
              templateBuildId: "build-test",
              apiUrl: "wss://api.example.test/api/v1/executors",
              allowedEgress: ["api.example.test"],
              apiKey: Redacted.make("e2b-test-key"),
            },
            workerId: "worker-test",
          }),
          resourceScope,
        )
        const application = Context.get(context, HostedApplication)
        for (let attempt = 0; attempt < 500; attempt += 1) {
          if ((yield* Effect.result(application.turnWorker.ready))._tag === "Success") break
          yield* waitForHostPoll
        }
        yield* application.turnWorker.ready
        expect(application.execution.gateway).toBeDefined()
        expect(application.execution.lifecycle).toBeDefined()
        for (let attempt = 0; attempt < 500; attempt += 1) {
          if ((yield* Effect.result(application.execution.readiness.check))._tag === "Success") break
          yield* waitForHostPoll
        }
        yield* application.execution.readiness.check
        expect(
          yield* application.execution.gateway.inspectTurn({
            runId: "missing-run",
            turnId: "missing-turn",
            threadId: "missing-thread",
          }),
        ).toEqual({ status: "unavailable" })
        yield* Scope.close(resourceScope, Exit.void)
        expect(
          (yield* Effect.exit(
            application.execution.gateway.inspectTurn({
              runId: "missing-run",
              turnId: "missing-turn",
              threadId: "missing-thread",
            }),
          ))._tag,
        ).toBe("Failure")
      } finally {
        yield* Scope.close(resourceScope, Exit.void).pipe(Effect.ignore)
        yield* Effect.promise(() => pool.end())
        yield* Effect.promise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.promise(() => admin.end())
      }
    }),
)
