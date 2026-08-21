import * as PgClient from "@effect/sql-pg/PgClient"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import {
  HostedTurnWorkerStore,
  layer as workerStoreLayer,
} from "../../src/hosted/postgres-turn-worker-store"
import { Context, Effect, Layer, Random, Redacted, Schema } from "effect"
import { Pool } from "pg"
import { identityMigrations } from "../../../identity/src/migrations"
import { runMigration } from "../../../identity/src/postgres"
import { migrations } from "../../src/hosted/migrations"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL

const request = (workerId: string, claimToken: string, now: number, leaseMillis = 100) => ({
  workerId,
  claimToken,
  now,
  leaseMillis,
})

it.effect.skipIf(databaseUrl === undefined)("fences Turn claims and recovers prepared execution admission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = `rika_turn_worker_${Math.abs(yield* Random.nextInt)}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.promise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl!)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      const pool = new Pool({ connectionString: url })
      try {
        for (const migration of [...identityMigrations, ...migrations]) {
          const sql = yield* Effect.promise(() => Bun.file(migration.url).text())
          yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
        }
        const route = yield* Schema.encodeEffect(
          Schema.fromJsonString(ExecutionRoute.ExecutionRouteSnapshot),
        )(ExecutionRoute.testExecutionRoute())
        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
               VALUES ('worker-user','Worker','worker@example.test',true,now(),now());
             INSERT INTO rika_hosted_owners (id,kind,user_id,organization_id)
               VALUES ('worker-owner','personal','worker-user',NULL);
             INSERT INTO rika_workspaces (owner_id,path,created_at)
               VALUES ('worker-owner','workspace-1',1);
             INSERT INTO rika_threads (id,owner_id,workspace,title,created_at,updated_at)
               VALUES ('thread-1','worker-owner','workspace-1','Worker',1,1)`,
          ),
        )
        yield* Effect.promise(() =>
          pool.query(
            `INSERT INTO rika_turns
               (id,thread_id,prompt,status,created_at,updated_at,execution_route_json)
               VALUES ('turn-1','thread-1','first','queued',2,2,$1),
                 ('turn-2','thread-1','second','queued',3,3,$1)`,
            [route],
          ),
        )
        yield* Effect.promise(() =>
          pool.query(`INSERT INTO rika_thread_queue_state (thread_id,revision,queued_count)
            VALUES ('thread-1',2,2)`),
        )
        const context = yield* Layer.build(
          workerStoreLayer.pipe(
            Layer.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })),
          ),
        )
        const store = Context.get(context, HostedTurnWorkerStore)
        const claims = yield* Effect.forEach(
          Array.from({ length: 8 }, (_, index) => request(`worker-${index}`, `claim-${index}`, 100)),
          store.claimNext,
          { concurrency: "unbounded" },
        )
        expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1)
        const first = claims.find((claim) => claim !== undefined)
        if (first === undefined) return yield* Effect.die("Turn was not claimed")
        expect(first.input).toMatchObject({ turnId: "turn-1", threadId: "thread-1", prompt: "first" })
        expect(yield* store.prepare(first, 101)).toBe(true)
        expect(yield* store.claimRecovery(request("early", "early-claim", 150))).toBeUndefined()
        const recovered = yield* store.claimRecovery(request("recovery", "recovery-claim", 201))
        if (recovered === undefined) return yield* Effect.die("Prepared Turn was not recovered")
        expect(recovered).toMatchObject({ prepared: true, input: first.input })
        yield* store.complete(
          recovered,
          { runId: "run-turn-1", turnId: "turn-1", threadId: "thread-1" },
          202,
        )
        const durable = yield* Effect.promise(() =>
          pool.query(`SELECT status, execution_link_json FROM rika_turns WHERE id = 'turn-1'`),
        )
        expect(durable.rows[0]).toMatchObject({ status: "running" })
        const executionLink = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(ExecutionGateway.ExecutionLink),
        )(String(durable.rows[0].execution_link_json))
        expect(executionLink).toEqual({
          runId: "run-turn-1",
          turnId: "turn-1",
          threadId: "thread-1",
        })
        expect(
          Number(
            (
              yield* Effect.promise(() =>
                pool.query(`SELECT count(*) FROM rika_turn_admission_outbox UNION ALL
                  SELECT count(*) FROM rika_hosted_turn_claims`),
              )
            ).rows.reduce((total, row) => total + Number(row.count), 0),
          ),
        ).toBe(0)
        yield* Effect.promise(() => pool.query(`UPDATE rika_turns SET status = 'completed' WHERE id = 'turn-1'`))
        const second = yield* store.claimNext(request("worker-a", "second-a", 300))
        if (second === undefined) return yield* Effect.die("Second Turn was not claimed")
        expect(yield* store.renew(second, 350, 100)).toBe(true)
        expect(yield* store.claimNext(request("worker-b", "second-b-early", 401))).toBeUndefined()
        const replacement = yield* store.claimNext(request("worker-b", "second-b", 451))
        if (replacement === undefined) return yield* Effect.die("Expired Turn claim was not recovered")
        yield* store.release(second)
        const authority = yield* Effect.promise(() =>
          pool.query(`SELECT worker_id, claim_token FROM rika_hosted_turn_claims WHERE turn_id = 'turn-2'`),
        )
        expect(authority.rows[0]).toEqual({ worker_id: "worker-b", claim_token: "second-b" })
      } finally {
        yield* Effect.promise(() => pool.end())
        yield* Effect.promise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.promise(() => admin.end())
      }
    }),
  ),
)
