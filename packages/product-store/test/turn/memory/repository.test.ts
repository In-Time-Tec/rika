import * as ExecutionRequest from "@rika/product/execution-request"
import * as ThreadResult from "@rika/product/thread-result"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionStatus from "@rika/product/execution-status"
import { expect, it, Thread, TurnRepository, Turn, Effect } from "./repository.fixture"
import { create, provideLayer } from "./repository.harness"

it.effect("memory turns preserve structured image prompt parts", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* create(repository, {
      id: Turn.TurnId.make("image-turn"),
      threadId: Thread.ThreadId.make("image-thread"),
      prompt: "inspect [Image 1]",
      promptParts: [
        { type: "text", text: "inspect " },
        { type: "image", mediaType: "image/png", data: "cG5n", filename: "shot.png" },
      ],
      now: 1,
    })
    const stored = yield* repository.get(created.id)
    expect(
      stored !== undefined && ThreadResult.TurnResult.isAgentExecution(stored) ? stored.promptParts : undefined,
    ).toEqual(created.promptParts)
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory turns snapshot attachments and execution pins at the repository boundary", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const promptParts: Array<ExecutionRequest.PromptPart> = [
      { type: "text", text: "inspect " },
      { type: "image", mediaType: "image/png", data: "b3JpZ2luYWw=", filename: "original.png" },
    ]
    const executionRoute = ExecutionRouteSnapshot.testExecutionRoute("high")
    const created = yield* create(repository, {
      id: Turn.TurnId.make("snapshot-turn"),
      threadId: Thread.ThreadId.make("snapshot-thread"),
      prompt: "inspect [Image 1]",
      promptParts,
      executionRoute,
      now: 1,
    })
    const mutableRoute = executionRoute.main.candidates[0] as { model: string }
    const mutableCreatedParts = created.promptParts as Array<ExecutionRequest.PromptPart> | undefined
    promptParts[0] = { type: "text", text: "mutated" }
    mutableRoute.model = "mutated"
    mutableCreatedParts?.splice(0)

    expect(yield* repository.get(created.id)).toMatchObject({
      promptParts: [
        { type: "text", text: "inspect " },
        { type: "image", data: "b3JpZ2luYWw=", filename: "original.png" },
      ],
      executionRoute: { mode: "high", main: { candidates: [{ model: "test" }] } },
    })
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory turns pin the execution route at creation", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* create(repository, {
      id: Turn.TurnId.make("turn-route-pin"),
      threadId: Thread.ThreadId.make("thread-route-pin"),
      prompt: "pin route",
      executionRoute: ExecutionRouteSnapshot.testExecutionRoute("low"),
      now: 1,
    })
    expect(created.executionRoute.mode).toBe("low")
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory turns attach one canonical execution link without allowing replacement", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* create(repository, {
      id: Turn.TurnId.make("linked-turn"),
      threadId: Thread.ThreadId.make("linked-thread"),
      prompt: "Run linked work",
      executionRoute: ExecutionRouteSnapshot.testExecutionRoute("medium"),
      now: 1,
    })
    const link = { runId: "run-1", turnId: created.id, threadId: created.threadId }
    yield* repository.prepareExecutionAdmission(
      {
        threadId: created.threadId,
        turnId: created.id,
        workspaceId: "/workspace",
        prompt: created.prompt,
        executionRoute: created.executionRoute,
      },
      2,
    )
    yield* repository.attachExecutionLink(created.id, link, 2)
    yield* repository.attachExecutionLink(created.id, link, 3)
    expect(yield* repository.get(created.id)).toMatchObject({
      executionLink: link,
      updatedAt: 2,
    })
    expect(yield* repository.cancelUnlinked(created.id, 4)).toBe(false)
    expect(
      yield* Effect.result(
        repository.attachExecutionLink(
          created.id,
          { runId: "run-2", turnId: created.id, threadId: created.threadId },
          5,
        ),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "TurnRepositoryError" } })
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory admission outbox snapshots exact input and exposes only unlinked preparations", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* create(repository, {
      id: Turn.TurnId.make("prepared-turn"),
      threadId: Thread.ThreadId.make("prepared-thread"),
      prompt: "request",
      now: 1,
    })
    const input = {
      threadId: created.threadId,
      turnId: created.id,
      workspaceId: "/prepared/workspace",
      prompt: "resolved request",
      promptParts: [{ type: "text" as const, text: "resolved request" }],
      executionRoute: created.executionRoute,
      titleIntent: { _tag: "GenerateThreadTitle" as const, expectedTitle: "Request" },
    }
    expect(yield* repository.prepareExecutionAdmission(input, 2)).toEqual(input)
    input.promptParts[0] = { type: "text", text: "mutated" }
    expect(yield* repository.listUnlinkedExecutionAdmissions).toMatchObject([
      { prompt: "resolved request", promptParts: [{ text: "resolved request" }] },
    ])
    expect(
      yield* Effect.result(repository.prepareExecutionAdmission({ ...input, prompt: "changed" }, 3)),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "TurnRepositoryError" } })
    yield* repository.attachExecutionLink(
      created.id,
      { runId: "opaque-run", turnId: created.id, threadId: created.threadId },
      4,
    )
    expect(yield* repository.listUnlinkedExecutionAdmissions).toEqual([])
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory turns preserve deterministic identity and status", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* create(repository, {
      id: Turn.TurnId.make("turn-a"),
      threadId: Thread.ThreadId.make("thread-a"),
      prompt: "hello",
      now: 1,
    })
    yield* create(repository, {
      id: Turn.TurnId.make("turn-b"),
      threadId: Thread.ThreadId.make("thread-a"),
      prompt: "next",
      now: 1,
    })
    const completed = yield* repository.setStatus(created.id, "completed", 2)
    const failed = yield* repository.setStatus(created.id, "failed", 3)
    const listed = yield* repository.list(created.threadId)
    expect(created.status).toBe("accepted")
    expect(completed).toMatchObject({ status: "completed", updatedAt: 2 })
    expect(failed).toMatchObject({ status: "completed", updatedAt: 2 })
    expect(listed.map((turn) => turn.id)).toEqual([Turn.TurnId.make("turn-a"), Turn.TurnId.make("turn-b")])
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory pages newest turns without loading the full thread", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("paged-thread")
    for (let index = 0; index < 5; index += 1) {
      yield* create(repository, {
        id: Turn.TurnId.make(`turn-${index}`),
        threadId,
        prompt: `prompt ${index}`,
        now: index,
      })
    }
    const newest = yield* repository.page(threadId, { limit: 2 })
    const older = yield* repository.page(threadId, { before: newest.oldestCursor, limit: 2 })
    const oldest = yield* repository.page(threadId, { before: older.oldestCursor, limit: 2 })
    expect(newest.turns.map((turn) => turn.id)).toEqual([Turn.TurnId.make("turn-3"), Turn.TurnId.make("turn-4")])
    expect(newest.hasOlder).toBe(true)
    expect(older.turns.map((turn) => turn.id)).toEqual([Turn.TurnId.make("turn-1"), Turn.TurnId.make("turn-2")])
    expect(oldest.turns.map((turn) => turn.id)).toEqual([Turn.TurnId.make("turn-0")])
    expect(oldest.hasOlder).toBe(false)
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory lists recent nonqueued turns independently of queue depth", () =>
  Effect.gen(function* () {
    const threadId = Thread.ThreadId.make("preview-thread")
    const repository = yield* TurnRepository.Service
    for (let index = 0; index < 6; index += 1) {
      const turn = yield* create(repository, {
        id: Turn.TurnId.make(`turn-${index}`),
        threadId,
        prompt: `prompt ${index}`,
        now: index + 1,
      })
      if (index < 5) yield* repository.setStatus(turn.id, "completed", index + 1)
    }
    for (let index = 0; index < 140; index += 1)
      yield* create(repository, {
        id: Turn.TurnId.make(`queued-${index}`),
        threadId,
        prompt: `queued ${index}`,
        now: index + 10,
        queueCapacity: 200,
      })
    expect((yield* repository.listRecentNonqueued(threadId, 4)).map((turn) => turn.id)).toEqual([
      Turn.TurnId.make("turn-2"),
      Turn.TurnId.make("turn-3"),
      Turn.TurnId.make("turn-4"),
      Turn.TurnId.make("turn-5"),
    ])
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory terminal status is immutable against every stale lifecycle update", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* create(repository, {
      id: Turn.TurnId.make("terminal"),
      threadId: Thread.ThreadId.make("terminal-thread"),
      prompt: "done",
      now: 1,
    })
    yield* repository.setStatus(created.id, "completed", 2)
    for (const [index, staleStatus] of ExecutionStatus.Status.literals
      .filter((candidate) => candidate !== "queued")
      .entries()) {
      const unchanged = yield* repository.setStatus(created.id, staleStatus, index + 3)
      expect(unchanged).toMatchObject({ status: "completed", updatedAt: 2 })
    }
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory cancellation claims accepted and running turns until their execution link is attached", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const started = yield* create(repository, {
      id: Turn.TurnId.make("start-wins"),
      threadId: Thread.ThreadId.make("claim-thread"),
      prompt: "start",
      now: 1,
    })
    expect(yield* repository.startAccepted(started.id, 2)).toBe(true)
    expect(yield* repository.cancelUnlinked(started.id, 3)).toBe(true)
    expect(yield* repository.startAccepted(started.id, 4)).toBe(false)
    expect(yield* repository.get(started.id)).toMatchObject({ status: "cancelled", updatedAt: 3 })

    const cancelled = yield* create(repository, {
      id: Turn.TurnId.make("cancel-wins"),
      threadId: Thread.ThreadId.make("other-claim-thread"),
      prompt: "cancel",
      now: 5,
    })
    expect(yield* repository.cancelUnlinked(cancelled.id, 6)).toBe(true)
    expect(yield* repository.startAccepted(cancelled.id, 7)).toBe(false)
    expect(yield* repository.cancelUnlinked(cancelled.id, 8)).toBe(false)
    expect(yield* repository.get(cancelled.id)).toMatchObject({ status: "cancelled", updatedAt: 6 })
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory turns reject duplicates and missing updates", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const input = {
      id: Turn.TurnId.make("turn-a"),
      threadId: Thread.ThreadId.make("thread-a"),
      prompt: "hello",
      now: 1,
    }
    yield* create(repository, input)
    const duplicate = yield* Effect.result(create(repository, input))
    const missing = yield* Effect.result(repository.setStatus(Turn.TurnId.make("missing"), "failed", 2))
    expect(duplicate._tag).toBe("Failure")
    expect(missing._tag).toBe("Failure")
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory submissions queue while active and promote one in FIFO order", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-a")
    const first = yield* create(repository, {
      id: Turn.TurnId.make("turn-active"),
      threadId,
      prompt: "active",
      now: 1,
    })
    const third = yield* create(repository, {
      id: Turn.TurnId.make("turn-b"),
      threadId,
      prompt: "third",
      now: 2,
    })
    const second = yield* create(repository, {
      id: Turn.TurnId.make("turn-a"),
      threadId,
      prompt: "second",
      now: 2,
    })
    expect(first.status).toBe("accepted")
    expect((yield* repository.findActive(threadId))?.id).toBe(first.id)
    expect((yield* repository.readQueue(threadId)).turns.map((turn) => turn.id)).toEqual([third.id, second.id])
    expect(yield* repository.claimNextQueued(threadId, 3)).toBeUndefined()
    yield* repository.setStatus(first.id, "completed", 3)
    expect((yield* repository.claimNextQueued(threadId, 4))?.turn.id).toBe(third.id)
    expect(yield* repository.claimNextQueued(threadId, 4)).toBeUndefined()
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory claim is empty when no turn is queued", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-empty")
    expect(yield* repository.findActive(threadId)).toBeUndefined()
    expect((yield* repository.readQueue(threadId)).turns).toEqual([])
    expect(yield* repository.claimNextQueued(threadId, 2)).toBeUndefined()
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory claims stay queued and edit or dequeue invalidate preparation", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("claim-races")
    const queued = yield* repository.copy(
      {
        _tag: "AgentExecution",
        id: Turn.TurnId.make("claimed"),
        threadId,
        prompt: "before",
        executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
        author: { _tag: "Human" },
        lineage: { _tag: "Original" },
        status: "queued",
        createdAt: 1,
        updatedAt: 1,
      },
      1,
    )
    const before = yield* repository.readQueue(threadId)
    const first = yield* repository.claimNextQueued(threadId, 2)
    if (first === undefined) return yield* Effect.die("Missing claim")
    expect(first.turn.status).toBe("queued")
    expect(yield* repository.readQueue(threadId)).toEqual(before)
    expect(yield* repository.claimNextQueued(threadId, 3)).toBeUndefined()

    yield* repository.editQueued(queued.id, "after", 4)
    expect(yield* repository.finishQueuedClaim(first, "running", 5)).toEqual({
      _tag: "Unavailable",
    })
    const second = yield* repository.claimNextQueued(threadId, 6)
    if (second === undefined) return yield* Effect.die("Missing replacement claim")
    expect(second.token).not.toBe(first.token)
    yield* repository.releaseQueuedClaim(second)
    const released = yield* repository.claimNextQueued(threadId, 6)
    if (released === undefined) return yield* Effect.die("Missing released claim")
    expect(released.token).not.toBe(second.token)
    const finished = yield* repository.finishQueuedClaim(released, "running", 7)
    expect(finished).toMatchObject({
      _tag: "Transitioned",
      turn: { status: "running", prompt: "after" },
      queue: { queuedCount: 0, change: { _tag: "Removed", turnId: queued.id } },
    })
    yield* repository.setStatus(queued.id, "completed", 8)

    const removed = yield* repository.copy(
      { ...queued, id: Turn.TurnId.make("removed"), prompt: "removed", createdAt: 9, updatedAt: 9 },
      1,
    )
    const third = yield* repository.claimNextQueued(threadId, 10)
    if (third === undefined) return yield* Effect.die("Missing dequeue claim")
    yield* repository.dequeue(removed.id)
    expect(yield* repository.finishQueuedClaim(third, "failed", 11)).toEqual({
      _tag: "Unavailable",
    })
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory queue revisions stay atomic", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-revisions")
    const active = yield* create(repository, {
      id: Turn.TurnId.make("active"),
      threadId,
      prompt: "active",
      now: 1,
    })
    const first = yield* create(repository, {
      id: Turn.TurnId.make("first"),
      threadId,
      prompt: "first",
      now: 2,
    })
    const second = yield* create(repository, {
      id: Turn.TurnId.make("second"),
      threadId,
      prompt: "second",
      now: 3,
    })
    expect(active.queue).toBeUndefined()
    expect(first.queue).toMatchObject({ revision: 1, queuedCount: 1, becameNonempty: true })
    expect(second.queue).toMatchObject({ revision: 2, queuedCount: 2, becameNonempty: false })
    expect(yield* repository.readQueue(threadId)).toMatchObject({ revision: 2, queuedCount: 2 })

    const edited = yield* repository.editQueued(first.id, "edited", 4)
    expect(edited.queue).toMatchObject({ revision: 3, queuedCount: 2, change: { _tag: "Updated" } })
    const removed = yield* repository.dequeue(second.id)
    expect(removed).toMatchObject({ revision: 4, queuedCount: 1, change: { _tag: "Removed", turnId: second.id } })
    expect(yield* repository.readQueue(threadId)).toMatchObject({ revision: 4, queuedCount: 1 })
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)
