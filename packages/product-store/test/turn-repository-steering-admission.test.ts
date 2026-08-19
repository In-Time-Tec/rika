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
    expect(yield* repository.readQueue(threadId)).toMatchObject({ queuedCount: 0, turns: [] })
    expect(prepared.queueChanged).toBe(true)
    expect(prepared.queue).toMatchObject({
      revision: before.revision + 1,
      queuedCount: 0,
      change: { _tag: "Removed", turnId: first.id },
    })
    expect(yield* repository.listSteeringAdmissions).toMatchObject([
      { source: { id: first.id }, input: { idempotencyKey: "stable-a" }, outcome: { _tag: "Pending" } },
    ])
    expect(yield* Effect.result(repository.editQueued(first.id, "stale edit", 21))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "TurnRepositoryError" },
    })
    expect(yield* Effect.result(repository.dequeue(first.id))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "TurnRepositoryError" },
    })
    expect(yield* repository.get(first.id)).toEqual(first)

    const retried = yield* repository.prepareQueuedSteeringAdmission(
      first.id,
      target,
      { text: first.prompt, idempotencyKey: "stable-a" },
      [],
      999,
    )
    expect(retried.admission.preparedAt).toBe(prepared.admission.preparedAt)
    expect(retried.queueChanged).toBe(false)

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
    const consumedQueue = yield* repository.completeSteeringAdmission("stable-a", target, {
      entryId: "opaque-a",
      sequence: 4,
    })
    expect(consumedQueue).toBeUndefined()
    yield* repository.copy(reserved, 1)

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
    expect(queuedAdmission.queueChanged).toBe(true)
    const restored = yield* repository.rejectSteeringAdmission(
      "restore-b",
      ExecutionGateway.SteeringFailure.make({ kind: "rejected", message: "terminal" }),
    )
    expect(restored.outcome).toMatchObject({
      _tag: "Rejected",
      queue: {
        revision: queuedAdmission.queue.revision + 1,
        queuedCount: 1,
        change: { _tag: "Added", turn: { id: reserved.id } },
      },
    })
    const restoredQueue = yield* repository.readQueue(threadId)
    expect(restoredQueue.turns.map((turn) => turn.id)).toEqual([reserved.id])
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
    expect(yield* repository.completeRejectedSteeringAdmission("restore-b")).toBe(true)

    const beforeMiddle = { ...source("source-before"), prompt: "before", createdAt: 6, updatedAt: 6 }
    const afterMiddle = { ...source("source-after"), prompt: "after", createdAt: 8, updatedAt: 8 }
    yield* repository.copy(beforeMiddle, 8)
    yield* repository.copy(afterMiddle, 8)
    expect((yield* repository.readQueue(threadId)).turns.map((turn) => turn.id)).toEqual([
      beforeMiddle.id,
      reserved.id,
      afterMiddle.id,
    ])
    const middle = yield* repository.prepareQueuedSteeringAdmission(
      reserved.id,
      target,
      { text: reserved.prompt, idempotencyKey: "restore-middle" },
      [],
      42,
    )
    expect((yield* repository.readQueue(threadId)).turns.map((turn) => turn.id)).toEqual([
      beforeMiddle.id,
      afterMiddle.id,
    ])
    const middleRejected = yield* repository.rejectSteeringAdmission(
      "restore-middle",
      ExecutionGateway.SteeringFailure.make({ kind: "rejected", message: "restore in place" }),
    )
    expect(middleRejected.outcome).toMatchObject({
      _tag: "Rejected",
      queue: {
        revision: middle.queue.revision + 1,
        queuedCount: 3,
        change: { _tag: "Added", turn: { id: reserved.id }, position: 1 },
      },
    })
    expect((yield* repository.readQueue(threadId)).turns.map((turn) => turn.id)).toEqual([
      beforeMiddle.id,
      reserved.id,
      afterMiddle.id,
    ])
    expect(yield* repository.completeRejectedSteeringAdmission("restore-middle")).toBe(true)
    for (const [index, turn] of [beforeMiddle, reserved, afterMiddle].entries()) {
      yield* repository.editQueued(turn.id, `edited-${index}`, 43 + index)
      expect((yield* repository.readQueue(threadId)).turns.map((candidate) => candidate.id)).toEqual([
        beforeMiddle.id,
        reserved.id,
        afterMiddle.id,
      ])
    }
    expect((yield* repository.readQueue(threadId)).turns.map((turn) => turn.prompt)).toEqual([
      "edited-0",
      "edited-1",
      "edited-2",
    ])

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

    const capacityTarget = {
      ...targetTurn(),
      id: Turn.TurnId.make("capacity-target"),
      threadId: otherThreadId,
      executionLink: {
        runId: "capacity-run",
        threadId: otherThreadId,
        turnId: Turn.TurnId.make("capacity-target"),
      },
    }
    yield* repository.copy(capacityTarget, 1)
    yield* repository.prepareQueuedSteeringAdmission(
      foreign.id,
      capacityTarget.executionLink,
      { text: foreign.prompt, idempotencyKey: "capacity-withdrawn" },
      [],
      70,
    )
    yield* repository.setStatus(capacityTarget.id, "completed", 71)
    const acceptedCandidate = {
      ...source("capacity-accepted", otherThreadId),
      status: "accepted" as const,
      createdAt: 72,
      updatedAt: 72,
    }
    yield* repository.copy(acceptedCandidate, 1)
    expect(yield* Effect.result(repository.requeueAccepted(acceptedCandidate.id, 1, 73))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "TurnQueueFull", capacity: 1, count: 1 },
    })
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
              const pendingSource = source("persisted-pending-source")
              yield* turns.copy(pendingSource, 1)
              yield* turns.prepareQueuedSteeringAdmission(
                pendingSource.id,
                target,
                { text: pendingSource.prompt, idempotencyKey: "persisted-pending-request" },
                [],
                21,
              )
            }),
          )
          yield* withStore(
            Effect.gen(function* () {
              const turns = yield* TurnRepository.Service
              expect(yield* turns.listSteeringAdmissions).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    input: { text: "persisted", idempotencyKey: "persisted-request" },
                    outcome: { _tag: "Accepted", receipt: { entryId: "opaque-persisted", sequence: 7 } },
                  }),
                  expect.objectContaining({
                    source: expect.objectContaining({ id: Turn.TurnId.make("persisted-pending-source") }),
                    input: {
                      text: "same steering text",
                      idempotencyKey: "persisted-pending-request",
                    },
                    outcome: { _tag: "Pending" },
                  }),
                ]),
              )
              expect(yield* turns.readQueue(threadId)).toMatchObject({ queuedCount: 0, turns: [] })
              expect(
                yield* Effect.result(
                  turns.editQueued(Turn.TurnId.make("persisted-pending-source"), "stale after reopen", 22),
                ),
              ).toMatchObject({ _tag: "Failure", failure: { _tag: "TurnRepositoryError" } })
              const pendingReceipt = { entryId: "opaque-pending", sequence: 8 }
              yield* turns.acceptSteeringAdmission("persisted-pending-request", pendingReceipt)
              yield* turns.completeSteeringAdmission("persisted-pending-request", target, pendingReceipt)
              expect(yield* turns.get(Turn.TurnId.make("persisted-pending-source"))).toBeUndefined()
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
