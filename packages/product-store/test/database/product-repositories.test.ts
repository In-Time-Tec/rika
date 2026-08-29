import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as GoalRepository from "@rika/product/goal-repository"
import { OwnerId } from "@rika/product/hosted-model"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as UnitOrder from "@rika/transcript/transcript-unit-order"
import * as PgClient from "@effect/sql-pg/PgClient"
import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Config, DateTime, Effect, FileSystem, Layer, Random, Redacted } from "effect"
import { eq, sql as drizzleSql } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { drizzle } from "drizzle-orm/node-postgres"
import { fileURLToPath } from "node:url"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { Pool } from "pg"
import { identityMigrations } from "../../../identity/src/database/migrations"
import { runMigration } from "../../../identity/src/database/postgres"
import * as ProductRepositories from "../../src/database/product-repositories"
import { migrations } from "../../src/hosted/migrations"
import { identityOrganization, identityUser } from "@rika/identity"
import * as schema from "../../src/database/schema/product"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const readFileString = (url: URL) =>
  Effect.scoped(
    Layer.build(BunServices.layer).pipe(
      Effect.flatMap((context) =>
        Effect.provide(
          Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFileString(fileURLToPath(url))),
          context,
        ),
      ),
    ),
  )
const personalOwner = OwnerId.make("product-personal-owner")
const organizationOwner = OwnerId.make("product-organization-owner")
const threadId = Thread.ThreadId.make("product-thread")

const createTurn = (
  turns: TurnRepository.Interface,
  input: {
    readonly id: string
    readonly threadId: Thread.ThreadId
    readonly prompt: string
    readonly queueCapacity?: number
    readonly now: number
  },
) =>
  turns.createForSubmission({
    ...input,
    id: Turn.TurnId.make(input.id),
    queueCapacity: input.queueCapacity ?? 128,
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  })

const applyMigrations = (url: string) =>
  Effect.gen(function* () {
    const pool = yield* Effect.sync(() => new Pool({ connectionString: url }))
    for (const migration of [...identityMigrations, ...migrations]) {
      const sql = yield* readFileString(migration.url)
      yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
    }
    return pool
  })

const repositoryLayer = (url: string, ownerId: OwnerId) => {
  const postgres = PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })
  return ProductRepositories.layer(ownerId).pipe(Layer.provideMerge(postgres))
}

it.effect.skipIf(databaseUrl === "")("runs product repository contracts against owner-scoped PostgreSQL state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = `rika_product_${Math.abs(yield* Random.nextInt)}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      let migrated: Pool | undefined
      try {
        migrated = yield* applyMigrations(url)
        const db = drizzle({ client: migrated })
        const now = drizzleSql`now()`
        yield* Effect.tryPromise(() =>
          db.insert(identityUser).values([
            {
              id: "product-personal-user",
              name: "Personal",
              email: "product-personal@example.test",
              emailVerified: true,
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "product-org-user",
              name: "Org",
              email: "product-org@example.test",
              emailVerified: true,
              createdAt: now,
              updatedAt: now,
            },
          ]),
        )
        yield* Effect.tryPromise(() =>
          db
            .insert(identityOrganization)
            .values({ id: "product-org", name: "Product Org", slug: "product-org", createdAt: now }),
        )
        yield* Effect.tryPromise(() =>
          db.insert(schema.rikaHostedOwners).values([
            { id: personalOwner, kind: "personal", userId: "product-personal-user" },
            { id: organizationOwner, kind: "organization", organizationId: "product-org" },
          ]),
        )
        const personal = yield* Layer.build(repositoryLayer(url, personalOwner))
        const aggregateDatabase = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideContext(personal))
        const seedAggregate = (id: Thread.ThreadId, workspace: string, title: string, createdAt: number) =>
          aggregateDatabase.transaction((tx) =>
            Effect.gen(function* () {
              const date = DateTime.toDate(DateTime.makeUnsafe(createdAt))
              yield* tx.insert(schema.rikaHostedWorkspaces).values({
                id: workspace,
                ownerId: personalOwner,
                createdByUserId: "product-personal-user",
                executorKind: "orb",
                inheritProjectGrants: false,
                createdAt: date,
              })
              yield* tx.insert(schema.rikaWorkspaces).values({ ownerId: personalOwner, path: workspace, createdAt })
              yield* tx.insert(schema.rikaHostedThreads).values({
                id,
                ownerId: personalOwner,
                workspaceId: workspace,
                createdByUserId: "product-personal-user",
                executorKind: "orb",
                inheritProjectGrants: false,
                createdAt: date,
              })
              yield* tx.insert(schema.rikaThreads).values({
                id,
                ownerId: personalOwner,
                workspace,
                title,
                createdAt,
                updatedAt: createdAt,
              })
            }),
          )
        yield* seedAggregate(threadId, "/work/product", "Product", 1)
        const organization = yield* Layer.build(repositoryLayer(url, organizationOwner))

        yield* Effect.gen(function* () {
          const threads = yield* ThreadRepository.Service
          const turns = yield* TurnRepository.Service
          const summaries = yield* ThreadSummaryRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          const goals = yield* GoalRepository.Service
          const sql = yield* SqlClient

          const active = yield* createTurn(turns, {
            id: "product-active",
            threadId,
            prompt: "active",
            now: 2,
          })
          yield* turns.setStatus(active.id, "running", 3)

          const attempts = yield* Effect.forEach(
            Array.from({ length: 6 }, (_, index) => index),
            (index) =>
              Effect.result(
                createTurn(turns, {
                  id: `product-queued-${index}`,
                  threadId,
                  prompt: `queued ${index}`,
                  queueCapacity: 2,
                  now: 4 + index,
                }),
              ),
            { concurrency: "unbounded" },
          )
          expect(attempts.filter((attempt) => attempt._tag === "Success")).toHaveLength(2)
          expect(attempts.filter((attempt) => attempt._tag === "Failure")).toHaveLength(4)
          expect(yield* turns.readQueue(threadId)).toMatchObject({ revision: 2, queuedCount: 2 })

          yield* turns.setStatus(active.id, "completed", 20)
          const claims = yield* Effect.forEach(Array.from({ length: 8 }), () => turns.claimNextQueued(threadId, 21), {
            concurrency: "unbounded",
          })
          expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1)
          const claim = claims.find((candidate) => candidate !== undefined)
          if (claim === undefined) return yield* Effect.die("PostgreSQL queue did not return its claim")
          expect(yield* turns.finishQueuedClaim(claim, "running", 22)).toMatchObject({
            _tag: "Transitioned",
            queue: { revision: 3, queuedCount: 1 },
          })

          for (const turn of yield* turns.list(threadId)) yield* summaries.ensureTurn(turn.id, threadId, 22)
          yield* summaries.replaceTurn({
            turnId: active.id,
            threadId,
            projectedCursor: "cursor-1",
            complete: true,
            editTotals: { added: 3, modified: 2, removed: 1 },
            lastEventAt: 23,
            now: 23,
          })
          expect(yield* summaries.list()).toMatchObject([
            {
              id: threadId,
              status: "running",
              editTotals: { added: 3, modified: 2, removed: 1 },
            },
          ])

          const key = "assistant:product-active"
          yield* transcripts.replaceUnits(active, [
            {
              key,
              turnId: active.id,
              order: UnitOrder.unitOrder(key, 0),
              revision: 0,
              content: { _tag: "Entry", role: "assistant", text: "persisted" },
            },
          ])
          expect(yield* transcripts.get(active.id)).toMatchObject({
            turn: { id: active.id },
            units: [{ key, content: { text: "persisted" } }],
          })
          expect(yield* transcripts.page(threadId, { limit: 10 })).toMatchObject({
            entries: [{ turn: { id: active.id }, unit: { key } }],
            hasOlder: false,
            hasNewer: false,
          })

          yield* sql`UPDATE rika_transcript_checkpoints
              SET projection_version = ${ExecutionProjection.projectionVersion - 1},
                  projector_version = ${ExecutionProjection.projectionVersion - 1},
                  projector_cursor = 'obsolete',
                  projector_state = '{}',
                  revision = 99
              WHERE turn_id = ${active.id}`
          const obsoleteKey = "assistant:obsolete"
          yield* sql`UPDATE rika_transcript_units
              SET unit_key = ${obsoleteKey},
                  unit_order_key = ${UnitOrder.encodeUnitOrder(UnitOrder.unitOrder(obsoleteKey, 0))},
                  unit_json = '{}'
              WHERE turn_id = ${active.id}`
          expect(yield* transcripts.get(active.id)).toBeUndefined()
          const completedActive = yield* turns.get(active.id)
          if (completedActive?._tag !== "AgentExecution")
            return yield* Effect.die("Expected the completed PostgreSQL Turn")
          expect(
            yield* transcripts.commitProjection(completedActive, {
              _tag: "ProjectionSnapshot",
              revision: 1,
              checkpoint: {
                version: ExecutionProjection.projectionVersion,
                cursor: "reprojected",
                state: "{}",
              },
              units: [
                {
                  key,
                  turnId: active.id,
                  order: UnitOrder.unitOrder(key, 0),
                  revision: 1,
                  content: { _tag: "Entry", role: "assistant", text: "reprojected" },
                },
              ],
              hasOlder: true,
              state: {
                status: "completed",
                usage: ExecutionProjection.emptyUsageState(),
                steering: { steeringMessages: 0, followUpMessages: 0 },
              },
            }),
          ).toBe("committed")
          expect(yield* transcripts.get(active.id)).toMatchObject({
            revision: 1,
            projectionVersion: ExecutionProjection.projectionVersion,
            units: [{ key, content: { text: "reprojected" } }],
          })
          expect((yield* transcripts.get(active.id))?.units.map((unit) => unit.key)).toEqual([key])

          const goal = {
            threadId,
            objective: "prove PostgreSQL",
            status: "active" as const,
            budget: { tokens: 100 },
            usage: { tokens: 10, elapsedMillis: 20, turns: 1 },
            startedAtMillis: 1,
            updatedAtMillis: 2,
          }
          expect(yield* goals.claim(goal)).toEqual(goal)
          expect(yield* goals.claim({ ...goal, objective: "conflict" })).toBeUndefined()

          expect(yield* ThreadRepository.Service.pipe(Effect.provide(organization))).toEqual(
            expect.objectContaining({}),
          )
          expect(
            yield* ThreadRepository.Service.pipe(
              Effect.flatMap((repository) => repository.get(threadId)),
              Effect.provide(organization),
            ),
          ).toBeUndefined()

          const cancellationThreadId = Thread.ThreadId.make("product-cancellation-thread")
          yield* seedAggregate(cancellationThreadId, "/work/product-cancellation", "Cancellation", 30)
          const cancelledBeforeLink = yield* createTurn(turns, {
            id: "product-cancel-before-link",
            threadId: cancellationThreadId,
            prompt: "cancel before link",
            now: 31,
          })
          yield* turns.setStatus(cancelledBeforeLink.id, "running", 32)
          expect(yield* turns.cancelUnlinked(cancelledBeforeLink.id, 33)).toBe(true)
          expect(yield* turns.get(cancelledBeforeLink.id)).toMatchObject({ status: "cancelled", updatedAt: 33 })

          yield* threads.requestDeletion(threadId, 34)
          expect(yield* threads.get(threadId)).toBeUndefined()
          expect(yield* threads.pendingDeletions).toEqual([{ threadId, requestedAt: 34 }])
          yield* threads.completeDeletion(threadId)
          expect(
            yield* Effect.tryPromise(() =>
              db
                .select({ id: schema.rikaHostedThreads.id })
                .from(schema.rikaHostedThreads)
                .where(eq(schema.rikaHostedThreads.id, threadId)),
            ),
          ).toEqual([])
          expect(
            yield* Effect.tryPromise(() =>
              db
                .select({ id: schema.rikaThreads.id })
                .from(schema.rikaThreads)
                .where(eq(schema.rikaThreads.id, threadId)),
            ),
          ).toEqual([])
          expect(
            yield* Effect.tryPromise(() =>
              db
                .select({ id: schema.rikaTurns.id })
                .from(schema.rikaTurns)
                .where(eq(schema.rikaTurns.threadId, threadId)),
            ),
          ).toEqual([])
          expect(
            yield* Effect.tryPromise(() =>
              db
                .select({ threadId: schema.rikaGoals.threadId })
                .from(schema.rikaGoals)
                .where(eq(schema.rikaGoals.threadId, threadId)),
            ),
          ).toEqual([])
        }).pipe(Effect.provide(personal))
      } finally {
        if (migrated !== undefined) yield* Effect.tryPromise(() => migrated!.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  ),
)
