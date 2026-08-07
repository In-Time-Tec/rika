import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Effect, Layer, Ref } from "effect"

import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { holdSession, openInteractiveSession, settleEvents } from "../support/operation-session-harness"
import { backend } from "../support/operation-execution-fixtures"

const promptUnits = (snapshot: Extract<InteractiveEvent, { readonly _tag: "ThreadViewSnapshot" }>["snapshot"]) =>
  snapshot.turns.flatMap((entry) => entry.units)

describe("Operation", () => {
  it.effect("publishes the first turn in the created-thread base snapshot", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: InteractiveEvent) => runSync(Ref.update(events, (all) => [...all, event]))
      const layer = productLayer({
        repositoryLayer: ThreadRepository.memoryLayer(),
        turnRepositoryLayer: TurnRepository.memoryLayer(),
        backendLayer: Layer.succeed(ExecutionGateway.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("turn")),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events(dispatch))
        yield* Effect.yieldNow
        yield* session.submit("first message")
        yield* settleEvents
      }).pipe(provideLayer(layer))
      const received = yield* Ref.get(events)
      const snapshots = received.filter(
        (event): event is Extract<InteractiveEvent, { readonly _tag: "ThreadViewSnapshot" }> =>
          event._tag === "ThreadViewSnapshot",
      )
      expect(snapshots.length).toBeGreaterThan(0)
      const first = snapshots[0]!
      expect(String(first.snapshot.thread.id)).toBe("thread")
      expect(promptUnits(first.snapshot)).toContainEqual({
        key: "turn:turn:user",
        turnId: "turn",
        order: [{ sequence: -1, part: 0, key: "turn:turn:user" }],
        revision: 0,
        content: { _tag: "Entry", role: "user", text: "first message" },
      })
    }),
  )
})
