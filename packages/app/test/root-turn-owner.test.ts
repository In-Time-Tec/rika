import { assert, it } from "@effect/vitest"
import * as Thread from "@rika/persistence/thread"
import * as Turn from "@rika/persistence/turn"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Deferred, Effect, Ref } from "effect"
import * as RootTurnOwner from "../src/root-turn-owner"

const threadId = Thread.ThreadId.make("thread")
const turn = (id: string, status: Turn.Status, createdAt = 0): Turn.Turn => ({
  id: Turn.TurnId.make(id),
  threadId,
  prompt: id,
  status,
  executionRoute: Turn.testExecutionRoute("medium"),
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt,
  updatedAt: createdAt,
})

const backend = (starts: Ref.Ref<number>, follows: Ref.Ref<number>) =>
  ({
    start: (input: ExecutionBackend.StartInput) =>
      Ref.update(starts, (value) => value + 1).pipe(
        Effect.as({ turnId: String(input.turnId), status: "completed", events: [] } as const),
      ),
    follow: (id: string) =>
      Ref.update(follows, (value) => value + 1).pipe(
        Effect.as({ turnId: id, status: "completed", events: [] } as const),
      ),
  }) as unknown as ExecutionBackend.Interface

it.effect("admits only one concurrent owner and permits recovery after release", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.makeMemory([turn("turn", "accepted")])
    const starts = yield* Ref.make(0)
    const follows = yield* Ref.make(0)
    const owner = yield* RootTurnOwner.make(repository, backend(starts, follows))
    const claims = yield* Effect.all(
      Array.from({ length: 8 }, () => owner.claim(Turn.TurnId.make("turn"), "accepted")),
      { concurrency: "unbounded" },
    )
    assert.strictEqual(claims.filter(Boolean).length, 1)
    assert.isFalse(yield* owner.claim(Turn.TurnId.make("turn")))
    assert.isTrue(yield* owner.release(Turn.TurnId.make("turn")))
    assert.isTrue(yield* owner.claim(Turn.TurnId.make("turn")))
  }),
)

it.effect("claims queued turns in FIFO order without duplicate promotion", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.makeMemory([turn("first", "queued", 1), turn("second", "queued", 2)])
    const starts = yield* Ref.make(0)
    const follows = yield* Ref.make(0)
    const owner = yield* RootTurnOwner.make(repository, backend(starts, follows))
    const claims = yield* Effect.all([owner.claimQueued(threadId, 3), owner.claimQueued(threadId, 3)], {
      concurrency: "unbounded",
    })
    assert.strictEqual(claims.filter((claim) => claim !== undefined).length, 1)
    assert.strictEqual(claims.find((claim) => claim !== undefined)?.turn.id, "first")
  }),
)

it.effect("rejects terminal claims and centralizes root start and follow", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.makeMemory([turn("done", "completed")])
    const starts = yield* Ref.make(0)
    const follows = yield* Ref.make(0)
    const owner = yield* RootTurnOwner.make(repository, backend(starts, follows))
    assert.isFalse(yield* owner.claim(Turn.TurnId.make("done")))
    yield* owner.start({
      threadId,
      turnId: Turn.TurnId.make("new"),
      prompt: "prompt",
      startedAt: 0,
      executionRoute: Turn.testExecutionRoute("medium"),
    })
    yield* owner.follow(Turn.TurnId.make("new"), { cursor: "cursor", sequence: 1 }, undefined, undefined, undefined)
    assert.strictEqual(yield* Ref.get(starts), 1)
    assert.strictEqual(yield* Ref.get(follows), 1)
  }),
)

it.effect("runs an accepted turn independently and deduplicates concurrent scheduling", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.makeMemory([turn("accepted", "accepted")])
    const starts = yield* Ref.make(0)
    const follows = yield* Ref.make(0)
    const runs = yield* Ref.make(0)
    const release = yield* Deferred.make<void>()
    const owner = yield* RootTurnOwner.make(repository, backend(starts, follows))
    yield* owner.install({
      run: () => Ref.update(runs, (value) => value + 1).pipe(Effect.andThen(Deferred.await(release))),
      reconcile: Effect.void,
    })
    yield* Effect.all(
      Array.from({ length: 8 }, () => owner.accepted(Turn.TurnId.make("accepted"))),
      {
        concurrency: "unbounded",
      },
    )
    while ((yield* Ref.get(runs)) === 0) yield* Effect.yieldNow
    assert.strictEqual(yield* Ref.get(runs), 1)
    yield* Deferred.succeed(release, undefined)
  }),
)

it.effect("delegates restart reconciliation to the installed durable lifecycle", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.makeMemory([turn("running", "running")])
    const starts = yield* Ref.make(0)
    const follows = yield* Ref.make(0)
    const reconciles = yield* Ref.make(0)
    const owner = yield* RootTurnOwner.make(repository, backend(starts, follows))
    yield* owner.install({
      run: () => Effect.void,
      reconcile: Ref.update(reconciles, (value) => value + 1),
    })
    yield* owner.reconcile
    assert.strictEqual(yield* Ref.get(reconciles), 1)
  }),
)
