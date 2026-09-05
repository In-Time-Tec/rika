import { clientLayer } from "@rika/execution/postgres"
import * as PgClient from "@effect/sql-pg/PgClient"
import { expect, it } from "@effect/vitest"
import { Clock, Config, Context, Deferred, Effect, Exit, Fiber, Layer, Redacted } from "effect"
import { Pool } from "pg"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const live = it.live.skipIf(databaseUrl === "")

const clients = Effect.gen(function* () {
  const context = yield* Layer.build(clientLayer({ url: Redacted.make(databaseUrl), maxConnections: 1 }))
  const sql = Context.get(context, PgClient.PgClient)
  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: databaseUrl, max: 1 })),
    (pool) => Effect.tryPromise(() => pool.end()).pipe(Effect.orDie),
  )
  return { sql, admin }
})

const waitForQuery = (admin: Pool, pid: number, query: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const activity = yield* Effect.tryPromise(() =>
        admin.query<{ query: string; wait_event: string }>(
          "SELECT query, wait_event FROM pg_stat_activity WHERE pid = $1",
          [pid],
        ),
      )
      if (activity.rows[0]?.query === query && activity.rows[0].wait_event === "PgSleep") return
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die("PostgreSQL did not reach the expected cancellation boundary")
  })

live(
  "interrupts a query with a full one-connection pool without waiting for the cancelled query to free capacity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, admin } = yield* clients
        const pid = (yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid
        const query = "SELECT pg_sleep(2)"
        const running = yield* sql.withTransaction(sql.unsafe(query)).pipe(Effect.forkChild)
        yield* waitForQuery(admin, pid, query)
        const started = yield* Clock.currentTimeMillis
        yield* Fiber.interrupt(running)
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(1_000)
        const next = yield* sql.withTransaction(
          sql<{ pid: number; ok: number }>`SELECT pg_backend_pid() AS pid, 1 AS ok`,
        )
        expect(next[0]?.ok).toBe(1)
        expect(next[0]?.pid).not.toBe(pid)
      }),
    ),
  { timeout: 10_000 },
)

live(
  "preserves a cancelled COMMIT failure and evicts its connection before the next independent transaction",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, admin } = yield* clients
        yield* sql.unsafe(`
        CREATE TEMP TABLE commit_cancellation_probe (id INTEGER);
        CREATE FUNCTION pg_temp.commit_cancellation_pause() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(10); RETURN NEW; END $$;
        CREATE CONSTRAINT TRIGGER commit_cancellation_pause
          AFTER INSERT ON commit_cancellation_probe DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION pg_temp.commit_cancellation_pause();
      `)
        const pid = (yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid
        const ready = yield* Deferred.make<void>()
        const cancel = yield* Effect.gen(function* () {
          yield* Deferred.await(ready)
          yield* waitForQuery(admin, pid, "COMMIT")
          const result = yield* Effect.tryPromise(() =>
            admin.query<{ cancelled: boolean }>("SELECT pg_cancel_backend($1) AS cancelled", [pid]),
          )
          expect(result.rows[0]?.cancelled).toBe(true)
        }).pipe(Effect.forkChild)
        const committed = yield* sql
          .withTransaction(
            sql`INSERT INTO commit_cancellation_probe VALUES (1)`.pipe(
              Effect.andThen(Deferred.succeed(ready, undefined)),
            ),
          )
          .pipe(Effect.exit)
        yield* Fiber.join(cancel)
        expect(Exit.isFailure(committed)).toBe(true)
        const next = yield* sql.withTransaction(
          sql<{ pid: number; ok: number }>`SELECT pg_backend_pid() AS pid, 1 AS ok`,
        )
        expect(next[0]?.ok).toBe(1)
        expect(next[0]?.pid).not.toBe(pid)
      }),
    ),
  { timeout: 15_000 },
)

live("keeps healthy connections reusable after successful commits and handled savepoint rollbacks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql } = yield* clients
      const pid = (yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid
      yield* sql.withTransaction(sql.withTransaction(Effect.fail("rollback nested work")).pipe(Effect.ignore))
      const next = yield* sql.withTransaction(sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)
      expect(next[0]?.pid).toBe(pid)
    }),
  ),
)
