import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import type * as TurnRepositoryContract from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { unitOrder } from "@rika/transcript/transcript-unit-order"
import { Effect, Layer, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"

import { executionSessionLifecycleLayerTest, productLayer, provideLayer } from "../support/operation-layer-harness"
import { holdSession, openInteractiveSession, settleEvents } from "../support/operation-session-harness"
import { backend, projectionSnapshot } from "../support/operation-execution-fixtures"
import { threadLineage } from "../support/operation-selection-fixtures"

const retryThread = (): Thread.Thread => ({
  id: Thread.ThreadId.make("retry-thread"),
  lineage: threadLineage,
  workspace: "/work",
  title: "Retry",
  labels: [],
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
})

const errorUnit = (turnId: string) => ({
  key: `model-call:${turnId}`,
  turnId,
  order: unitOrder(`model-call:${turnId}`, 0),
  revision: 0,
  content: {
    _tag: "Block" as const,
    block: {
      _tag: "Error" as const,
      title: "The provider limited how often requests are accepted.",
      detail: "",
      turnId,
      category: "rate-limit",
      retryable: true,
    },
  },
})

const waitForStatus = (
  turns: TurnRepositoryContract.Interface,
  turnId: string,
  status: string,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    let waited = 0
    while ((yield* turns.get(Turn.TurnId.make(turnId)))?.status !== status && waited < 500) {
      yield* Effect.yieldNow
      waited += 1
    }
    return undefined
  }).pipe(Effect.ignore)

const openSession = (
  sessions: Ref.Ref<ReadonlyArray<InteractiveSession>>,
  dispatch: (event: InteractiveEvent) => void,
): Effect.Effect<
  InteractiveSession,
  never,
  import("@rika/product/product-operation-service").Service | import("effect/Scope").Scope
> =>
  Effect.gen(function* () {
    const session = yield* openInteractiveSession(sessions, { _tag: "Interactive", prompt: [], ephemeral: false })
    yield* Effect.forkChild(session.events(dispatch))
    yield* Effect.yieldNow
    return session
  })

describe("turn retry", () => {
  it.effect("retries a transient rate-limited turn and settles the retry turn", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: InteractiveEvent) => runSync(Ref.update(events, (all) => [...all, event]))
      const turnSequence = yield* Ref.make(0)
      const thread = retryThread()
      const repository = yield* ThreadRepository.makeMemory([thread])
      const turns = yield* TurnRepository.makeMemory()
      const transcripts = yield* TranscriptRepository.makeMemory({ turns })
      let calls = 0
      const retryingBackend = ExecutionGateway.Service.of({
        ...backend,
        inspectTurn: (link) =>
          Effect.succeed({ status: link.turnId === "turn-1" ? ("failed" as const) : ("completed" as const) }),
        watchTurn: (link) => {
          calls += 1
          if (calls === 1)
            return Stream.make({
              ...projectionSnapshot(link.turnId, "failed", "cursor-fail"),
              units: [errorUnit(link.turnId)],
            })
          return Stream.make(projectionSnapshot(link.turnId, "completed", "cursor-ok", "answer"))
        },
      })
      const layer = productLayer({
        executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
        backendLayer: Layer.succeed(ExecutionGateway.Service, retryingBackend),
        defaultWorkspace: "/work",
        pendingTurnCapacity: 64,
        makeThreadId: Effect.die("unused"),
        makeTurnId: Ref.updateAndGet(turnSequence, (value) => value + 1).pipe(
          Effect.map((value) => Turn.TurnId.make(`turn-${value}`)),
        ),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openSession(sessions, dispatch)
        yield* session.selectThread(thread.id)
        yield* session.submit("say hi")
        yield* waitForStatus(turns, "turn-1", "failed")
        let waited = 0
        while ((yield* turns.get(Turn.TurnId.make("turn-2")))?.status !== "completed" && waited < 200) {
          yield* TestClock.adjust("1 second")
          yield* Effect.yieldNow
          waited += 1
        }
        yield* settleEvents
      }).pipe(provideLayer(layer))
      expect(yield* turns.get(Turn.TurnId.make("turn-1"))).toMatchObject({ status: "failed" })
      const retried = yield* turns.get(Turn.TurnId.make("turn-2"))
      expect(retried).toMatchObject({ status: "completed" })
      if (retried?._tag !== "AgentExecution") return yield* Effect.die("expected an agent execution turn")
      expect(retried.lineage).toEqual({ _tag: "Retried", sourceTurnId: "turn-1" })
      expect(yield* Ref.get(events)).toContainEqual(
        expect.objectContaining({ _tag: "TurnRetryScheduled", attempt: 1, budget: 3, turnId: "turn-1" }),
      )
    }),
  )
})
