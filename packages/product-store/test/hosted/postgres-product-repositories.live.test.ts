import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
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
import { expect, it } from "@effect/vitest"
import { Effect, Layer, Random, Redacted } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { Pool } from "pg"
import { identityMigrations } from "../../../identity/src/migrations"
import { runMigration } from "../../../identity/src/postgres"
import * as ProductRepositories from "../../src/database/postgres-product-repositories"
import { migrations } from "../../src/hosted/migrations"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL
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
      const sql = yield* Effect.promise(() => Bun.file(migration.url).text())
      yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
    }
    return pool
  })

const repositoryLayer = (url: string, ownerId: OwnerId) => {
  const postgres = PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })
  return ProductRepositories.layer(ownerId).pipe(Layer.provideMerge(postgres))
}

it.effect.skipIf(databaseUrl === undefined)(
  "runs product repository contracts against owner-scoped PostgreSQL state",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = `rika_product_${Math.abs(yield* Random.nextInt)}`
        const admin = new Pool({ connectionString: databaseUrl })
        yield* Effect.promise(() => admin.query(`CREATE DATABASE "${database}"`))
        const parsed = new URL(databaseUrl!)
        parsed.pathname = `/${database}`
        const url = parsed.toString()
        let migrated: Pool | undefined
        try {
          migrated = yield* applyMigrations(url)
          yield* Effect.promise(() =>
            migrated!.query(`
              INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES
                ('product-personal-user','Personal','product-personal@example.test',true,now(),now()),
                ('product-org-user','Org','product-org@example.test',true,now(),now());
              INSERT INTO organization (id,name,slug,created_at)
                VALUES ('product-org','Product Org','product-org',now());
              INSERT INTO rika_hosted_owners (id,kind,user_id,organization_id) VALUES
                ('product-personal-owner','personal','product-personal-user',NULL),
                ('product-organization-owner','organization',NULL,'product-org');
            `),
          )
          const personal = yield* Layer.build(repositoryLayer(url, personalOwner))
          const organization = yield* Layer.build(repositoryLayer(url, organizationOwner))

          yield* Effect.gen(function* () {
            const threads = yield* ThreadRepository.Service
            const turns = yield* TurnRepository.Service
            const summaries = yield* ThreadSummaryRepository.Service
            const transcripts = yield* TranscriptRepository.Service
            const goals = yield* GoalRepository.Service
            const sql = yield* SqlClient

            yield* threads.create({ id: threadId, workspace: "/work/product", title: "Product", now: 1 })
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

            yield* sql`CREATE FUNCTION reject_product_thread() RETURNS TRIGGER LANGUAGE plpgsql AS $$
              BEGIN RAISE EXCEPTION 'injected product thread failure'; END $$`
            yield* sql`CREATE TRIGGER reject_product_thread BEFORE INSERT ON rika_threads
              FOR EACH ROW EXECUTE FUNCTION reject_product_thread()`
            const rollbackThread = Thread.ThreadId.make("product-rollback")
            expect(
              yield* Effect.result(
                threads.create({ id: rollbackThread, workspace: "/work/rollback", title: "Rejected", now: 30 }),
              ),
            ).toMatchObject({ _tag: "Failure", failure: { _tag: "ThreadRepositoryError" } })
            expect(
              yield* sql`SELECT path FROM rika_workspaces
                WHERE owner_id = ${personalOwner} AND path = '/work/rollback'`,
            ).toEqual([])
            yield* sql`DROP TRIGGER reject_product_thread ON rika_threads`
            yield* sql`DROP FUNCTION reject_product_thread()`

            expect(yield* ThreadRepository.Service.pipe(Effect.provide(organization))).toEqual(
              expect.objectContaining({}),
            )
            expect(
              yield* ThreadRepository.Service.pipe(
                Effect.flatMap((repository) => repository.get(threadId)),
                Effect.provide(organization),
              ),
            ).toBeUndefined()

            yield* threads.requestDeletion(threadId, 31)
            expect(yield* threads.get(threadId)).toBeUndefined()
            expect(yield* threads.pendingDeletions).toEqual([{ threadId, requestedAt: 31 }])
            yield* threads.completeDeletion(threadId)
            expect(yield* sql`SELECT id FROM rika_turns WHERE thread_id = ${threadId}`).toEqual([])
            expect(yield* sql`SELECT thread_id FROM rika_goals WHERE thread_id = ${threadId}`).toEqual([])
          }).pipe(Effect.provide(personal))
        } finally {
          if (migrated !== undefined) yield* Effect.promise(() => migrated!.end())
          yield* Effect.promise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
          yield* Effect.promise(() => admin.end())
        }
      }),
    ),
)
