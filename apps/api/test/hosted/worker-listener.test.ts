import { expect, it } from "@effect/vitest"
import { Config, Context, Effect, Exit, Layer, Queue, Random, Redacted, Scope } from "effect"
import { Pool } from "pg"
import { HostedWorkerListener, layer as hostedWorkerListenerLayer } from "../../src/hosted/worker-listener"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))

it.effect.skipIf(databaseUrl === "")("delivers committed notifications and resumes LISTEN after reconnect", () =>
  Effect.gen(function* () {
    const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
    const channel = `rika_worker_test_${suffix}`
    const pool = new Pool({ connectionString: databaseUrl })
    const ownerScope = yield* Scope.make()
    try {
      const context = yield* Layer.buildWithScope(hostedWorkerListenerLayer(Redacted.make(databaseUrl)), ownerScope)
      const listener = Context.get(context, HostedWorkerListener)
      const notifications = yield* Queue.unbounded<string>()
      const connections = yield* Queue.unbounded<void>()
      yield* listener.listen(
        channel,
        (payload) => void Queue.offerUnsafe(notifications, payload),
        () => void Queue.offerUnsafe(connections, undefined),
      )
      yield* Queue.take(connections)

      yield* Effect.tryPromise(() => pool.query("BEGIN"))
      yield* Effect.tryPromise(() => pool.query("SELECT pg_notify($1, $2)", [channel, "rolled-back"]))
      yield* Effect.tryPromise(() => pool.query("ROLLBACK"))
      yield* Effect.tryPromise(() => pool.query("BEGIN"))
      yield* Effect.tryPromise(() => pool.query("SELECT pg_notify($1, $2)", [channel, "committed"]))
      yield* Effect.tryPromise(() => pool.query("COMMIT"))
      expect(yield* Queue.take(notifications)).toBe("committed")

      const listeners = yield* Effect.tryPromise(() =>
        pool.query<{ readonly pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query LIKE $1",
          [`LISTEN%${channel}%`],
        ),
      )
      expect(listeners.rows).toHaveLength(1)
      const initialPid = listeners.rows[0]!.pid
      yield* Effect.tryPromise(() => pool.query("SELECT pg_terminate_backend($1)", [initialPid]))
      yield* Queue.take(connections)

      yield* Effect.tryPromise(() => pool.query("SELECT pg_notify($1, $2)", [channel, "after-reconnect"]))
      expect(yield* Queue.take(notifications)).toBe("after-reconnect")
      const recovered = yield* Effect.tryPromise(() =>
        pool.query<{ readonly pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query LIKE $1",
          [`LISTEN%${channel}%`],
        ),
      )
      expect(recovered.rows).toHaveLength(1)
      expect(recovered.rows[0]!.pid).not.toBe(initialPid)
    } finally {
      yield* Scope.close(ownerScope, Exit.void)
      yield* Effect.tryPromise(() => pool.end())
    }
  }),
)
