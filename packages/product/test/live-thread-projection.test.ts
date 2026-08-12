import { expect, it } from "@effect/vitest"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as LiveThreadProjection from "../src/thread/projection/live-thread-projection"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import { Effect, Fiber, Stream } from "effect"

const threadId = Thread.ThreadId.make("thread")
const turnId = Turn.TurnId.make("turn")
const thread: Thread.Thread = {
  id: threadId,
  workspace: "/workspace",
  title: "Thread",
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}
const turn: Turn.Turn = {
  _tag: "AgentExecution",
  id: turnId,
  threadId,
  prompt: "prompt",
  status: "running",
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}
const preview: ExecutionGateway.ModelPreviewed = {
  _tag: "ModelPreviewed",
  key: { runId: "run", attemptFence: 1, turn: 0, modelCallId: "call", modelAttemptId: "attempt", attempt: 0 },
  revision: 1,
  text: "tentative",
  reasoning: "thinking",
  truncated: false,
}
const snapshot = (): import("../src/thread/model/thread-view").ThreadViewSnapshot => ({
  thread,
  revision: 0,
  source: { projectionVersion: ExecutionProjection.projectionVersion },
  turns: [],
  pending: [],
  hasOlder: false,
  hasNewer: false,
  usage: { state: ExecutionProjection.emptyUsageState() },
})
const state = () => ({
  status: "running" as const,
  usage: ExecutionProjection.emptyUsageState(),
  steering: { steeringMessages: 0, followUpMessages: 0 },
})

const collect = (hub: LiveThreadProjection.Interface, id: Thread.ThreadId) =>
  Effect.gen(function* () {
    const frames: Array<LiveThreadProjection.HubFrame> = []
    const fiber = yield* Effect.forkChild(
      Stream.runForEach(hub.watch(id), (frame) => Effect.sync(() => frames.push(frame))),
    )
    const yieldMany = (count: number): Effect.Effect<void> =>
      count === 0 ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(yieldMany(count - 1)))
    const stable = (tries = 0): Effect.Effect<void> =>
      Effect.suspend(() => {
        const before = frames.length
        return yieldMany(8).pipe(
          Effect.andThen(
            Effect.suspend(() => (frames.length === before || tries > 500 ? Effect.void : stable(tries + 1))),
          ),
        )
      })
    return { frames, fiber, stable }
  })

it.effect("a late subscriber receives the atomic base plus the current live tail as its first frame", () =>
  Effect.gen(function* () {
    const hub = yield* LiveThreadProjection.make(() => 1)
    hub.setBase(threadId, snapshot())
    hub.preview(threadId, turnId, preview)
    const { frames, fiber, stable } = yield* collect(hub, threadId)
    yield* stable()
    yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
    const first = frames[0]
    expect(first).toMatchObject({
      _tag: "Base",
      generation: 2,
      live: { turnId, preview },
    })
    expect(first?._tag === "Base" && first.base !== undefined ? first.base.thread.id : undefined).toBe(threadId)
  }),
)

it.effect("a late subscriber receives every patch published after it subscribed", () =>
  Effect.gen(function* () {
    const hub = yield* LiveThreadProjection.make(() => 1)
    hub.setBase(threadId, snapshot())
    const { frames, fiber, stable } = yield* collect(hub, threadId)
    yield* stable()
    hub.commitChange(threadId, turn, {
      _tag: "ProjectionSnapshot",
      revision: 0,
      units: [
        {
          key: "answer",
          turnId: String(turnId),
          order: [{ sequence: 1, part: 0, key: "answer" }],
          revision: 1,
          content: { _tag: "Entry", role: "assistant", text: "one" },
        },
      ],
      hasOlder: false,
      state: state(),
    })
    hub.preview(threadId, turnId, preview)
    yield* stable()
    yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
    expect(frames.map((frame) => frame._tag)).toEqual(["Base", "Patch", "Live"])
  }),
)

it.effect("generation rollover invalidates frames of the old generation for every subscriber", () =>
  Effect.gen(function* () {
    const hub = yield* LiveThreadProjection.make(() => 1)
    hub.setBase(threadId, snapshot())
    const first = yield* collect(hub, threadId)
    const second = yield* collect(hub, threadId)
    yield* first.stable()
    yield* second.stable()
    // Generation 1: one patch.
    hub.commitChange(threadId, turn, {
      _tag: "ProjectionSnapshot",
      revision: 0,
      units: [
        {
          key: "answer",
          turnId: String(turnId),
          order: [{ sequence: 1, part: 0, key: "answer" }],
          revision: 1,
          content: { _tag: "Entry", role: "assistant", text: "one" },
        },
      ],
      hasOlder: false,
      state: state(),
    })
    yield* first.stable()
    yield* second.stable()
    // Rollover: reset bumps the generation and clears the base.
    hub.reset(threadId)
    yield* first.stable()
    yield* second.stable()
    // After the rollover the base is gone; a commit cannot resurrect the old generation.
    hub.commitChange(threadId, turn, {
      _tag: "ProjectionSnapshot",
      revision: 1,
      units: [],
      hasOlder: false,
      state: state(),
    })
    yield* first.stable()
    yield* second.stable()
    yield* Fiber.interrupt(first.fiber).pipe(Effect.ignore)
    yield* Fiber.interrupt(second.fiber).pipe(Effect.ignore)
    const generations = (frames: ReadonlyArray<LiveThreadProjection.HubFrame>) =>
      frames.filter((frame) => frame._tag !== "Base" || frame.base !== undefined)
    for (const frames of [first.frames, second.frames]) {
      const visible = generations(frames)
      const tags = visible.map((frame) => frame._tag)
      expect(tags).toEqual(["Base", "Patch", "Generation"])
      // The old-generation patch is present, but the post-rollover commit produced nothing.
      expect(visible.filter((frame) => frame._tag === "Patch")).toHaveLength(1)
    }
  }),
)

it.effect("a fresh selection replaces the namespace for every subscriber with a new atomic base", () =>
  Effect.gen(function* () {
    const hub = yield* LiveThreadProjection.make(() => 1)
    hub.setBase(threadId, snapshot())
    const { frames, fiber, stable } = yield* collect(hub, threadId)
    yield* stable()
    hub.setBase(threadId, snapshot())
    yield* stable()
    yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
    expect(frames.filter((frame) => frame._tag === "Base" && frame.base !== undefined)).toHaveLength(2)
    expect(frames.map((frame) => (frame._tag === "Base" ? frame.generation : undefined))).toEqual([2, 3])
  }),
)
