import * as PgClient from "@effect/sql-pg/PgClient"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as ExecutionRequest from "@rika/product/execution-request"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ThreadResult from "@rika/product/thread-result"
import * as Thread from "@rika/product/thread-record"
import * as TurnContract from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"
import { expect, it } from "@effect/vitest"
import { eq } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Config, DateTime, Effect, FileSystem, Layer, Random, Redacted } from "effect"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import { identityUser } from "../../../../identity/src/database/account-schema"
import { identityMigrations } from "../../../../identity/src/database/migrations"
import { runMigration } from "../../../../identity/src/database/postgres"
import { rikaHostedOwners, rikaThreads, rikaTurns, rikaWorkspaces } from "../../../src/database/schema/product"
import { migrations } from "../../../src/hosted/migrations"
import * as TurnRepository from "../../../src/turn/postgres/repository"

const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })

type CurrentCreateInput = Omit<
  Parameters<TurnContract.Interface["createForSubmission"]>[0],
  "executionRoute" | "queueCapacity"
> & {
  readonly executionRoute?: ExecutionRouteSnapshot.ExecutionRouteSnapshot
  readonly queueCapacity?: number
}

const create = (repository: TurnContract.Interface, input: CurrentCreateInput) =>
  repository.createForSubmission({
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
    ...input,
    queueCapacity: input.queueCapacity ?? 128,
  })

it.effect("memory editQueued replaces content and clears stale prompt parts", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-edit")
    yield* create(repository, { id: Turn.TurnId.make("active"), threadId, prompt: "active", now: 1 })
    const queued = yield* create(repository, {
      id: Turn.TurnId.make("queued"),
      threadId,
      prompt: "old",
      promptParts: [{ type: "text", text: "old" }],
      now: 2,
    })
    yield* repository.editQueued(queued.id, "edited", 3)
    const stored = yield* repository.get(queued.id)
    expect(stored?.prompt).toBe("edited")
    expect(
      stored !== undefined && ThreadResult.TurnResult.isAgentExecution(stored) ? stored.promptParts : undefined,
    ).toBeUndefined()
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory setStatus forbids transitions into or out of queued", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-guard")
    const active = yield* create(repository, { id: Turn.TurnId.make("active"), threadId, prompt: "active", now: 1 })
    const queued = yield* create(repository, { id: Turn.TurnId.make("queued"), threadId, prompt: "queued", now: 2 })
    expect((yield* Effect.result(repository.setStatus(active.id, "queued", 3)))._tag).toBe("Failure")
    const before = yield* repository.readQueue(threadId)
    expect(before.queuedCount).toBe(1)
    expect((yield* Effect.result(repository.setStatus(queued.id, "completed", 4)))._tag).toBe("Failure")
    const after = yield* repository.readQueue(threadId)
    expect(after).toEqual(before)
    expect((yield* repository.get(queued.id))?.status).toBe("queued")
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory seeds queue revision to match the seeded queued count", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const snapshot = yield* repository.readQueue(Thread.ThreadId.make("thread-seed"))
    expect(snapshot.queuedCount).toBe(2)
    expect(snapshot.revision).toBe(2)
  }).pipe(
    provideLayer(
      TurnRepository.memoryLayer([
        {
          _tag: "AgentExecution",
          id: Turn.TurnId.make("s1"),
          threadId: Thread.ThreadId.make("thread-seed"),
          prompt: "one",
          status: "queued",
          executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          createdAt: 1,
          updatedAt: 1,
        },
        {
          _tag: "AgentExecution",
          id: Turn.TurnId.make("s2"),
          threadId: Thread.ThreadId.make("thread-seed"),
          prompt: "two",
          status: "queued",
          executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          createdAt: 2,
          updatedAt: 2,
        },
      ]),
    ),
  ),
)

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

const isolated = <A, E, R>(run: (url: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const database = `rika_turn_repository_${Math.abs(yield* Random.nextInt)}_${Math.abs(yield* Random.nextInt)}`
    const admin = new Pool({ connectionString: databaseUrl })
    yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
    const parsed = new URL(databaseUrl)
    parsed.pathname = `/${database}`
    const url = parsed.toString()
    const pool = new Pool({ connectionString: url })
    try {
      for (const migration of [...identityMigrations, ...migrations]) {
        const sql = yield* readFileString(migration.url)
        yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
      }
      return yield* run(url)
    } finally {
      yield* Effect.tryPromise(() => pool.end())
      yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
      yield* Effect.tryPromise(() => admin.end())
    }
  })

const postgresLayer = (url: string) => {
  const postgres = PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })
  return TurnRepository.layer.pipe(Layer.provideMerge(postgres))
}

it.effect.skipIf(databaseUrl === "")("runs the turn repository contract against isolated PostgreSQL", () =>
  isolated((url) =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(postgresLayer(url))
        yield* Effect.gen(function* () {
          const repository = yield* TurnRepository.Service
          const db = yield* PgDrizzle.makeWithDefaults()
          const ownerId = "turn-contract-owner"
          const workspace = "/turn-contract"
          const threadId = Thread.ThreadId.make("turn-contract-main")
          const pageThreadId = Thread.ThreadId.make("turn-contract-page")
          const malformedThreadId = Thread.ThreadId.make("turn-contract-malformed")
          const now = DateTime.toDate(DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"))

          yield* db.insert(identityUser).values({
            id: "turn-contract-user",
            name: "Turn Contract",
            email: "turn-contract@example.test",
            emailVerified: true,
            createdAt: now,
            updatedAt: now,
          })
          yield* db.insert(rikaHostedOwners).values({ id: ownerId, kind: "personal", userId: "turn-contract-user" })
          yield* db.insert(rikaWorkspaces).values({ ownerId, path: workspace, createdAt: 1 })
          yield* db.insert(rikaThreads).values(
            [threadId, pageThreadId, malformedThreadId].map((id) => ({
              id,
              ownerId,
              workspace,
              title: id,
              createdAt: 1,
              updatedAt: 1,
            })),
          )

          const promptParts: ReadonlyArray<ExecutionRequest.PromptPart> = [
            { type: "text", text: "inspect " },
            { type: "image", mediaType: "image/png", data: "cG5n", filename: "shot.png" },
          ]
          const active = yield* create(repository, {
            id: Turn.TurnId.make("turn-active"),
            threadId,
            prompt: "inspect [Image 1]",
            promptParts,
            now: 1,
          })
          const queued = yield* create(repository, {
            id: Turn.TurnId.make("turn-queued"),
            threadId,
            prompt: "queued",
            now: 2,
          })
          const dequeued = yield* create(repository, {
            id: Turn.TurnId.make("turn-dequeued"),
            threadId,
            prompt: "dequeue",
            now: 3,
          })

          expect(active).toMatchObject({ status: "accepted", promptParts })
          const storedActive = yield* repository.get(active.id)
          expect(
            storedActive !== undefined && ThreadResult.TurnResult.isAgentExecution(storedActive)
              ? storedActive.promptParts
              : undefined,
          ).toEqual(promptParts)
          expect(yield* repository.get(Turn.TurnId.make("missing"))).toBeUndefined()
          expect((yield* repository.list(threadId)).map((turn) => turn.id)).toEqual([active.id, queued.id, dequeued.id])
          const persisted = yield* db
            .select({ promptPartsJson: rikaTurns.promptPartsJson })
            .from(rikaTurns)
            .where(eq(rikaTurns.id, active.id))
          expect(persisted[0]?.promptPartsJson).not.toBeNull()

          expect((yield* repository.findActive(threadId))?.id).toBe(active.id)
          expect(yield* repository.findActive(pageThreadId)).toBeUndefined()
          expect(yield* repository.readQueue(threadId)).toMatchObject({
            revision: 2,
            queuedCount: 2,
            turns: [{ id: queued.id }, { id: dequeued.id }],
          })
          expect((yield* repository.listNonterminal).map((turn) => turn.id)).toEqual([
            active.id,
            queued.id,
            dequeued.id,
          ])

          expect((yield* Effect.result(repository.setStatus(active.id, "queued", 4)))._tag).toBe("Failure")
          expect((yield* Effect.result(repository.setStatus(queued.id, "completed", 4)))._tag).toBe("Failure")
          expect((yield* Effect.result(repository.setStatus(Turn.TurnId.make("missing"), "failed", 4)))._tag).toBe(
            "Failure",
          )
          yield* repository.setStatus(active.id, "running", 4)
          yield* repository.setStatus(active.id, "completed", 5)
          expect((yield* repository.get(active.id))?.status).toBe("completed")

          const claim = yield* repository.claimNextQueued(threadId, 6)
          if (claim === undefined) return yield* Effect.die("Expected queued claim")
          expect(claim.turn.id).toBe(queued.id)
          expect(yield* repository.claimNextQueued(threadId, 7)).toBeUndefined()
          const edited = yield* repository.editQueued(queued.id, "edited", 8)
          expect(edited).toMatchObject({ prompt: "edited", queue: { revision: 3, queuedCount: 2 } })
          expect(edited.promptParts).toBeUndefined()
          expect(yield* repository.finishQueuedClaim(claim, "running", 9)).toEqual({ _tag: "Unavailable" })
          const replacement = yield* repository.claimNextQueued(threadId, 10)
          if (replacement === undefined) return yield* Effect.die("Expected replacement claim")
          expect((yield* repository.finishQueuedClaim(replacement, "running", 11))._tag).toBe("Transitioned")
          expect((yield* repository.get(queued.id))?.status).toBe("running")
          expect(yield* repository.dequeue(dequeued.id)).toMatchObject({ revision: 5, queuedCount: 0 })
          expect(yield* repository.get(dequeued.id)).toBeUndefined()
          expect((yield* Effect.result(repository.dequeue(dequeued.id)))._tag).toBe("Failure")

          const pageIds: Array<Turn.TurnId> = []
          for (let index = 1; index <= 4; index++) {
            const turn = yield* create(repository, {
              id: Turn.TurnId.make(`page-${index}`),
              threadId: pageThreadId,
              prompt: `page ${index}`,
              now: index,
            })
            pageIds.push(turn.id)
            yield* repository.setStatus(turn.id, "completed", index)
          }
          const newest = yield* repository.page(pageThreadId, { limit: 2 })
          const older = yield* repository.page(pageThreadId, { before: newest.oldestCursor, limit: 2 })
          expect(newest.turns.map((turn) => turn.id)).toEqual(pageIds.slice(2))
          expect(newest.hasOlder).toBe(true)
          expect(older.turns.map((turn) => turn.id)).toEqual(pageIds.slice(0, 2))
          expect(older.hasOlder).toBe(false)

          const malformed = yield* create(repository, {
            id: Turn.TurnId.make("turn-malformed"),
            threadId: malformedThreadId,
            prompt: "malformed",
            now: 1,
          })
          yield* db.update(rikaTurns).set({ executionRouteJson: "{" }).where(eq(rikaTurns.id, malformed.id))
          const malformedResult = yield* Effect.result(repository.get(malformed.id))
          expect(malformedResult).toMatchObject({ _tag: "Failure", failure: { _tag: "TurnRepositoryError" } })
        }).pipe(Effect.provide(context))
      }),
    ),
  ),
)
