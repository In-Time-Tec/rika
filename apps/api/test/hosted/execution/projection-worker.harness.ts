import * as PgClient from "@effect/sql-pg/PgClient"
import { expect, it } from "@effect/vitest"
import { identityMigrations, identityUser, runMigration } from "@rika/identity"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import {
  rikaHostedOwners,
  rikaHostedThreads,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaTranscriptCheckpoints,
  rikaTranscriptUnits,
  rikaTurnSteeringOutbox,
  rikaTurns,
  rikaWorkspaces,
} from "@rika/product-store/database-schema"
import * as ProductRepositories from "@rika/product-store/product-repositories"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import {
  FileSystem,
  Config,
  Context,
  DateTime,
  Effect,
  Exit,
  Layer,
  Queue,
  Random,
  Redacted,
  Schema,
  Scope,
  Stream,
} from "effect"
import { eq } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { live as livePlatform } from "../../support/live-platform"
import { layer as hostedExecutionReconcilerLayer } from "../../../src/hosted/execution/reconciler"
import { layer as hostedProjectionWorkerLayer } from "../../../src/hosted/execution/projection-worker"
import { HostedPreviewBus } from "../../../src/hosted/thread/previews"
import { HostedWorkerListener, layer as hostedWorkerListenerLayer } from "../../../src/hosted/worker-listener"
import {
  layerTest as hostedWorkerRuntimeLayerTest,
  workerNotificationChannel,
} from "../../../src/hosted/worker-runtime"

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
    const db = drizzle({ client: pool })
    try {
      for (const migration of [...identityMigrations, ...productMigrations]) {
        const sql = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readFileString(migration.url.pathname),
        )
        yield* runMigration({
          pool,
          id: migration.id,
          checksum: migration.checksum,
          sql,
        })
      }
      const aggregateContext = yield* Layer.build(PgClient.layer({ url: Redacted.make(url), maxConnections: 4 }))
      const aggregateDatabase = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideContext(aggregateContext))
      const notificationScope = yield* Scope.make()
      const listenerContext = yield* Layer.buildWithScope(
        hostedWorkerListenerLayer(Redacted.make(url)),
        notificationScope,
      )
      const notifications = yield* Queue.unbounded<string>()
      const listening = yield* Queue.unbounded<void>()
      yield* Context.get(listenerContext, HostedWorkerListener).listen(
        workerNotificationChannel,
        (payload) => void Queue.offerUnsafe(notifications, payload),
        () => void Queue.offerUnsafe(listening, undefined),
      )
      yield* Queue.take(listening)
      const route = yield* Schema.encodeEffect(JsonRoute)(ExecutionRoute.testExecutionRoute())
      const link = yield* Schema.encodeEffect(JsonLink)({
        runId: "projection-run",
        threadId: "projection-thread",
        turnId: "projection-turn",
      })
      const now = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        db.insert(identityUser).values({
          id: "projection-user",
          name: "Projection",
          email: "projection@example.test",
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        }),
      )
      yield* Effect.tryPromise(() =>
        db.insert(rikaHostedOwners).values({ id: "projection-owner", kind: "personal", userId: "projection-user" }),
      )
      yield* aggregateDatabase.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(rikaHostedWorkspaces).values({
            id: "projection-workspace",
            ownerId: "projection-owner",
            createdByUserId: "projection-user",
            executorKind: "orb",
            inheritProjectGrants: false,
            createdAt: now,
          })
          yield* tx
            .insert(rikaWorkspaces)
            .values({ ownerId: "projection-owner", path: "projection-workspace", createdAt: 1 })
          yield* tx.insert(rikaHostedThreads).values({
            id: "projection-thread",
            ownerId: "projection-owner",
            workspaceId: "projection-workspace",
            createdByUserId: "projection-user",
            executorKind: "orb",
            inheritProjectGrants: false,
            createdAt: now,
          })
          yield* tx.insert(rikaThreads).values({
            id: "projection-thread",
            ownerId: "projection-owner",
            workspace: "projection-workspace",
            title: "Projection",
            createdAt: 1,
            updatedAt: 1,
          })
        }),
      )
      yield* Effect.tryPromise(() =>
        db.insert(rikaTurns).values({
          id: "projection-turn",
          threadId: "projection-thread",
          prompt: "project",
          status: "running",
          createdAt: 2,
          updatedAt: 2,
          executionRouteJson: route,
          executionLinkJson: link,
        }),
      )
      expect(
        yield* Effect.all([Queue.take(notifications), Queue.take(notifications), Queue.take(notifications)]),
      ).toEqual(["turn", "projection", "reconciliation"])
      yield* Effect.tryPromise(() =>
        db.insert(rikaTurnSteeringOutbox).values({
          requestId: "projection-steering",
          targetTurnId: "projection-turn",
          threadId: "projection-thread",
          admissionJson: "{}",
          sourceWithdrawn: 0,
          status: "pending",
          preparedAt: 3,
        }),
      )
      expect(yield* Queue.take(notifications)).toBe("reconciliation")
      yield* Effect.tryPromise(() =>
        db.delete(rikaTurnSteeringOutbox).where(eq(rikaTurnSteeringOutbox.requestId, "projection-steering")),
      )
      expect(yield* Queue.take(notifications)).toBe("reconciliation")
      yield* Scope.close(notificationScope, Exit.void)
      const unitKey = "assistant:projection"
      const running: ExecutionProjection.Change = {
        _tag: "ProjectionSnapshot",
        revision: 0,
        checkpoint: {
          version: ExecutionProjection.projectionVersion,
          cursor: "cursor-running",
          state: "{}",
        },
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
        checkpoint: {
          version: ExecutionProjection.projectionVersion,
          cursor: "cursor-completed",
          state: "{}",
        },
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
            hostedProjectionWorkerLayer({
              concurrency: 2,
              fallbackIntervalMillis: 10,
            }).pipe(Layer.provide(HostedPreviewBus.memoryLayer)),
            hostedExecutionReconcilerLayer({ fallbackIntervalMillis: 10 }),
          ).pipe(
            Layer.provide(hostedWorkerRuntimeLayerTest),
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
          db
            .select({ projectorCursor: rikaTranscriptCheckpoints.projectorCursor })
            .from(rikaTranscriptCheckpoints)
            .where(eq(rikaTranscriptCheckpoints.turnId, "projection-turn")),
        ),
        (result) => result[0]?.projectorCursor === "cursor-running",
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
          inspectTurn: () =>
            Effect.succeed({
              status: "completed",
              cursor: "cursor-completed",
            }),
        }),
        secondScope,
      )
      const persisted = yield* eventually(
        Effect.tryPromise(() =>
          db
            .select({
              status: rikaTurns.status,
              revision: rikaTranscriptCheckpoints.revision,
              projector_cursor: rikaTranscriptCheckpoints.projectorCursor,
              unit_json: rikaTranscriptUnits.unitJson,
            })
            .from(rikaTurns)
            .innerJoin(rikaTranscriptCheckpoints, eq(rikaTranscriptCheckpoints.turnId, rikaTurns.id))
            .innerJoin(rikaTranscriptUnits, eq(rikaTranscriptUnits.turnId, rikaTurns.id))
            .where(eq(rikaTurns.id, "projection-turn")),
        ),
        (result) =>
          result[0]?.status === "completed" &&
          result[0]?.revision === 1 &&
          result[0]?.projector_cursor === "cursor-completed",
      )
      yield* Scope.close(secondScope, Exit.void)
      expect(cursors).toEqual([undefined, "cursor-running"])
      expect(persisted[0]).toMatchObject({
        status: "completed",
        revision: 1,
        projector_cursor: "cursor-completed",
      })
      expect(yield* Schema.decodeEffect(JsonUnit)(String(persisted[0]?.unit_json))).toMatchObject({
        content: { text: "complete" },
      })
    } finally {
      yield* Effect.tryPromise(() => pool.end())
      yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
      yield* Effect.tryPromise(() => admin.end())
    }
  }).pipe(livePlatform),
)
