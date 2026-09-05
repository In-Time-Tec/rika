import { RunClaims } from "generalist/runtime/sql-driver"
import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Config, Context, Effect, Exit, FileSystem, Layer, Random, Scope } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Pool } from "pg"
import { RuntimeSchema, layer } from "generalist/pg"
import { Agent, Policy } from "generalist"
import { TestModel } from "generalist/testing"
import { ExecutableManifest, ExecutableResolver, RunExecutor, RunStore, Runtime } from "generalist/runtime"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const source = "rika-generalist-upgrade"
const executable = ExecutableManifest.makeTest("upgrade-fixture", "1")
const agent = (name: string) =>
  Agent.close(
    Agent.make({ name, policy: Policy.make(() => Effect.succeed(Policy.decision.continue())) }),
    TestModel.layer([TestModel.turn([TestModel.text("AFTER_UPGRADE")])]),
  )

it.live.skipIf(databaseUrl === "")(
  "upgrades Generalist v4 while preserving history and admitted work",
  () =>
    Effect.gen(function* () {
      const database = `rika_upgrade_${String(yield* Random.nextInt).replaceAll("-", "n")}`
      const admin = new Pool({ connectionString: databaseUrl })
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const scope = yield* Scope.make()
      try {
        const client = RuntimeSchema.layerClient({ url, maxConnections: 4 })
        const sqlContext = yield* Layer.buildWithScope(client, scope)
        const fileContext = yield* Layer.buildWithScope(BunServices.layer, scope)
        const seed = yield* Context.get(fileContext, FileSystem.FileSystem).readFileString(
          new URL("./generalist-v4.fixture.sql", import.meta.url).pathname,
        )
        const seedPool = new Pool({ connectionString: url })
        yield* Effect.tryPromise(() => seedPool.query(seed)).pipe(
          Effect.ensuring(Effect.tryPromise(() => seedPool.end()).pipe(Effect.orDie)),
        )
        const completed = { runId: "run_mtorvpnj_1w9jn4l8qct" }
        const admitted = { runId: "run_mtorvpr3_dufuvjjwyz" }
        const active = { runId: "run_mtorvprc_1d4z7t4lv6e" }
        const beforeRows = yield* Context.get(sqlContext, SqlClient.SqlClient)<{
          readonly event_json: string
        }>`SELECT event_json FROM generalist_run_events WHERE run_id = ${completed.runId} ORDER BY sequence`
        const sql = Context.get(sqlContext, SqlClient.SqlClient)
        const [metadata] = yield* sql<{
          readonly checksum: string
        }>`SELECT checksum FROM generalist_schema_meta WHERE id = 1`
        yield* sql`UPDATE generalist_schema_meta SET checksum = 'unknown' WHERE id = 1`
        const rejected = yield* RuntimeSchema.apply(source).pipe(Effect.provide(sqlContext), Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)
        expect(
          (yield* sql<{ readonly version: number }>`SELECT version FROM generalist_schema_meta WHERE id = 1`)[0]
            ?.version,
        ).toBe(4)
        yield* sql`UPDATE generalist_schema_meta SET checksum = ${metadata!.checksum} WHERE id = 1`
        // Force a late DDL failure and prove the entire additive migration rolls back.
        yield* sql`ALTER TABLE generalist_run_operations ADD COLUMN completed_sequence INTEGER`
        const rolledBack = yield* RuntimeSchema.apply(source).pipe(Effect.provide(sqlContext), Effect.exit)
        expect(Exit.isFailure(rolledBack)).toBe(true)
        expect(
          (yield* sql<{
            readonly version: number
            readonly dirty: boolean
          }>`SELECT version, dirty FROM generalist_schema_meta WHERE id = 1`)[0],
        ).toMatchObject({ version: 4, dirty: false })
        yield* sql`ALTER TABLE generalist_run_operations DROP COLUMN completed_sequence`
        const plan = yield* RuntimeSchema.plan(source).pipe(Effect.provide(sqlContext))
        expect(plan).toMatchObject({ current: 4, required: 9, upgradeRequired: true })
        expect(plan.statements.length).toBeGreaterThan(0)
        yield* Effect.all([RuntimeSchema.apply(source), RuntimeSchema.apply(source)], { concurrency: 2 }).pipe(
          Effect.provide(sqlContext),
        )
        yield* RuntimeSchema.apply(source).pipe(Effect.provide(sqlContext))
        const current = yield* Layer.buildWithScope(
          layer({ url, source, addresses: [] }).pipe(
            Layer.provide(
              ExecutableResolver.layerStatic([
                { executable, agent: agent("upgrade-fixture") },
                { executable: ExecutableManifest.makeTest("upgrade-delayed", "1"), agent: agent("upgrade-delayed") },
              ]),
            ),
          ),
          scope,
        )
        const runtime = Context.get(current, Runtime.Runtime)
        expect(yield* runtime.history({ runId: completed.runId, limit: 1000 })).toHaveLength(beforeRows.length)
        expect(
          yield* sql<{
            readonly event_json: string
          }>`SELECT event_json FROM generalist_run_events WHERE run_id = ${completed.runId} ORDER BY sequence`,
        ).toEqual(beforeRows)
        expect((yield* runtime.inspect(completed.runId)).status).toBe("succeeded")
        expect(
          yield* Context.get(current, RunClaims).claimReadyRuns({
            workerId: "gate-check",
            limit: 10,
            lease: "30 seconds",
          }),
        ).toEqual([])
        yield* runtime.activate({ runId: admitted.runId })
        const nextClaim = yield* Context.get(current, RunStore.RunStore).claimExecution({
          runId: admitted.runId,
          ownerId: "new-worker",
        })
        yield* Context.get(current, RunExecutor.RunExecutor).execute(nextClaim)
        expect((yield* runtime.inspect(admitted.runId)).status).toBe("succeeded")
        const store = Context.get(current, RunStore.RunStore)
        expect((yield* store.loadExecution(active.runId)).checkpoint).toBeDefined()
        expect((yield* runtime.inspect(active.runId)).status).toBe("needs-resolution")
        const unknown = (yield* runtime.history({ runId: active.runId, limit: 1000 })).find(
          (event) => event._tag === "OperationUnknown",
        )
        if (unknown?._tag !== "OperationUnknown")
          return yield* Effect.die("Missing durable interrupted-operation identity")
        yield* runtime.resolveOperation({
          runId: active.runId,
          operationId: unknown.operationId,
          idempotencyKey: "test-explicit-retry",
          resolution: { _tag: "Retry" },
        })
        const claims = yield* Context.get(current, RunClaims).claimReadyRuns({
          workerId: "resumed-worker",
          limit: 10,
          lease: "30 seconds",
        })
        const resumed = claims.find((claim) => claim.run.runId === active.runId)
        if (resumed === undefined) return yield* Effect.die("Interrupted Run was not claimable after explicit retry")
        const resumedClaim = {
          runId: active.runId,
          ownerId: resumed.workerId,
          attemptFence: resumed.attemptFence,
          session: resumed.session,
        }
        yield* Context.get(current, RunExecutor.RunExecutor).execute(resumedClaim)
        expect((yield* runtime.inspect(active.runId)).status).toBe("succeeded")
      } finally {
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  60_000,
)
