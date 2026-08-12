import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnContract from "@rika/product/turn-repository"
import { Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Database from "../src/database/product-database-layer"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"

const threadId = Thread.ThreadId.make("steering-thread")
const otherThreadId = Thread.ThreadId.make("other-steering-thread")
const target = { runId: "target-run", threadId, turnId: Turn.TurnId.make("target-turn") }
const route = ExecutionRouteSnapshot.testExecutionRoute("high")

const source = (id: string, sourceThreadId = threadId): Turn.AgentExecutionTurn => ({
  _tag: "AgentExecution",
  id: Turn.TurnId.make(id),
  threadId: sourceThreadId,
  prompt: "same steering text",
  promptParts: [
    { type: "text", text: "inspect " },
    { type: "image", mediaType: "image/png", data: "cG5n", filename: "exact.png" },
  ],
  status: "queued",
  executionRoute: route,
  executionLink: { runId: `source-${id}`, threadId: sourceThreadId, turnId: Turn.TurnId.make(id) },
  author: { _tag: "Agent", sourceThreadId, sourceRootTurnId: "author-turn", threadCreationDepth: 2 },
  lineage: { _tag: "Retried", sourceTurnId: "parent-turn" },
  createdAt: 7,
  updatedAt: 11,
})

const targetTurn = (): Turn.AgentExecutionTurn => ({
  ...(({ promptParts: _promptParts, ...rest }) => rest)(source("target-turn")),
  prompt: "active",
  status: "running",
  executionLink: target,
})

const behavior = (repository: TurnContract.Interface) =>
  Effect.gen(function* () {
    yield* repository.copy(targetTurn(), 8)
    const first = source("source-a")
    yield* repository.copy(first, 8)
    const before = yield* repository.readQueue(threadId)

    const prepared = yield* repository.prepareQueuedSteeringAdmission(
      first.id,
      target,
      { text: first.prompt, idempotencyKey: "stable-a" },
      [],
      20,
    )
    expect(yield* repository.get(first.id)).toBeUndefined()
    expect(prepared.queueChanged).toBe(true)
    expect(prepared.queue).toMatchObject({ revision: before.revision + 1, queuedCount: 0 })
    expect(yield* repository.listSteeringAdmissions).toMatchObject([
      { source: { id: first.id }, input: { idempotencyKey: "stable-a" }, outcome: { _tag: "Pending" } },
    ])

    const retried = yield* repository.prepareQueuedSteeringAdmission(
      first.id,
      target,
      { text: first.prompt, idempotencyKey: "stable-a" },
      [],
      999,
    )
    expect(retried.admission.preparedAt).toBe(prepared.admission.preparedAt)
    expect(retried.queueChanged).toBe(false)
    expect(retried.queue).toMatchObject({ revision: before.revision + 1, queuedCount: 0 })

    const changed = yield* Effect.result(
      repository.prepareQueuedSteeringAdmission(
        first.id,
        target,
        { text: "changed", idempotencyKey: "stable-a" },
        [],
        30,
      ),
    )
    expect(changed).toMatchObject({ _tag: "Failure", failure: { _tag: "TurnRepositoryError" } })

    const reserved = source("source-b")
    expect(yield* Effect.result(repository.copy(reserved, 1))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "TurnQueueFull", count: 1 },
    })

    const accepted = yield* repository.acceptSteeringAdmission("stable-a", { entryId: "opaque-a", sequence: 4 })
    expect(accepted.outcome).toEqual({ _tag: "Accepted", receipt: { entryId: "opaque-a", sequence: 4 } })
    yield* repository.copy(reserved, 1)

    expect(
      yield* Effect.result(
        repository.completeSteeringAdmission("stable-a", target, { entryId: "opaque-a", sequence: 5 }),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "TurnRepositoryError" } })
    expect(yield* repository.listSteeringAdmissions).toMatchObject([
      { input: { idempotencyKey: "stable-a" }, outcome: { _tag: "Accepted" } },
    ])

    const pending = Array.from(
      { length: ExecutionGateway.PendingSteeringMaxEntries - 1 },
      (_, index) => `pending-${index}`,
    )
    expect(
      yield* Effect.result(
        repository.prepareSteeringAdmission(
          target,
          { text: "at capacity", idempotencyKey: "direct-capacity" },
          pending,
          31,
        ),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "TurnRepositoryError" } })
    yield* repository.completeSteeringAdmission("stable-a", target, { entryId: "opaque-a", sequence: 4 })
    const direct = yield* repository.prepareSteeringAdmission(
      target,
      { text: "at capacity", idempotencyKey: "direct-capacity" },
      pending,
      32,
    )
    expect(direct.outcome._tag).toBe("Pending")
    const rejectedDirect = yield* repository.rejectSteeringAdmission(
      "direct-capacity",
      ExecutionGateway.SteeringFailure.make({ kind: "rejected", message: "settled" }),
    )
    expect(rejectedDirect.outcome).toMatchObject({ _tag: "Rejected", failure: { kind: "rejected" } })
    expect(rejectedDirect.outcome._tag === "Rejected" ? rejectedDirect.outcome.queue : undefined).toBeUndefined()
    expect(yield* repository.completeRejectedSteeringAdmission("direct-capacity")).toBe(true)

    const queuedAdmission = yield* repository.prepareQueuedSteeringAdmission(
      reserved.id,
      target,
      { text: reserved.prompt, idempotencyKey: "restore-b" },
      [],
      40,
    )
    const restored = yield* repository.rejectSteeringAdmission(
      "restore-b",
      ExecutionGateway.SteeringFailure.make({ kind: "rejected", message: "terminal" }),
    )
    expect(restored.outcome).toMatchObject({
      _tag: "Rejected",
      queue: {
        revision: queuedAdmission.queue.revision + 1,
        queuedCount: 1,
        change: { _tag: "Added", turn: reserved },
      },
    })
    expect(yield* repository.get(reserved.id)).toEqual(reserved)
    expect(
      yield* repository.prepareQueuedSteeringAdmission(
        reserved.id,
        target,
        { text: reserved.prompt, idempotencyKey: "restore-b" },
        [],
        41,
      ),
    ).toMatchObject({
      admission: { outcome: { _tag: "Rejected" } },
      queueChanged: false,
      queue: { change: { _tag: "Added", turn: { id: reserved.id } } },
    })
    expect(yield* repository.completeRejectedSteeringAdmission("restore-b")).toBe(false)
    yield* repository.dequeue(reserved.id)
    expect(yield* repository.completeRejectedSteeringAdmission("restore-b")).toBe(true)

    const foreign = source("foreign", otherThreadId)
    yield* repository.copy(foreign, 1)
    expect(
      yield* Effect.result(
        repository.prepareQueuedSteeringAdmission(
          foreign.id,
          target,
          { text: foreign.prompt, idempotencyKey: "foreign-request" },
          [],
          50,
        ),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "TurnRepositoryError" } })
    expect(yield* repository.get(foreign.id)).toEqual(foreign)
    expect(yield* repository.listSteeringAdmissions).toEqual([])

    const concurrentPending = Array.from(
      { length: ExecutionGateway.PendingSteeringMaxEntries - 1 },
      (_, index) => `concurrent-${index}`,
    )
    const concurrent = yield* Effect.all(
      ["one", "two"].map((suffix) =>
        Effect.result(
          repository.prepareSteeringAdmission(
            target,
            { text: `concurrent ${suffix}`, idempotencyKey: `concurrent-${suffix}` },
            concurrentPending,
            60,
          ),
        ),
      ),
      { concurrency: "unbounded" },
    )
    expect(concurrent.filter((result) => result._tag === "Success")).toHaveLength(1)
    expect(concurrent.filter((result) => result._tag === "Failure")).toHaveLength(1)
    const admitted = concurrent.find((result) => result._tag === "Success")
    if (admitted?._tag === "Success") {
      const requestId = admitted.success.input.idempotencyKey
      yield* repository.rejectSteeringAdmission(
        requestId,
        ExecutionGateway.SteeringFailure.make({ kind: "rejected", message: "cleanup" }),
      )
      expect(yield* repository.completeRejectedSteeringAdmission(requestId)).toBe(true)
    }
  })

describe("steering admission repository", () => {
  it.effect("preserves durable identity, capacity, queued admission, and rejection behavior in memory", () =>
    Effect.gen(function* () {
      const repository = yield* TurnRepository.makeMemory()
      yield* behavior(repository)
    }),
  )

  it.layer(BunServices.layer)("SQLite", (test) => {
    test.effect("matches the public repository behavior", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-steering-admission-" })
          const database = Database.layer(`${directory}/rika.db`)
          const context = yield* Layer.build(
            Layer.mergeAll(
              database,
              ThreadRepository.layer.pipe(Layer.provide(database)),
              TurnRepository.layer.pipe(Layer.provide(database)),
            ),
          )
          yield* Effect.gen(function* () {
            const threads = yield* ThreadRepository.Service
            const turns = yield* TurnRepository.Service
            yield* threads.create({ id: threadId, workspace: "/workspace", title: "Steering", now: 1 })
            yield* threads.create({ id: otherThreadId, workspace: "/workspace", title: "Other", now: 1 })
            yield* behavior(turns)
          }).pipe(Effect.provide(context))
        }),
      ),
    )

    test.effect("retains accepted and rejected recovery identity across reopen", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-steering-reopen-" })
          const filename = `${directory}/rika.db`
          const withStore = <A, E>(
            effect: Effect.Effect<A, E, ThreadRepository.Service | TurnRepository.Service | SqlClient>,
          ) =>
            Effect.scoped(
              Effect.gen(function* () {
                const database = Database.layer(filename)
                const context = yield* Layer.build(
                  Layer.mergeAll(
                    database,
                    ThreadRepository.layer.pipe(Layer.provide(database)),
                    TurnRepository.layer.pipe(Layer.provide(database)),
                  ),
                )
                return yield* effect.pipe(Effect.provide(context))
              }),
            )
          yield* withStore(
            Effect.gen(function* () {
              const threads = yield* ThreadRepository.Service
              const turns = yield* TurnRepository.Service
              yield* threads.create({ id: threadId, workspace: "/workspace", title: "Steering", now: 1 })
              yield* turns.copy(targetTurn(), 1)
              yield* turns.prepareSteeringAdmission(
                target,
                { text: "persisted", idempotencyKey: "persisted-request" },
                [],
                20,
              )
              yield* turns.acceptSteeringAdmission("persisted-request", { entryId: "opaque-persisted", sequence: 7 })
            }),
          )
          yield* withStore(
            Effect.gen(function* () {
              const turns = yield* TurnRepository.Service
              expect(yield* turns.listSteeringAdmissions).toMatchObject([
                {
                  input: { idempotencyKey: "persisted-request" },
                  outcome: { _tag: "Accepted", receipt: { entryId: "opaque-persisted", sequence: 7 } },
                },
              ])
              yield* turns.completeSteeringAdmission("persisted-request", target, {
                entryId: "opaque-persisted",
                sequence: 7,
              })
              const restored = source("persisted-source")
              yield* turns.copy(restored, 1)
              yield* turns.prepareQueuedSteeringAdmission(
                restored.id,
                target,
                { text: restored.prompt, idempotencyKey: "persisted-rejection" },
                [],
                30,
              )
              yield* turns.rejectSteeringAdmission(
                "persisted-rejection",
                ExecutionGateway.SteeringFailure.make({ kind: "rejected", message: "persisted" }),
              )
            }),
          )
          yield* withStore(
            Effect.gen(function* () {
              const turns = yield* TurnRepository.Service
              expect(yield* turns.listSteeringAdmissions).toMatchObject([
                {
                  source: { id: Turn.TurnId.make("persisted-source") },
                  outcome: { _tag: "Rejected", failure: { kind: "rejected" } },
                },
              ])
              expect(yield* turns.completeRejectedSteeringAdmission("persisted-rejection")).toBe(false)
              yield* turns.dequeue(Turn.TurnId.make("persisted-source"))
              expect(yield* turns.completeRejectedSteeringAdmission("persisted-rejection")).toBe(true)
              const sql = yield* SqlClient
              yield* sql`DELETE FROM rika_threads WHERE id = ${threadId}`
              expect(yield* turns.listSteeringAdmissions).toEqual([])
            }),
          )
        }),
      ),
    )
  })
})
