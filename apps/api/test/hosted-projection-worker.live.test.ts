import * as PgClient from "@effect/sql-pg/PgClient"
import { expect, it } from "@effect/vitest"
import { identityMigrations, runMigration } from "@rika/identity"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import * as ProductRepositories from "@rika/product-store/postgres-product-repositories"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { FileSystem, Config, Context, Effect, Exit, Layer, Random, Redacted, Schema, Scope, Stream } from "effect"
import { Pool } from "pg"
import { live as livePlatform } from "./live-platform"
import { layer as hostedExecutionReconcilerLayer } from "../src/hosted-execution-reconciler"
import { layer as hostedProjectionWorkerLayer } from "../src/hosted-projection-worker"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const JsonRoute = Schema.fromJsonString(ExecutionRoute.ExecutionRouteSnapshot)
const JsonLink = Schema.fromJsonString(ExecutionGateway.ExecutionLink)
const JsonUnit = Schema.fromJsonString(TranscriptUnit.Unit)

const eventLoop = Effect.yieldNow

const eventually = <A>(effect: Effect.Effect<A>, predicate: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = yield* effect
      if (predicate(value)) return value
      yield* eventLoop
    }
    return yield* Effect.die("Expected PostgreSQL projection state was not observed")
  })

const state = (status: "running" | "completed") => ({
  status,
  usage: ExecutionProjection.emptyUsageState(),
  steering: { steeringMessages: 0, followUpMessages: 0 },
})

it.effect.skipIf(databaseUrl === "")("resumes hosted projection from its PostgreSQL checkpoint", () =>
  Effect.gen(function* () {
    const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
    const database = `rika_hosted_projection_${suffix}`
    const admin = new Pool({ connectionString: databaseUrl })
    yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
    const parsed = new URL(databaseUrl)
    parsed.pathname = `/${database}`
    const url = parsed.toString()
    const pool = new Pool({ connectionString: url })
    try {
      for (const migration of [...identityMigrations, ...productMigrations]) {
        const sql = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readFileString(migration.url.pathname),
        )
        yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
      }
      const route = yield* Schema.encodeEffect(JsonRoute)(ExecutionRoute.testExecutionRoute())
      const link = yield* Schema.encodeEffect(JsonLink)({
        runId: "projection-run",
        threadId: "projection-thread",
        turnId: "projection-turn",
      })
      yield* Effect.tryPromise(() =>
        pool.query(
          `INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
             VALUES ('projection-user','Projection','projection@example.test',true,now(),now());
           INSERT INTO rika_hosted_owners (id,kind,user_id,organization_id)
             VALUES ('projection-owner','personal','projection-user',NULL);
           INSERT INTO rika_workspaces (owner_id,path,created_at)
             VALUES ('projection-owner','projection-workspace',1);
           INSERT INTO rika_threads (id,owner_id,workspace,title,created_at,updated_at)
             VALUES ('projection-thread','projection-owner','projection-workspace','Projection',1,1)`,
        ),
      )
      yield* Effect.tryPromise(() =>
        pool.query(
          `INSERT INTO rika_turns
             (id,thread_id,prompt,status,created_at,updated_at,execution_route_json,execution_link_json)
             VALUES ('projection-turn','projection-thread','project', 'running',2,2,$1,$2)`,
          [route, link],
        ),
      )
      const unitKey = "assistant:projection"
      const running: ExecutionProjection.Change = {
        _tag: "ProjectionSnapshot",
        revision: 0,
        checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "cursor-running", state: "{}" },
        units: [
          {
            key: unitKey,
            turnId: "projection-turn",
            order: TranscriptOrdering.unitOrder(unitKey, 0),
            revision: 0,
            content: { _tag: "Entry", role: "assistant", text: "partial" },
          },
        ],
        hasOlder: false,
        state: state("running"),
      }
      const completed: ExecutionProjection.Change = {
        _tag: "ProjectionPatch",
        baseRevision: 0,
        revision: 1,
        checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "cursor-completed", state: "{}" },
        upsert: [
          {
            key: unitKey,
            turnId: "projection-turn",
            order: TranscriptOrdering.unitOrder(unitKey, 0),
            revision: 1,
            content: { _tag: "Entry", role: "assistant", text: "complete" },
          },
        ],
        remove: [],
        state: state("completed"),
      }
      const cursors = new Array<string | undefined>()
      const gatewayBase = Context.get(yield* Layer.build(ExecutionGateway.layerTest()), ExecutionGateway.Service)
      const build = (gateway: ExecutionGateway.Interface, scope: Scope.Scope) =>
        Layer.buildWithScope(
          Layer.merge(
            hostedProjectionWorkerLayer({ concurrency: 2, pollIntervalMillis: 10 }),
            hostedExecutionReconcilerLayer({ pollIntervalMillis: 10 }),
          ).pipe(
            Layer.provide(ProductRepositories.projectionLayer),
            Layer.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 4 })),
            Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
          ),
          scope,
        )
      const firstScope = yield* Scope.make()
      yield* build(
        ExecutionGateway.Service.of({
          ...gatewayBase,
          watchTurn: (_link, input) => {
            cursors.push(input?.checkpoint?.cursor)
            return Stream.concat(Stream.succeed(running), Stream.never)
          },
          inspectTurn: () => Effect.succeed({ status: "running", cursor: "cursor-running" }),
        }),
        firstScope,
      )
      yield* eventually(
        Effect.tryPromise(() =>
          pool.query(`SELECT projector_cursor FROM rika_transcript_checkpoints WHERE turn_id = 'projection-turn'`),
        ),
        (result) => result.rows[0]?.projector_cursor === "cursor-running",
      )
      yield* Scope.close(firstScope, Exit.void)
      expect(cursors).toEqual([undefined])

      const secondScope = yield* Scope.make()
      yield* build(
        ExecutionGateway.Service.of({
          ...gatewayBase,
          watchTurn: (_link, input) => {
            cursors.push(input?.checkpoint?.cursor)
            return Stream.succeed(completed)
          },
          inspectTurn: () => Effect.succeed({ status: "completed", cursor: "cursor-completed" }),
        }),
        secondScope,
      )
      const persisted = yield* eventually(
        Effect.tryPromise(() =>
          pool.query(`SELECT turn_record.status, checkpoint.revision, checkpoint.projector_cursor,
              unit_record.unit_json
            FROM rika_turns turn_record
            JOIN rika_transcript_checkpoints checkpoint ON checkpoint.turn_id = turn_record.id
            JOIN rika_transcript_units unit_record ON unit_record.turn_id = turn_record.id
            WHERE turn_record.id = 'projection-turn'`),
        ),
        (result) =>
          result.rows[0]?.status === "completed" &&
          result.rows[0]?.revision === 1 &&
          result.rows[0]?.projector_cursor === "cursor-completed",
      )
      yield* Scope.close(secondScope, Exit.void)
      expect(cursors).toEqual([undefined, "cursor-running"])
      expect(persisted.rows[0]).toMatchObject({
        status: "completed",
        revision: 1,
        projector_cursor: "cursor-completed",
      })
      expect(yield* Schema.decodeUnknownEffect(JsonUnit)(String(persisted.rows[0].unit_json))).toMatchObject({
        content: { text: "complete" },
      })
    } finally {
      yield* Effect.tryPromise(() => pool.end())
      yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
      yield* Effect.tryPromise(() => admin.end())
    }
  }).pipe(livePlatform),
)
