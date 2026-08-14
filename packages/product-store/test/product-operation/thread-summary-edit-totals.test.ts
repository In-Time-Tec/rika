import { Service } from "@rika/product/product-operation-service"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as ThreadSummaryStore from "@rika/product-store/sqlite-thread-summary-repository"
import * as TranscriptStore from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import { unitOrder } from "@rika/transcript/transcript-unit-order"
import { Clock, Context, Effect, Layer, Stream } from "effect"

import { executionRoute } from "../support/product-test-current-state"
import { executionSessionLifecycleLayerTest, productLayer, provideLayer } from "../support/operation-layer-harness"
import { threadLineage } from "../support/operation-selection-fixtures"

const thread: Thread.Thread = {
  id: Thread.ThreadId.make("thread-edits"),
  lineage: threadLineage,
  workspace: "/work",
  title: "Edits",
  labels: [],
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
}

const turnId = Turn.TurnId.make("turn-edits")
const followUpTurnId = Turn.TurnId.make("turn-follow-up")

const patch = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,3 @@", "-before", "+after", "+appended"].join("\n")

const editSnapshot: ExecutionProjection.Snapshot = {
  _tag: "ProjectionSnapshot",
  revision: 0,
  checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "cursor-a", state: "{}" },
  units: [
    {
      key: "tool:edit",
      turnId,
      order: unitOrder("tool:edit", 0),
      revision: 0,
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          id: "edit-call",
          name: "edit",
          input: JSON.stringify({ path: "src/a.ts" }),
          status: "complete",
          presentation: { family: "edit", action: "edit", activeLabel: "Editing", completeLabel: "Edited" },
          detail: "src/a.ts",
          output: JSON.stringify({ text: "edited src/a.ts", truncated: false, diff: patch }),
          files: [],
        },
      },
    },
    {
      key: "assistant:done",
      turnId,
      order: unitOrder("assistant:done", 1),
      revision: 0,
      content: { _tag: "Entry", role: "assistant", text: "edited the file" },
    },
  ],
  hasOlder: false,
  state: {
    status: "completed",
    usage: ExecutionProjection.emptyUsageState(),
    steering: { steeringMessages: 0, followUpMessages: 0 },
  },
}

const answerSnapshot = (id: Turn.TurnId): ExecutionProjection.Snapshot => ({
  ...editSnapshot,
  units: [
    {
      key: `assistant:${id}`,
      turnId: id,
      order: unitOrder(`assistant:${id}`, 0),
      revision: 0,
      content: { _tag: "Entry", role: "assistant", text: "nothing to change" },
    },
  ],
})

const backendFor = (snapshot: (id: Turn.TurnId) => ExecutionProjection.Snapshot) =>
  ExecutionGateway.Service.of({
    startTurn: (input) =>
      Effect.succeed({ runId: `${input.turnId}-run`, turnId: input.turnId, threadId: input.threadId }),
    cancelTurn: () => Effect.void,
    steerTurn: () => Effect.succeed({ entryId: "test-steering", sequence: 0 }),
    approveTurn: () => Effect.void,
    denyTurn: () => Effect.void,
    watchTurn: (link) => Stream.make(snapshot(Turn.TurnId.make(link.turnId))),
    inspectTurn: () => Effect.succeed({ status: "completed", cursor: "cursor-a" }),
  })

const runPrompt = {
  _tag: "Run",
  prompt: ["edit", "the", "file"],
  threadId: String(thread.id),
  ephemeral: false,
  streamJson: false,
  streamJsonInput: false,
  streamJsonThinking: false,
} as const

const durableState = Effect.gen(function* () {
  const threads = yield* ThreadRepository.makeMemory([thread])
  const turns = yield* TurnRepository.makeMemory()
  const turnLayer = Layer.succeed(TurnRepository.Service, turns)
  const threadLayer = Layer.succeed(ThreadRepository.Service, threads)
  const transcriptLayer = TranscriptStore.memoryLayerWithTurns.pipe(Layer.provide(turnLayer), Layer.orDie)
  const summaryLayer = ThreadSummaryStore.memoryLayer.pipe(
    Layer.provide(Layer.merge(threadLayer, turnLayer)),
    Layer.orDie,
  )
  const summaryContext = yield* Layer.build(summaryLayer)
  const transcriptContext = yield* Layer.build(transcriptLayer)
  const process = (backend: ExecutionGateway.Interface, nextTurnId: Turn.TurnId) =>
    productLayer({
      executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
      repositoryLayer: threadLayer,
      turnRepositoryLayer: turnLayer,
      threadSummaryRepositoryLayer: Layer.succeedContext(summaryContext),
      transcriptRepositoryLayer: Layer.succeedContext(transcriptContext),
      backendLayer: Layer.succeed(ExecutionGateway.Service, backend),
      defaultWorkspace: "/work",
      makeThreadId: Effect.die("A reused thread must not create an id"),
      makeTurnId: Effect.succeed(nextTurnId),
    })
  const readSummaries = Effect.gen(function* () {
    const summaries = yield* ThreadSummaryRepository.Service
    return { list: yield* summaries.list(), repairs: yield* summaries.listRepairCandidates() }
  }).pipe(provideLayer(Layer.succeedContext(summaryContext)))
  const settleWithoutProjection = Effect.gen(function* () {
    const transcripts = Context.get(transcriptContext, TranscriptRepository.Service)
    const summaries = Context.get(summaryContext, ThreadSummaryRepository.Service)
    const now = yield* Clock.currentTimeMillis
    yield* turns.createForSubmission({
      id: turnId,
      threadId: thread.id,
      prompt: "edit the file",
      author: { _tag: "Human" },
      lineage: { _tag: "Original" },
      executionRoute: executionRoute(),
      queueCapacity: 64,
      now,
    })
    yield* summaries.ensureTurn(turnId, thread.id, now)
    const running = yield* turns.setStatus(turnId, "running", now)
    yield* transcripts.commitProjection(running, editSnapshot)
    yield* turns.setStatus(turnId, "completed", now)
    return yield* readSummaries
  })
  return { process, readSummaries, settleWithoutProjection }
})

describe("Thread summary edit totals", () => {
  it.effect("projects Agent turn edit totals once and replays them unchanged after a restart", () =>
    Effect.gen(function* () {
      const durable = yield* durableState
      const editTotals = { added: 1, modified: 1, removed: 0 }
      yield* Effect.gen(function* () {
        yield* (yield* Service).run(runPrompt)
      }).pipe(
        provideLayer(
          durable.process(
            backendFor(() => editSnapshot),
            turnId,
          ),
        ),
      )
      const afterRun = yield* durable.readSummaries
      expect(afterRun.list).toMatchObject([{ id: thread.id, editTotals }])
      expect(afterRun.repairs).toEqual([])

      yield* Effect.gen(function* () {
        yield* (yield* Service).run(runPrompt)
      }).pipe(provideLayer(durable.process(backendFor(answerSnapshot), followUpTurnId)))
      const afterRestart = yield* durable.readSummaries
      expect(afterRestart.list).toMatchObject([{ id: thread.id, editTotals }])
      expect(afterRestart.repairs).toEqual([])
    }),
  )

  it.effect("repairs edit totals from the persisted projection when a turn settled without projecting", () =>
    Effect.gen(function* () {
      const durable = yield* durableState
      const crashed = yield* durable.settleWithoutProjection
      expect(crashed.repairs).toMatchObject([{ turnId, threadId: thread.id, status: "completed" }])
      expect(crashed.list).toMatchObject([{ id: thread.id }])
      expect(crashed.list[0]?.editTotals).toBeUndefined()

      yield* Effect.gen(function* () {
        yield* (yield* Service).run(runPrompt)
      }).pipe(provideLayer(durable.process(backendFor(answerSnapshot), followUpTurnId)))
      const repaired = yield* durable.readSummaries
      expect(repaired.list).toMatchObject([{ id: thread.id, editTotals: { added: 1, modified: 1, removed: 0 } }])
      expect(repaired.repairs).toEqual([])
    }),
  )
})
