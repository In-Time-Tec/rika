import {
  expect,
  it,
  Thread,
  TurnRepository,
  TurnContract,
  Turn,
  Effect,
  provideLayer,
  create,
} from "./turn-repository-behavior-support"

it.effect("memory copies exact queue status and requeues an unowned accepted claim", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("copy-thread")
    const copied = yield* repository.copy(
      {
        _tag: "AgentExecution",
        id: Turn.TurnId.make("copied-queued"),
        threadId,
        prompt: "copied",
        executionRoute: Turn.testExecutionRoute(),
        author: { _tag: "Human" },
        lineage: { _tag: "Original" },
        status: "queued",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      },
      1,
    )
    expect(copied).toMatchObject({ status: "queued", queue: { revision: 1, queuedCount: 1 } })
    const overflow = yield* Effect.result(
      repository.copy(
        {
          _tag: "AgentExecution",
          id: Turn.TurnId.make("copied-overflow"),
          threadId,
          prompt: "overflow",
          executionRoute: Turn.testExecutionRoute(),
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          status: "queued",
          stopIntent: "none",
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
        TurnContract.QueueFull.make({ threadId, capacity: 3, count: 3 }),
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
          _tag: "AgentExecution",
          id: Turn.TurnId.make("b"),
          threadId: Thread.ThreadId.make("thread-a"),
          prompt: "b",
          executionRoute: Turn.testExecutionRoute(),
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          status: "waiting",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          _tag: "AgentExecution",
          id: Turn.TurnId.make("a"),
          threadId: Thread.ThreadId.make("thread-a"),
          prompt: "a",
          executionRoute: Turn.testExecutionRoute(),
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          status: "running",
          stopIntent: "none",
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
