import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as MemoryTranscriptRepository from "../../../../product-store/src/transcript/memory-repository"
import * as MemoryTurnRepository from "../../../../product-store/src/turn/memory/repository"
import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
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

it.layer(
  Layer.mergeAll(
    MemoryTurnRepository.memoryLayer([turn]),
    MemoryTranscriptRepository.memoryLayer(),
    ExecutionGateway.layerTest(),
  ),
)((test) => {
  test.effect("fails a link-less nonterminal turn and releases its thread for queue draining", () =>
    Effect.gen(function* () {
      const turns = yield* TurnRepository.Service
      const transcripts = yield* TranscriptRepository.Service
      const backend = yield* ExecutionGateway.Service
      const result = yield* make({
        turns,
        transcripts,
        backend,
        setTurnStatus: turns.setStatus,
      })
      const settled = yield* turns.get(turn.id)
      const projection = yield* transcripts.get(turn.id)

      expect(result.active).toEqual([])
      expect(result.settledThreads).toEqual([turn.threadId])
      expect(settled?.status).toBe("failed")
      expect(projection?.units).toHaveLength(1)
      expect(projection?.units[0]?.content).toMatchObject({
        _tag: "Block",
        block: { _tag: "Error", category: "execution-unavailable" },
      })
    }),
  )
})
