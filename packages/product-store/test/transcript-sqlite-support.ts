import * as TranscriptPage from "@rika/product/transcript-page"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Effect, Schema } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "../src/thread/sqlite-thread-repository"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"

export const compareExecutionCheckpoints: CompareExecutionCheckpoints = compareExecutionCheckpointsImplementation

export const _UnitJson = Schema.fromJsonString(TranscriptUnit.Unit)

type CompareExecutionCheckpoints = {
  (left: TranscriptPage.ExecutionCheckpoint, right: TranscriptPage.ExecutionCheckpoint): number
  (right: TranscriptPage.ExecutionCheckpoint): (left: TranscriptPage.ExecutionCheckpoint) => number
}
function compareExecutionCheckpointsImplementation(
  right: TranscriptPage.ExecutionCheckpoint,
): (left: TranscriptPage.ExecutionCheckpoint) => number
function compareExecutionCheckpointsImplementation(
  left: TranscriptPage.ExecutionCheckpoint,
  right: TranscriptPage.ExecutionCheckpoint,
): number
function compareExecutionCheckpointsImplementation(
  leftOrRight: TranscriptPage.ExecutionCheckpoint,
  right?: TranscriptPage.ExecutionCheckpoint,
): number | ((left: TranscriptPage.ExecutionCheckpoint) => number) {
  if (right === undefined) return (left) => compareExecutionCheckpointsImplementation(left, leftOrRight)
  if (leftOrRight.executionKey < right.executionKey) return -1
  if (leftOrRight.executionKey > right.executionKey) return 1
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
  return yield* turns.setStatus(turnId, "completed", 3)
})

export const _usageEvent: TranscriptSourceEvent.SourceEvent = {
  cursor: "usage-5",
  sequence: 5,
  type: "model.attempt.completed",
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
