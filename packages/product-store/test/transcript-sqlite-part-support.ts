import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "../src/thread/sqlite-thread-repository"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import { commitAll, event, projectionVersion, provideLayer, sqliteLayer, unit } from "./transcript-repository-fixtures"

export const UnitJson = Schema.fromJsonString(TranscriptUnit.Unit)

export const usageEvent: TranscriptSourceEvent.SourceEvent = {
  cursor: "usage-5",
  sequence: 5,
  type: "model.usage.reported",
  createdAt: 5,
  data: {
    provider: "openai",
    model: "gpt-5.6-sol",
    input_tokens: 250_000,
    input_tokens_uncached: 250_000,
    input_tokens_cache_read: 0,
    input_tokens_cache_write: 0,
    output_tokens: 0,
  },
}

export const _compareExecutionCheckpoints = (
  left: TranscriptRepository.ExecutionCheckpoint,
  right: TranscriptRepository.ExecutionCheckpoint,
): number => {
  if (left.executionKey < right.executionKey) return -1
  if (left.executionKey > right.executionKey) return 1
  return 0
}

export const createTurn = Effect.fn("TranscriptRepositoryTest.createTurn")(function* (
  threadId: Thread.ThreadId,
  turnId: Turn.TurnId,
  prompt: string,
) {
  const threads = yield* ThreadRepository.Service
  const turns = yield* TurnRepository.Service
  if ((yield* threads.get(threadId)) === undefined)
    yield* threads.create({ id: threadId, workspace: `/work/${threadId}`, title: String(threadId), now: 1 })
  yield* turns.createForSubmission({
    id: turnId,
    threadId,
    prompt,
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
    queueCapacity: 128,
    now: 2,
  })
  return yield* turns.setStatus(turnId, "completed", undefined, 3)
})

export { expect, it }
export { Effect, FileSystem, Schema }
export {
  BunServices,
  TranscriptCorrelation,
  TranscriptOrdering,
  TranscriptProjection,
  TranscriptProjectionModel,
  TranscriptSourceEvent,
  TranscriptUnit,
  SqlClient,
  Thread,
  ThreadRepository,
  TranscriptRepository,
  TurnRepository,
  Turn,
}
export { commitAll, event, projectionVersion, provideLayer, sqliteLayer, unit }
export { executionCheckpoint } from "./transcript-fixture-checkpoints"
