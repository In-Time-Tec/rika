import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { make } from "../../../src/execution/authority/reconciliation"

const turn: Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: Turn.TurnId.make("zombie"),
  threadId: Thread.ThreadId.make("thread"),
  prompt: "work",
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  status: "running",
  createdAt: 1,
  updatedAt: 2,
}

it.effect("fails a link-less nonterminal turn and releases its thread for queue draining", () =>
  Effect.gen(function* () {
    let settled: Turn.AgentExecutionTurn | undefined
    let units: ReadonlyArray<import("@rika/transcript/transcript-unit").Unit> = []
    const turns = {
      listNonterminal: Effect.succeed([turn]),
      listSteeringAdmissions: Effect.succeed([]),
    } as unknown as TurnRepository.Interface
    const transcripts = {
      get: () => Effect.as(Effect.void, undefined),
      replaceUnits: (candidate: Turn.Turn, replacement: typeof units) =>
        Effect.sync(() => {
          settled = candidate as Turn.AgentExecutionTurn
          units = replacement
          return undefined as never
        }),
    } as unknown as TranscriptRepository.Interface
    const result = yield* make({
      turns,
      transcripts,
      backend: {} as ExecutionGateway.Interface,
      setTurnStatus: (_id, status, now) =>
        Effect.sync(() => {
          settled = { ...turn, status, updatedAt: now }
          return settled
        }),
    })

    expect(result.active).toEqual([])
    expect(result.settledThreads).toEqual([turn.threadId])
    expect(settled?.status).toBe("failed")
    expect(units).toHaveLength(1)
    expect(units[0]?.content).toMatchObject({
      _tag: "Block",
      block: { _tag: "Error", category: "execution-unavailable" },
    })
  }),
)
