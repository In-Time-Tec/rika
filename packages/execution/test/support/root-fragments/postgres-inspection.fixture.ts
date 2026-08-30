import { expect, it } from "@effect/vitest"
import * as PgClient from "@effect/sql-pg/PgClient"
import { RunSchema } from "@tenetkit/pg"
import { ModelRegistry } from "tenetkit"
import { TestModel } from "tenetkit/test"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Config, Context, Effect, Exit, Layer, Random, Scope, Stream } from "effect"
import { Pool } from "pg"
import { layerHosted } from "../../../src/engine/runtime"
import { remoteCell } from "../adapters"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const maxConnections = 6

const backendCount = (pool: Pool) =>
  Effect.tryPromise(() =>
    pool.query<{ readonly count: string }>(
      "SELECT COUNT(*) AS count FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend'",
    ),
  ).pipe(Effect.map((result) => Number(result.rows[0]?.count ?? 0)))

it.live.skipIf(databaseUrl === "")(
  "inspects BIGINT tree positions without accumulating PostgreSQL backends",
  () =>
    Effect.gen(function* () {
      const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
      const database = `rika_execution_inspection_${suffix}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      const pool = new Pool({ connectionString: url })
      const scope = yield* Scope.make()
      try {
        const postgresContext = yield* Layer.buildWithScope(
          RunSchema.layerClient({ url, maxConnections }),
          scope,
        )
        yield* RunSchema.apply("postgres-inspection-test").pipe(Effect.provide(postgresContext))
        const fixture = yield* TestModel.make([TestModel.turn([TestModel.text("POSTGRES_INSPECTION_OK")])], {
          provider: "test",
          model: "test",
          registrationKey: "test",
        })
        const context = yield* Layer.buildWithScope(
          layerHosted({
            kernel: { runtimeVersion: Bun.version, dataRoot: `/tmp/rika-postgres-inspection-${suffix}` },
            cells: remoteCell,
            modelServices: ModelRegistry.layer([
              Effect.succeed({ ...fixture.registration, isAvailabilityFailure: () => false }),
            ]),
            postgres: {
              url,
              source: "postgres-inspection-test",
              maxConnections,
              worker: {
                workerId: `postgres-inspection-${suffix}`,
                concurrency: 1,
                leaseMillis: 30_000,
                fallbackIntervalMillis: 20,
                cancellationIntervalMillis: 20,
              },
            },
          }).pipe(
            Layer.provide(Layer.succeed(PgClient.PgClient, Context.get(postgresContext, PgClient.PgClient))),
          ),
          scope,
        )
        const gateway = Context.get(context, ExecutionGateway.Service)
        const link = yield* gateway.startTurn({
          threadId: `thread-${suffix}`,
          turnId: `turn-${suffix}`,
          workspaceId: "/workspace",
          prompt: "Return the PostgreSQL inspection marker",
          executionRoute: testExecutionRoute(),
        })
        yield* gateway.watchTurn(link).pipe(Stream.runDrain)
        expect(yield* gateway.inspectTurn(link)).toMatchObject({ status: "completed" })
        const positionType = yield* Effect.tryPromise(() =>
          pool.query<{ readonly type: string }>(
            "SELECT pg_typeof(position)::text AS type FROM tenetkit_tree_event_index LIMIT 1",
          ),
        )
        expect(positionType.rows[0]?.type).toBe("bigint")

        const inspect = Effect.gen(function* () {
          yield* Effect.scoped(gateway.watchTurn(link).pipe(Stream.runDrain))
          expect(yield* gateway.inspectTurn(link)).toMatchObject({ status: "completed" })
        })
        const observeWindow = Effect.fn("PostgresInspection.observeWindow")(function* (attempts: number) {
          const counts = new Array<number>()
          for (let attempt = 0; attempt < attempts; attempt += 1) {
            yield* inspect
            counts.push(yield* backendCount(pool))
          }
          return counts
        })
        yield* observeWindow(10)
        const firstWindow = yield* observeWindow(10)
        const secondWindow = yield* observeWindow(10)
        expect(
          Math.max(...secondWindow),
          `PostgreSQL backends grew across repeated inspection windows: first=${firstWindow.join(",")}; second=${secondWindow.join(",")}`,
        ).toBeLessThanOrEqual(Math.max(...firstWindow))
        expect(yield* fixture.requests).toHaveLength(1)
      } finally {
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
        yield* Effect.tryPromise(() => pool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  60_000,
)
