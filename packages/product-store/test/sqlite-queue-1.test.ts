import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import {
  expect,
  test,
  BunServices,
  Effect,
  FileSystem,
  Layer,
  Schema,
  SqlClient,
  Database,
  Thread,
  ThreadRepository,
  ThreadSummaryRepository,
  TurnRepository,
  TurnContract,
  Turn,
  id,
  create,
  provideLayer,
} from "./sqlite-queue-support"

test("dequeue removes the queued turn activity from the materialized summary", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-summary-dequeue-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
        ThreadSummaryRepository.layer.pipe(Layer.provide(database)),
      )
      const context = yield* Layer.build(layer)
      yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        const summaries = yield* ThreadSummaryRepository.Service
        yield* threads.create({ id, workspace: "/work/a", title: "First", now: 1 })
        const active = yield* create(turns, {
          id: Turn.TurnId.make("active"),
          threadId: id,
          prompt: "active",
          now: 2,
        })
        yield* turns.setStatus(active.id, "running", "active-cursor", 3)
        const queued = yield* create(turns, {
          id: Turn.TurnId.make("queued"),
          threadId: id,
          prompt: "queued",
          now: 4,
        })
        yield* summaries.replaceTurn({
          turnId: active.id,
          threadId: id,
          projectedCursor: "active-cursor",
          complete: false,
          editTotals: { added: 3, modified: 2, removed: 1 },
          lastEventAt: 3,
          now: 3,
        })
        yield* summaries.replaceTurn({
          turnId: queued.id,
          threadId: id,
          complete: false,
          editTotals: { added: 7, modified: 5, removed: 4 },
          lastEventAt: 4,
          now: 4,
        })
        expect((yield* summaries.list())[0]?.editTotals).toEqual({ added: 10, modified: 7, removed: 5 })
        yield* turns.dequeue(queued.id)
        expect((yield* summaries.list())[0]?.editTotals).toEqual({ added: 3, modified: 2, removed: 1 })
      }).pipe(Effect.provide(context))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("concurrent SQLite submissions cannot exceed queue capacity and dequeue frees one slot", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-bounded-queue-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
      )
      yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        yield* threads.create({ id, workspace: "/work", title: "Bounded", now: 1 })
        yield* create(turns, {
          id: Turn.TurnId.make("active"),
          threadId: id,
          prompt: "active",
          queueCapacity: 3,
          now: 1,
        })
        const submitted = yield* Effect.forEach(
          Array.from({ length: 10 }, (_, index) => index),
          (index) =>
            Effect.result(
              create(turns, {
                id: Turn.TurnId.make(`bounded-${index}`),
                threadId: id,
                prompt: `bounded ${index}`,
                queueCapacity: 3,
                now: index + 2,
              }),
            ),
          { concurrency: "unbounded" },
        )
        const failures = submitted.filter((result) => result._tag === "Failure")
        expect(failures).toHaveLength(7)
        for (const result of failures)
          expect(result._tag === "Failure" ? result.failure : undefined).toEqual(
            TurnContract.QueueFull.make({ threadId: id, capacity: 3, count: 3 }),
          )
        const full = yield* turns.readQueue(id)
        expect(full).toMatchObject({ revision: 3, queuedCount: 3 })
        expect(yield* turns.list(id)).toHaveLength(4)
        const removed = full.turns[0]
        if (removed === undefined) return yield* Effect.die("Missing queued turn")
        yield* turns.dequeue(removed.id)
        const replacement = yield* create(turns, {
          id: Turn.TurnId.make("bounded-replacement"),
          threadId: id,
          prompt: "replacement",
          queueCapacity: 3,
          now: 20,
        })
        expect(replacement.queue).toMatchObject({ revision: 5, queuedCount: 3 })
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("SQLite queue copy, take, and accepted rollback stay atomic", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-queue-transactions-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
      )
      yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        const requeueThread = Thread.ThreadId.make("sqlite-requeue-thread")
        const copyThread = Thread.ThreadId.make("sqlite-copy-thread")
        yield* threads.create({ id: requeueThread, workspace: "/work", title: "Requeue", now: 1 })
        yield* threads.create({ id: copyThread, workspace: "/work", title: "Copy", now: 1 })

        const accepted = yield* create(turns, {
          id: Turn.TurnId.make("sqlite-requeue-accepted"),
          threadId: requeueThread,
          prompt: "accepted",
          now: 2,
        })
        expect(yield* turns.requeueAccepted(accepted.id, 1, 3)).toMatchObject({
          status: "queued",
          queue: { revision: 1, queuedCount: 1 },
        })
        expect((yield* turns.claimNextQueued(requeueThread, 4))?.turn.id).toBe(accepted.id)

        const copied = yield* turns.copy(
          {
            _tag: "AgentExecution",
            id: Turn.TurnId.make("sqlite-copied-queued"),
            threadId: copyThread,
            prompt: "copied",
            executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
            author: { _tag: "Human" },
            lineage: { _tag: "Original" },
            status: "queued",
            stopIntent: "none",
            createdAt: 2,
            updatedAt: 2,
          },
          1,
        )
        expect(copied).toMatchObject({ status: "queued", queue: { revision: 1, queuedCount: 1 } })
        const overflowId = Turn.TurnId.make("sqlite-copy-overflow")
        expect(
          yield* Effect.result(
            turns.copy(
              {
                _tag: "AgentExecution",
                id: overflowId,
                threadId: copyThread,
                prompt: "overflow",
                executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
                author: { _tag: "Human" },
                lineage: { _tag: "Original" },
                status: "queued",
                stopIntent: "none",
                createdAt: 3,
                updatedAt: 3,
              },
              1,
            ),
          ),
        ).toMatchObject({ _tag: "Failure", failure: { _tag: "TurnQueueFull", count: 1 } })
        expect(yield* turns.get(overflowId)).toBeUndefined()
        expect(yield* turns.takeQueued(copied.id)).toMatchObject({
          turn: { id: copied.id },
          queue: { revision: 2, queuedCount: 0 },
        })
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("concurrent queue submissions produce contiguous revisions and one coalesced wake", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-queue-stress-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
      )
      yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        yield* threads.create({ id, workspace: "/work", title: "Stress", now: 1 })
        const active = yield* create(turns, {
          id: Turn.TurnId.make("active"),
          threadId: id,
          prompt: "active",
          now: 1,
        })
        const submitted = yield* Effect.forEach(
          Array.from({ length: 4 }, (_, index) => index),
          (index) =>
            create(turns, {
              id: Turn.TurnId.make(`queued-${index.toString().padStart(3, "0")}`),
              threadId: id,
              prompt: `queued ${index}`,
              now: index + 2,
            }),
          { concurrency: "unbounded" },
        )
        expect(submitted.map((turn) => turn.queue?.revision).toSorted((left, right) => left! - right!)).toEqual([
          1, 2, 3, 4,
        ])
        const queue = yield* turns.readQueue(id)
        expect(queue).toMatchObject({ revision: 4, queuedCount: 4 })
        expect(queue.turns).toHaveLength(4)
        const wake = yield* turns.requestQueueWake(id)
        expect(wake).toEqual({ threadId: id, generation: 1, queueRevision: 4 })
        expect(yield* turns.requestQueueWake(id)).toEqual(wake)
        yield* turns.setStatus(active.id, "completed", undefined, 200)
        const claims = yield* Effect.forEach(Array.from({ length: 20 }), () => turns.claimNextQueued(id, 201), {
          concurrency: "unbounded",
        })
        expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1)
        expect(yield* turns.readQueue(id)).toMatchObject({ revision: 4, queuedCount: 4 })
        yield* turns.resetQueueClaims
        const claimed = yield* turns.claimNextQueued(id, 202)
        if (claimed === undefined) return yield* Effect.die("Missing claim after reset")
        const transitioned = yield* turns.finishQueuedClaim(claimed, "running", "cursor", undefined, 203)
        expect(transitioned).toMatchObject({
          _tag: "Transitioned",
          turn: { status: "running", lastCursor: "cursor" },
          queue: { revision: 5, queuedCount: 3 },
        })
        const sql = yield* SqlClient
        const plan = yield* sql`EXPLAIN QUERY PLAN SELECT * FROM rika_turns
          WHERE thread_id = ${id} AND status = 'queued'
          ORDER BY created_at ASC, id ASC LIMIT 1`
        const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ detail: Schema.String })))(plan)
        expect(decoded.map((row) => row.detail).join("\n")).toContain("rika_turns_queue")
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})
