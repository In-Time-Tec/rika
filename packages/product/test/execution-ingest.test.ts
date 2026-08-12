import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as LiveThreadProjection from "../src/thread/projection/live-thread-projection"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as Turn from "@rika/product/turn-record"
import { Context, Duration, Effect, Fiber, PubSub, Stream } from "effect"
import { TestClock } from "effect/testing"
import { make as makeIngest, type ExecutionIngest } from "../src/execution/service/execution-ingest"
import { make as makeOwner } from "../src/thread/queue/root-turn-owner"

const threadId = Thread.ThreadId.make("thread")
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
const link = { runId: "run", threadId: String(threadId), turnId: "turn" }
const turn: Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: Turn.TurnId.make("turn"),
  threadId,
  prompt: "prompt",
  status: "running",
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  executionLink: link,
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}
const change: ExecutionProjection.Change = {
  _tag: "ProjectionSnapshot",
  revision: 1,
  units: [
    {
      key: "answer",
      turnId: String(turn.id),
      order: [{ sequence: 1, part: 0, key: "answer" }],
      revision: 1,
      content: { _tag: "Entry", role: "assistant", text: "done" },
    },
  ],
  hasOlder: false,
  state: {
    status: "completed",
    usage: ExecutionProjection.emptyUsageState(),
    steering: { steeringMessages: 0, followUpMessages: 0 },
  },
}

const waitFor = (predicate: () => boolean, tries = 0): Effect.Effect<void> =>
  Effect.suspend(() =>
    predicate() || tries > 10_000 ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(waitFor(predicate, tries + 1))),
  )

it.effect("re-arms a failed watch with bounded backoff and never bumps the hub generation", () =>
  Effect.gen(function* () {
    const hub = yield* LiveThreadProjection.make(() => 1)
    hub.setBase(threadId, {
      thread,
      revision: 0,
      source: { projectionVersion: ExecutionProjection.projectionVersion },
      turns: [],
      pending: [],
      hasOlder: false,
      hasNewer: false,
      usage: { state: ExecutionProjection.emptyUsageState() },
    })
    const frames: Array<LiveThreadProjection.HubFrame> = []
    const collector = yield* Effect.forkChild(
      Stream.runForEach(hub.watch(threadId), (frame) => Effect.sync(() => frames.push(frame))),
    )
    const turnChanges = yield* PubSub.sliding<void>(1)
    const dirtyTurnObservers = new Set<Turn.TurnId>()
    let watchAttempts = 0
    let stored = turn
    const backend: ExecutionGateway.Interface = {
      startTurn: () => Effect.die("unused"),
      cancelTurn: () => Effect.void,
      steerTurn: () => Effect.void,
      approveTurn: () => Effect.void,
      denyTurn: () => Effect.void,
      watchTurn: () => {
        watchAttempts += 1
        return watchAttempts === 1
          ? Stream.fail(ExecutionGateway.WatchTurnFailure.make({ message: "transient watch failure" }))
          : Stream.fromIterable([change])
      },
      inspectTurn: () => Effect.succeed({ status: "running" }),
    }
    const owner = yield* makeOwner(
      {
        get: () => Effect.succeed(stored),
        list: () => Effect.succeed([stored]),
        listNonterminal: Effect.succeed([stored]),
        listUnlinkedExecutionAdmissions: Effect.succeed([]),
        prepareExecutionAdmission: (input) => Effect.succeed(input),
        attachExecutionLink: () => Effect.succeed(stored),
        claimNextQueued: () => Effect.void,
        finishQueuedClaim: () =>
          Effect.succeed({ _tag: "Transitioned" as const, turn: stored, queue: undefined as never }),
        releaseQueuedClaim: () => Effect.void,
        readQueue: () => Effect.succeed({ threadId, revision: 0, queuedCount: 0, turns: [] }),
      } as unknown as import("@rika/product/turn-repository").Interface,
      {} as import("@rika/product/transcript-repository").Interface,
      backend,
    )
    const statuses: Array<import("@rika/product/execution-status").Status> = []
    const ingest: ExecutionIngest = yield* makeIngest({
      turns: {
        get: () => Effect.succeed(stored),
        list: () => Effect.succeed([stored]),
        listNonterminal: Effect.succeed([stored]),
        listUnlinkedExecutionAdmissions: Effect.succeed([]),
        prepareExecutionAdmission: (input) => Effect.succeed(input),
        attachExecutionLink: () => Effect.succeed(stored),
        claimNextQueued: () => Effect.void,
        finishQueuedClaim: () =>
          Effect.succeed({ _tag: "Transitioned" as const, turn: stored, queue: undefined as never }),
        releaseQueuedClaim: () => Effect.void,
        readQueue: () => Effect.succeed({ threadId, revision: 0, queuedCount: 0, turns: [] }),
      } as unknown as import("@rika/product/turn-repository").Interface,
      transcripts: {
        get: () => Effect.void,
        commitProjection: () => Effect.succeed("committed" as const),
      } as unknown as import("@rika/product/transcript-repository").Interface,
      backend,
      rootTurnOwner: owner,
      hub,
      turnChanges,
      dirtyTurnObservers,
      publishInteractiveActivity: (_origin, event) => event,
      prepareExecution: () =>
        Effect.succeed({
          prompt: "prepared",
          promptParts: undefined,
          messages: [],
        }),
      setTurnStatus: (id, status, now) =>
        Effect.sync(() => {
          statuses.push(status)
          stored = { ...stored, status, updatedAt: now }
          return stored
        }),
      ensureTurnSummary: () => Effect.void,
      notifyThreadSummaries: Effect.void,
      makeTurnId: Effect.succeed(Turn.TurnId.make("retry")),
      pendingTurnCapacity: 8,
      queueMutationEvent: (queue) => ({
        _tag: "QueueUpdated",
        selectionEpoch: 0,
        threadId: queue.threadId,
        revision: queue.revision,
        queuedCount: queue.queuedCount,
        change: { _tag: "Reset", items: [] },
      }),
      staleQueuedTurnsError: () => undefined,
      queuedTurnPromoteMaxAgeMs: 60_000,
      temporaryThreadTitle: (prompt) => prompt,
      executionDependencies: Context.make(
        ThreadRepository.Service,
        ThreadRepository.Service.of({
          get: () => Effect.succeed(thread),
        } as unknown as ThreadRepository.Interface),
      ),
    })
    const supervisor = yield* Effect.forkChild(ingest.supervise)
    yield* waitFor(() => watchAttempts >= 1)
    // The first watch failed; the ingest must re-arm after the bounded backoff instead of
    // dropping the watch, and the failure must not emit a Generation frame.
    expect(frames.some((frame) => frame._tag === "Generation")).toBe(false)
    yield* TestClock.adjust(Duration.millis(500))
    yield* waitFor(() => watchAttempts >= 2)
    const settledOutcome = yield* ingest.awaitSettled(turn.id)
    expect(settledOutcome.finalTurnId).toEqual(turn.id)
    expect(watchAttempts).toBe(2)
    expect(statuses).toContain("completed")
    yield* Fiber.interrupt(supervisor).pipe(Effect.ignore)
    yield* Fiber.interrupt(collector).pipe(Effect.ignore)
    // The failed watch never bumped the generation; the settled commit produced one patch.
    expect(frames.filter((frame) => frame._tag === "Generation")).toHaveLength(0)
    expect(frames.filter((frame) => frame._tag === "Patch")).toHaveLength(1)
  }),
)
