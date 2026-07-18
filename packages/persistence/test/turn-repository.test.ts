import * as Thread from "../src/thread-schema"
import * as TurnRepository from "../src/turn-repository"
import * as Turn from "../src/turn-schema"
import { expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { makeRecordingSql } from "./recording-sql"

const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })

type CurrentCreateInput = Omit<TurnRepository.CreateInput, "executionRoute" | "queueCapacity"> & {
  readonly executionRoute?: Turn.ExecutionRoutePin
  readonly queueCapacity?: number
}

const create = (repository: TurnRepository.Interface, input: CurrentCreateInput) =>
  repository.createForSubmission({
    executionRoute: Turn.testExecutionRoute(),
    ...input,
    queueCapacity: input.queueCapacity ?? 128,
  })

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
    expect((yield* repository.get(created.id))?.promptParts).toEqual(created.promptParts)
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory turns snapshot attachments and execution pins at the repository boundary", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const promptParts: Array<Turn.PromptPart> = [
      { type: "text", text: "inspect " },
      { type: "image", mediaType: "image/png", data: "b3JpZ2luYWw=", filename: "original.png" },
    ]
    const executionRoute = Turn.testExecutionRoute("high")
    const created = yield* create(repository, {
      id: Turn.TurnId.make("snapshot-turn"),
      threadId: Thread.ThreadId.make("snapshot-thread"),
      prompt: "inspect [Image 1]",
      promptParts,
      executionRoute,
      now: 1,
    })
    const mutableRoute = executionRoute.main as { model: string }
    const mutableCreatedParts = created.promptParts as Array<Turn.PromptPart> | undefined
    promptParts[0] = { type: "text", text: "mutated" }
    mutableRoute.model = "mutated"
    mutableCreatedParts?.splice(0)

    expect(yield* repository.get(created.id)).toMatchObject({
      promptParts: [
        { type: "text", text: "inspect " },
        { type: "image", data: "b3JpZ2luYWw=", filename: "original.png" },
      ],
      executionRoute: { mode: "high", main: { model: "test" } },
    })
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory turns preserve immutable execution extension pins", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* create(repository, {
      id: Turn.TurnId.make("turn-pin"),
      threadId: Thread.ThreadId.make("thread-pin"),
      prompt: "pin",
      now: 1,
    })
    const pin = {
      generation: "generation-a",
      sourceDigest: "source-a",
      configFingerprint: "config-a",
      toolSchemaDigest: "tools-a",
      mcpFingerprint: "mcp-a",
      resolvedContextDigest: "context-a",
    }
    expect((yield* repository.setExtensionPin(created.id, pin)).extensionPin).toEqual(pin)
    expect(
      (yield* Effect.result(repository.setExtensionPin(created.id, { ...pin, generation: "generation-b" })))._tag,
    ).toBe("Failure")
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory turns pin the execution route at creation", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* create(repository, {
      id: Turn.TurnId.make("turn-route-pin"),
      threadId: Thread.ThreadId.make("thread-route-pin"),
      prompt: "pin route",
      executionRoute: Turn.testExecutionRoute("low"),
      now: 1,
    })
    expect(created.executionRoute.mode).toBe("low")
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory turns preserve review fan-out route ownership while nonterminal", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* create(repository, {
      id: Turn.TurnId.make("review-owner"),
      threadId: Thread.ThreadId.make("review-thread"),
      prompt: "Review workspace changes",
      executionRoute: Turn.testExecutionRoute("medium"),
      reviewFanOutId: "review:review-owner",
      now: 1,
    })
    yield* repository.setStatus(created.id, "running", undefined, 2)
    expect(yield* repository.get(created.id)).toMatchObject({
      status: "running",
      reviewFanOutId: "review:review-owner",
    })
    expect((yield* repository.listNonterminal).map((turn) => turn.id)).toContain(created.id)
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
    const completed = yield* repository.setStatus(created.id, "completed", "cursor-a", 2)
    const failed = yield* repository.setStatus(created.id, "failed", undefined, 3)
    const listed = yield* repository.list(created.threadId)
    expect(created.status).toBe("accepted")
    expect(completed.lastCursor).toBe("cursor-a")
    expect(failed).toMatchObject({ status: "completed", lastCursor: "cursor-a", updatedAt: 2 })
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

it.effect("memory terminal status is immutable against every stale lifecycle update", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* create(repository, {
      id: Turn.TurnId.make("terminal"),
      threadId: Thread.ThreadId.make("terminal-thread"),
      prompt: "done",
      now: 1,
    })
    yield* repository.setStatus(created.id, "completed", "terminal-cursor", 2)
    for (const [index, staleStatus] of Turn.Status.literals.filter((candidate) => candidate !== "queued").entries()) {
      const unchanged = yield* repository.setStatus(created.id, staleStatus, `stale-${staleStatus}`, index + 3)
      expect(unchanged).toMatchObject({ status: "completed", lastCursor: "terminal-cursor", updatedAt: 2 })
    }
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory cursor repair compares status and cursor without changing activity time", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* create(repository, {
      id: Turn.TurnId.make("terminal-repair"),
      threadId: Thread.ThreadId.make("terminal-repair-thread"),
      prompt: "repair",
      now: 1,
    })
    yield* repository.setStatus(created.id, "completed", "cursor-a", 2)
    expect(yield* repository.repairCursor(created.id, "completed", "stale", "cursor-b")).toBe(false)
    expect(yield* repository.repairCursor(created.id, "completed", "cursor-a", "cursor-b")).toBe(true)
    expect(yield* repository.get(created.id)).toMatchObject({
      status: "completed",
      lastCursor: "cursor-b",
      updatedAt: 2,
    })
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
    const missing = yield* Effect.result(repository.setStatus(Turn.TurnId.make("missing"), "failed", undefined, 2))
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
    yield* repository.setStatus(first.id, "completed", undefined, 3)
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
        id: Turn.TurnId.make("claimed"),
        threadId,
        prompt: "before",
        executionRoute: Turn.testExecutionRoute(),
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
    expect(yield* repository.finishQueuedClaim(first, "running", undefined, undefined, 5)).toEqual({
      _tag: "Unavailable",
    })
    const second = yield* repository.claimNextQueued(threadId, 6)
    if (second === undefined) return yield* Effect.die("Missing replacement claim")
    expect(second.token).not.toBe(first.token)
    yield* repository.releaseQueuedClaim(second)
    const released = yield* repository.claimNextQueued(threadId, 6)
    if (released === undefined) return yield* Effect.die("Missing released claim")
    expect(released.token).not.toBe(second.token)
    const finished = yield* repository.finishQueuedClaim(released, "running", "cursor", undefined, 7)
    expect(finished).toMatchObject({
      _tag: "Transitioned",
      turn: { status: "running", prompt: "after", lastCursor: "cursor" },
      queue: { queuedCount: 0, change: { _tag: "Removed", turnId: queued.id } },
    })
    yield* repository.setStatus(queued.id, "completed", "cursor", 8)

    const removed = yield* repository.copy(
      { ...queued, id: Turn.TurnId.make("removed"), prompt: "removed", createdAt: 9, updatedAt: 9 },
      1,
    )
    const third = yield* repository.claimNextQueued(threadId, 10)
    if (third === undefined) return yield* Effect.die("Missing dequeue claim")
    yield* repository.dequeue(removed.id)
    expect(yield* repository.finishQueuedClaim(third, "failed", undefined, undefined, 11)).toEqual({
      _tag: "Unavailable",
    })
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory queue revisions and wake generations stay atomic", () =>
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

    const wake = yield* repository.requestQueueWake(threadId)
    expect(wake).toEqual({ threadId, generation: 1, queueRevision: 2 })
    expect(yield* repository.requestQueueWake(threadId)).toEqual(wake)
    expect(yield* repository.consumeQueueWake(threadId, 2)).toBe(false)
    expect(yield* repository.consumeQueueWake(threadId, 1)).toBe(true)
    expect(yield* repository.consumeQueueWake(threadId, 1)).toBe(false)
    expect(yield* repository.requestQueueWake(threadId)).toEqual({ threadId, generation: 2, queueRevision: 2 })

    const edited = yield* repository.editQueued(first.id, "edited", 4)
    expect(edited.queue).toMatchObject({ revision: 3, queuedCount: 2, change: { _tag: "Updated" } })
    const removed = yield* repository.dequeue(second.id)
    expect(removed).toMatchObject({ revision: 4, queuedCount: 1, change: { _tag: "Removed", turnId: second.id } })
    expect(yield* repository.readQueue(threadId)).toMatchObject({ revision: 4, queuedCount: 1 })
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory atomically takes a queued turn and reports a typed promotion conflict", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("take-queued-thread")
    const active = yield* create(repository, {
      id: Turn.TurnId.make("take-active"),
      threadId,
      prompt: "active",
      now: 1,
    })
    const queued = yield* create(repository, {
      id: Turn.TurnId.make("take-queued"),
      threadId,
      prompt: "queued",
      now: 2,
    })
    const taken = yield* repository.takeQueued(queued.id)
    expect(taken).toMatchObject({
      turn: { id: queued.id, prompt: "queued" },
      queue: { revision: 2, queuedCount: 0, change: { _tag: "Removed", turnId: queued.id } },
    })
    expect(yield* repository.get(queued.id)).toBeUndefined()
    const conflict = yield* Effect.result(repository.takeQueued(active.id))
    expect(conflict).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "QueuedTurnUnavailable",
        turnId: active.id,
        message: `Turn ${active.id} is not queued`,
      },
    })
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory copies exact queue status and requeues an unowned accepted claim", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("copy-thread")
    const copied = yield* repository.copy(
      {
        id: Turn.TurnId.make("copied-queued"),
        threadId,
        prompt: "copied",
        executionRoute: Turn.testExecutionRoute(),
        status: "queued",
        createdAt: 1,
        updatedAt: 1,
      },
      1,
    )
    expect(copied).toMatchObject({ status: "queued", queue: { revision: 1, queuedCount: 1 } })
    const overflow = yield* Effect.result(
      repository.copy(
        {
          id: Turn.TurnId.make("copied-overflow"),
          threadId,
          prompt: "overflow",
          executionRoute: Turn.testExecutionRoute(),
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
        1,
      ),
    )
    expect(overflow).toMatchObject({ _tag: "Failure", failure: { _tag: "TurnQueueFull", count: 1 } })

    const acceptedThread = Thread.ThreadId.make("requeue-thread")
    const accepted = yield* create(repository, {
      id: Turn.TurnId.make("requeue-accepted"),
      threadId: acceptedThread,
      prompt: "accepted",
      now: 3,
    })
    const requeued = yield* repository.requeueAccepted(accepted.id, 1, 4)
    expect(requeued).toMatchObject({ status: "queued", queue: { revision: 1, queuedCount: 1 } })
    expect((yield* repository.claimNextQueued(acceptedThread, 5))?.turn.id).toBe(accepted.id)
    expect(yield* repository.readQueue(acceptedThread)).toMatchObject({ revision: 1, queuedCount: 1 })
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory rejects concurrent submissions beyond queue capacity without changing queue state", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("bounded-thread")
    const active = yield* create(repository, {
      id: Turn.TurnId.make("active"),
      threadId,
      prompt: "active",
      queueCapacity: 3,
      now: 1,
    })
    const submissions = yield* Effect.forEach(
      Array.from({ length: 10 }, (_, index) => index),
      (index) =>
        Effect.result(
          create(repository, {
            id: Turn.TurnId.make(`queued-${index}`),
            threadId,
            prompt: `queued ${index}`,
            queueCapacity: 3,
            now: index + 2,
          }),
        ),
      { concurrency: "unbounded" },
    )
    const failures = submissions.filter((result) => result._tag === "Failure")
    expect(failures).toHaveLength(7)
    for (const result of failures)
      expect(result._tag === "Failure" ? result.failure : undefined).toEqual(
        TurnRepository.QueueFull.make({ threadId, capacity: 3, count: 3 }),
      )
    expect(yield* repository.readQueue(threadId)).toMatchObject({ revision: 3, queuedCount: 3 })
    expect((yield* repository.list(threadId)).length).toBe(4)

    const removed = (yield* repository.readQueue(threadId)).turns[0]
    if (removed === undefined) return yield* Effect.die("Missing queued turn")
    yield* repository.dequeue(removed.id)
    const replacement = yield* create(repository, {
      id: Turn.TurnId.make("replacement"),
      threadId,
      prompt: "replacement",
      queueCapacity: 3,
      now: 20,
    })
    expect(replacement.queue).toMatchObject({ revision: 5, queuedCount: 3 })
    expect(yield* repository.claimNextQueued(threadId, 21)).toBeUndefined()
    yield* repository.setStatus(active.id, "completed", undefined, 22)
    expect((yield* repository.claimNextQueued(threadId, 23))?.turn.id).not.toBe(replacement.id)
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory lists nonterminal turns and rejects a missing extension pin", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-a")
    expect((yield* repository.listNonterminal).map((turn) => turn.id)).toEqual([
      Turn.TurnId.make("b"),
      Turn.TurnId.make("a"),
    ])
    expect((yield* repository.findActive(threadId))?.id).toBe(Turn.TurnId.make("b"))
    expect(
      (yield* Effect.result(
        repository.setExtensionPin(Turn.TurnId.make("missing"), {
          generation: "g",
          sourceDigest: "s",
          configFingerprint: "c",
          toolSchemaDigest: "t",
          mcpFingerprint: "m",
          resolvedContextDigest: "r",
        }),
      ))._tag,
    ).toBe("Failure")
  }).pipe(
    provideLayer(
      TurnRepository.memoryLayer([
        {
          id: Turn.TurnId.make("b"),
          threadId: Thread.ThreadId.make("thread-a"),
          prompt: "b",
          executionRoute: Turn.testExecutionRoute(),
          status: "waiting",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: Turn.TurnId.make("a"),
          threadId: Thread.ThreadId.make("thread-a"),
          prompt: "a",
          executionRoute: Turn.testExecutionRoute(),
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    ),
  ),
)

it.effect("memory edits and dequeues only queued turns", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-a")
    const active = yield* create(repository, {
      id: Turn.TurnId.make("active"),
      threadId,
      prompt: "active",
      now: 1,
    })
    const queued = yield* create(repository, {
      id: Turn.TurnId.make("queued"),
      threadId,
      prompt: "before",
      now: 2,
    })
    expect(yield* repository.editQueued(queued.id, "after", 3)).toMatchObject({ prompt: "after", updatedAt: 3 })
    expect((yield* Effect.result(repository.editQueued(active.id, "invalid", 4)))._tag).toBe("Failure")
    expect((yield* Effect.result(repository.dequeue(active.id)))._tag).toBe("Failure")
    yield* repository.dequeue(queued.id)
    expect(yield* repository.get(queued.id)).toBeUndefined()
    expect((yield* Effect.result(repository.dequeue(queued.id)))._tag).toBe("Failure")
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

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
    expect(stored?.promptParts).toBeUndefined()
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory setStatus forbids transitions into or out of queued", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-guard")
    const active = yield* create(repository, { id: Turn.TurnId.make("active"), threadId, prompt: "active", now: 1 })
    const queued = yield* create(repository, { id: Turn.TurnId.make("queued"), threadId, prompt: "queued", now: 2 })
    expect((yield* Effect.result(repository.setStatus(active.id, "queued", undefined, 3)))._tag).toBe("Failure")
    const before = yield* repository.readQueue(threadId)
    expect(before.queuedCount).toBe(1)
    expect((yield* Effect.result(repository.setStatus(queued.id, "completed", undefined, 4)))._tag).toBe("Failure")
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
          id: Turn.TurnId.make("s1"),
          threadId: Thread.ThreadId.make("thread-seed"),
          prompt: "one",
          status: "queued",
          executionRoute: Turn.testExecutionRoute(),
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: Turn.TurnId.make("s2"),
          threadId: Thread.ThreadId.make("thread-seed"),
          prompt: "two",
          status: "queued",
          executionRoute: Turn.testExecutionRoute(),
          createdAt: 2,
          updatedAt: 2,
        },
      ]),
    ),
  ),
)

const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "turn-a",
  thread_id: "thread-a",
  prompt: "hello",
  execution_route_json: JSON.stringify(Turn.testExecutionRoute()),
  status: "accepted",
  last_cursor: null,
  created_at: 1,
  updated_at: 1,
  ...overrides,
})

const queueRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  thread_id: "thread-a",
  revision: 1,
  queued_count: 1,
  wake_generation: 0,
  wake_pending: 0,
  ...overrides,
})

const sqlTest = (
  run: (
    sql: ReturnType<typeof makeRecordingSql>,
  ) => Effect.Effect<
    void,
    TurnRepository.RepositoryError | TurnRepository.QueueFull | Schema.SchemaError,
    TurnRepository.Service
  >,
) => {
  const sql = makeRecordingSql()
  return run(sql).pipe(provideLayer(TurnRepository.layer.pipe(Layer.provide(sql.layer))))
}

it.effect("sql turns create, get, list, and decode cursor variants", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows()
      sql.rows(row())
      sql.rows(row({ last_cursor: "cursor-a" }))
      sql.rows()
      sql.rows(row(), row({ id: "turn-b", last_cursor: "cursor-b", created_at: 2, updated_at: 2 }))
      const repository = yield* TurnRepository.Service
      const created = yield* create(repository, {
        id: Turn.TurnId.make("turn-a"),
        threadId: Thread.ThreadId.make("thread-a"),
        prompt: "hello",
        now: 1,
      })
      const found = yield* repository.get(Turn.TurnId.make("turn-a"))
      const missing = yield* repository.get(Turn.TurnId.make("missing"))
      const listed = yield* repository.list(Thread.ThreadId.make("thread-a"))
      expect(created.lastCursor).toBeUndefined()
      expect(found?.lastCursor).toBe("cursor-a")
      expect(missing).toBeUndefined()
      expect(listed.map((turn) => turn.lastCursor)).toEqual([undefined, "cursor-b"])
      const parameters = sql.statements[0]?.parameters ?? []
      expect(parameters.slice(0, 4)).toEqual(["turn-a", "thread-a", "hello", null])
      const executionRoute = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(String(parameters[4]))
      expect(executionRoute).toEqual(Turn.testExecutionRoute())
      expect(parameters.slice(5)).toEqual([null, "thread-a", 1, 1])
      expect(sql.statements.at(-1)).toEqual({
        sql: "SELECT * FROM rika_turns WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC",
        parameters: ["thread-a"],
      })
    }),
  ),
)

it.effect("sql turns encode and decode structured attachments", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      const promptParts: ReadonlyArray<Turn.PromptPart> = [
        { type: "text", text: "inspect " },
        { type: "image", mediaType: "image/png", data: "cG5n", filename: "shot.png" },
      ]
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Turn.PromptPart)))(promptParts)
      sql.rows()
      sql.rows(row({ prompt: "inspect [Image 1]", prompt_parts_json: encoded }))
      const repository = yield* TurnRepository.Service
      const created = yield* create(repository, {
        id: Turn.TurnId.make("turn-a"),
        threadId: Thread.ThreadId.make("thread-a"),
        prompt: "inspect [Image 1]",
        promptParts,
        now: 1,
      })
      expect(created.promptParts).toEqual(promptParts)
      expect(sql.statements[0]?.parameters[3]).toBe(encoded)
    }),
  ),
)

it.effect("sql status updates bind cursor and null cursor", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows(row({ status: "accepted" }))
      sql.rows(row({ status: "running", last_cursor: "cursor-a", updated_at: 2 }))
      sql.rows(row({ status: "running" }))
      sql.rows(row({ status: "completed", updated_at: 3 }))
      const repository = yield* TurnRepository.Service
      yield* repository.setStatus(Turn.TurnId.make("turn-a"), "running", "cursor-a", 2)
      yield* repository.setStatus(Turn.TurnId.make("turn-a"), "completed", undefined, 3)
      expect(sql.statements[0]?.parameters).toEqual(["turn-a"])
      expect(sql.statements[1]?.parameters).toEqual(["running", "cursor-a", 2, "turn-a"])
      expect(sql.statements[3]?.parameters).toEqual(["completed", null, 3, "turn-a"])
    }),
  ),
)

it.effect("sql setStatus refuses to move a queued turn out of the queue", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows(row({ status: "queued" }))
      const repository = yield* TurnRepository.Service
      expect(
        (yield* Effect.result(repository.setStatus(Turn.TurnId.make("turn-a"), "completed", undefined, 5)))._tag,
      ).toBe("Failure")
      expect(sql.statements.map((statement) => statement.sql)).toEqual(["SELECT * FROM rika_turns WHERE id = ?"])
    }),
  ),
)

it.effect("sql setStatus refuses to move a turn into queued", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      const repository = yield* TurnRepository.Service
      expect(
        (yield* Effect.result(repository.setStatus(Turn.TurnId.make("turn-a"), "queued", undefined, 5)))._tag,
      ).toBe("Failure")
      expect(sql.statements).toEqual([])
    }),
  ),
)

it.effect("sql pages turns backward and returns chronological results", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows(
        row({ id: "turn-4", created_at: 4, updated_at: 4 }),
        row({ id: "turn-3", created_at: 3, updated_at: 3 }),
        row({ id: "turn-2", created_at: 2, updated_at: 2 }),
      )
      sql.rows(row({ id: "turn-1", created_at: 1, updated_at: 1 }))
      const repository = yield* TurnRepository.Service
      const newest = yield* repository.page(Thread.ThreadId.make("thread-a"), { limit: 2 })
      const older = yield* repository.page(Thread.ThreadId.make("thread-a"), {
        before: newest.oldestCursor,
        limit: 2,
      })
      expect(newest.turns.map((turn) => turn.id)).toEqual([Turn.TurnId.make("turn-3"), Turn.TurnId.make("turn-4")])
      expect(newest.hasOlder).toBe(true)
      expect(older.turns.map((turn) => turn.id)).toEqual([Turn.TurnId.make("turn-1")])
      expect(sql.statements).toEqual([
        {
          sql: "SELECT * FROM rika_turns WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
          parameters: ["thread-a", 3],
        },
        {
          sql: "SELECT * FROM rika_turns WHERE thread_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?",
          parameters: ["thread-a", 3, 3, "turn-3", 3],
        },
      ])
    }),
  ),
)

it.effect("sql writes report missing rows after create and update", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows()
      sql.rows()
      sql.rows()
      sql.rows()
      const repository = yield* TurnRepository.Service
      const missingCreate = yield* Effect.result(
        create(repository, {
          id: Turn.TurnId.make("turn-a"),
          threadId: Thread.ThreadId.make("thread-a"),
          prompt: "hello",
          now: 1,
        }),
      )
      const missingUpdate = yield* Effect.result(
        repository.setStatus(Turn.TurnId.make("turn-a"), "failed", undefined, 2),
      )
      expect(missingCreate._tag === "Failure" && missingCreate.failure._tag).toBe("TurnRepositoryError")
      expect(missingUpdate._tag === "Failure" && missingUpdate.failure._tag).toBe("TurnRepositoryError")
    }),
  ),
)

it.effect("sql malformed rows, statuses, and failures map to repository errors", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows(row({ prompt: 1 }))
      sql.rows(row({ status: "unknown" }))
      sql.error("database unavailable")
      const repository = yield* TurnRepository.Service
      const malformed = yield* Effect.result(repository.get(Turn.TurnId.make("turn-a")))
      const status = yield* Effect.result(repository.get(Turn.TurnId.make("turn-a")))
      const failed = yield* Effect.result(repository.list(Thread.ThreadId.make("thread-a")))
      expect(malformed._tag === "Failure" && malformed.failure._tag).toBe("TurnRepositoryError")
      expect(status._tag === "Failure" && status.failure._tag).toBe("TurnRepositoryError")
      expect(failed._tag === "Failure" && failed.failure._tag).toBe("TurnRepositoryError")
    }),
  ),
)

it.effect("sql finds active turns and lists queued turns", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows(row({ status: "running" }))
      sql.rows()
      sql.rows(queueRow({ revision: 2, queued_count: 2 }))
      sql.rows(row({ status: "queued" }), row({ id: "turn-b", status: "queued" }))
      const repository = yield* TurnRepository.Service
      expect((yield* repository.findActive(Thread.ThreadId.make("thread-a")))?.status).toBe("running")
      expect(yield* repository.findActive(Thread.ThreadId.make("thread-empty"))).toBeUndefined()
      expect((yield* repository.readQueue(Thread.ThreadId.make("thread-a"))).turns.map((turn) => turn.id)).toEqual([
        Turn.TurnId.make("turn-a"),
        Turn.TurnId.make("turn-b"),
      ])
    }),
  ),
)

it.effect("sql claims queued turns and reports empty, malformed, and failed queries", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows({ ...row({ status: "queued" }), queue_claim_token: "TOKEN" })
      sql.rows()
      sql.rows(row({ status: "invalid" }))
      sql.error("claim unavailable")
      sql.rows(row({ prompt: 1 }))
      sql.error("active unavailable")
      sql.error("queue unavailable")
      const repository = yield* TurnRepository.Service
      const threadId = Thread.ThreadId.make("thread-a")
      expect((yield* repository.claimNextQueued(threadId, 2))?.turn.status).toBe("queued")
      expect(yield* repository.claimNextQueued(threadId, 3)).toBeUndefined()
      const malformedClaim = yield* Effect.result(repository.claimNextQueued(threadId, 4))
      const failedClaim = yield* Effect.result(repository.claimNextQueued(threadId, 5))
      const malformedActive = yield* Effect.result(repository.findActive(threadId))
      const failedActive = yield* Effect.result(repository.findActive(threadId))
      const failedQueue = yield* Effect.result(repository.readQueue(threadId))
      expect(malformedClaim._tag).toBe("Failure")
      expect(failedClaim._tag).toBe("Failure")
      expect(malformedActive._tag).toBe("Failure")
      expect(failedActive._tag).toBe("Failure")
      expect(failedQueue._tag).toBe("Failure")
      expect(sql.statements[0]?.parameters).toEqual(["thread-a", "thread-a", "thread-a"])
    }),
  ),
)

it.effect("sql edits and dequeues only queued turns", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows(row({ status: "queued", prompt: "after", updated_at: 3 }))
      sql.rows(queueRow())
      sql.rows()
      sql.rows(row({ status: "queued" }))
      sql.rows(queueRow({ revision: 2, queued_count: 0 }))
      sql.rows()
      const repository = yield* TurnRepository.Service
      expect(yield* repository.editQueued(Turn.TurnId.make("turn-a"), "after", 3)).toMatchObject({
        prompt: "after",
        updatedAt: 3,
      })
      expect((yield* Effect.result(repository.editQueued(Turn.TurnId.make("active"), "invalid", 4)))._tag).toBe(
        "Failure",
      )
      yield* repository.dequeue(Turn.TurnId.make("turn-a"))
      expect((yield* Effect.result(repository.dequeue(Turn.TurnId.make("active"))))._tag).toBe("Failure")
      expect(sql.statements).toEqual([
        {
          sql: "UPDATE rika_turns SET prompt = ?, prompt_parts_json = NULL, updated_at = ?, queue_claim_token = NULL WHERE id = ? AND status = 'queued' RETURNING *",
          parameters: ["after", 3, "turn-a"],
        },
        {
          sql: "UPDATE rika_thread_queue_state SET revision = revision + 1 WHERE thread_id = ? RETURNING *",
          parameters: ["thread-a"],
        },
        {
          sql: "UPDATE rika_turns SET prompt = ?, prompt_parts_json = NULL, updated_at = ?, queue_claim_token = NULL WHERE id = ? AND status = 'queued' RETURNING *",
          parameters: ["invalid", 4, "active"],
        },
        { sql: "DELETE FROM rika_turns WHERE id = ? AND status = 'queued' RETURNING *", parameters: ["turn-a"] },
        {
          sql: "UPDATE rika_thread_queue_state SET revision = revision + 1, queued_count = MAX(queued_count - 1, 0) WHERE thread_id = ? RETURNING *",
          parameters: ["thread-a"],
        },
        { sql: "DELETE FROM rika_turns WHERE id = ? AND status = 'queued' RETURNING *", parameters: ["active"] },
      ])
    }),
  ),
)

it.effect("sql lists nonterminal turns and mutates extension pins", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      const pin = {
        generation: "generation-a",
        sourceDigest: "source-a",
        configFingerprint: "config-a",
        toolSchemaDigest: "tools-a",
        mcpFingerprint: "mcp-a",
        resolvedContextDigest: "context-a",
      }
      sql.rows(row(), row({ id: "turn-b", status: "waiting" }))
      const encodedPin = yield* Schema.encodeEffect(Schema.fromJsonString(Turn.ExecutionExtensionPin))(pin)
      sql.rows(row({ extension_pin_json: encodedPin }))
      sql.rows()
      sql.error("list failed")
      sql.error("pin failed")
      const repository = yield* TurnRepository.Service
      expect((yield* repository.listNonterminal).map((turn) => turn.id)).toEqual([
        Turn.TurnId.make("turn-a"),
        Turn.TurnId.make("turn-b"),
      ])
      expect((yield* repository.setExtensionPin(Turn.TurnId.make("turn-a"), pin)).extensionPin).toEqual(pin)
      expect((yield* Effect.result(repository.setExtensionPin(Turn.TurnId.make("missing"), pin)))._tag).toBe("Failure")
      expect((yield* Effect.result(repository.listNonterminal))._tag).toBe("Failure")
      expect((yield* Effect.result(repository.setExtensionPin(Turn.TurnId.make("turn-a"), pin)))._tag).toBe("Failure")
    }),
  ),
)
