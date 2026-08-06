import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as ExecutionRouteSnapshot from "../src/execution/contract/execution-route-snapshot"
import { projectionVersion } from "../src/execution/ingest/execution-ingest-service"
import { initialTranscriptWindow } from "../src/operation/interactive/transcript-window"
import { makeSelectionState } from "../src/operation/interactive/interactive-thread-selection"
import * as Thread from "../src/thread/model/thread-record"
import * as TranscriptPage from "../src/thread/model/transcript-page"
import * as Turn from "../src/thread/model/turn-record"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"

const thread: Thread.Thread = {
  id: Thread.ThreadId.make("large-thread"),
  workspace: "/work",
  title: "Large thread",
  lineage: { _tag: "Original" },
  labels: [],
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 58,
}

const turn = (index: number): Turn.AgentExecutionTurn => ({
  _tag: "AgentExecution",
  id: Turn.TurnId.make(`turn-${index}`),
  threadId: thread.id,
  prompt: `prompt ${index}`,
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  status: "completed",
  createdAt: index,
  updatedAt: index,
})

const projection = (value: Turn.AgentExecutionTurn): TranscriptPage.Projection => {
  const projected = TranscriptProjection.Projection.empty(value.id, value.prompt)
  return {
    turn: value,
    units: projected.units,
    checkpointGeneration: 0,
    revision: projected.revision,
    modelPhase: projected.modelPhase,
    usableCompletionSequence: projected.usableCompletionSequence,
    oldestCursor: undefined,
    checkpointCursor: undefined,
    costUsd: undefined,
    usageCursors: undefined,
    pricingVersion: undefined,
    executionCheckpoints: [],
    projectionVersion,
  }
}

it.effect("hydrates only the bounded recent window of a 58-turn thread", () =>
  Effect.gen(function* () {
    const allTurns = Array.from({ length: 58 }, (_, index) => turn(index + 1))
    const stored = new Map(allTurns.map((value) => [value.id, projection(value)]))
    const reads: Array<string> = []
    const pageLimits: Array<number | undefined> = []
    const result = yield* initialTranscriptWindow({
      state: makeSelectionState(thread, 1),
      turns: {
        page: (_threadId, options) => {
          pageLimits.push(options?.limit)
          return Effect.succeed({
            turns: allTurns,
            hasOlder: false,
            oldestCursor: undefined,
            newestCursor: undefined,
          })
        },
      },
      transcripts: {
        get: (turnId) => {
          reads.push(turnId)
          return Effect.succeed(stored.get(turnId))
        },
      },
      ensureIngest: () => Effect.void,
      maxTurns: 6,
      maxEntries: 120,
      fail: (message) => Effect.die(message),
    })

    expect(pageLimits).toEqual([50])
    expect(reads).toEqual(["turn-58", "turn-57", "turn-56", "turn-55", "turn-54", "turn-53"])
    expect(new Set(result.entries.map((entry) => entry.turn.id))).toEqual(
      new Set(["turn-53", "turn-54", "turn-55", "turn-56", "turn-57", "turn-58"]),
    )
    expect(result.hasOlder).toBe(true)
  }),
)
