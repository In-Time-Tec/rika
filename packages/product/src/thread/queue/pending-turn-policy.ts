import * as Turn from "@rika/product/turn-record"
import * as Thread from "@rika/product/thread-record"
import { Function, Schema } from "effect"

export const queuedTurnPromoteMaxAgeMs = 86_400_000

export class StaleQueuedTurns extends Schema.TaggedErrorClass<StaleQueuedTurns>()("StaleQueuedTurns", {
  threadId: Thread.ThreadId,
  turnIds: Schema.Array(Turn.TurnId),
  maxAgeMs: Schema.Finite,
  message: Schema.String,
}) {}

export const staleQueuedTurns: {
  (
    now: number,
    maxAgeMs: number,
  ): (turns: ReadonlyArray<Turn.AgentExecutionTurn>) => ReadonlyArray<Turn.AgentExecutionTurn>
  (turns: ReadonlyArray<Turn.AgentExecutionTurn>, now: number, maxAgeMs: number): ReadonlyArray<Turn.AgentExecutionTurn>
} = Function.dual(
  3,
  (
    turns: ReadonlyArray<Turn.AgentExecutionTurn>,
    now: number,
    maxAgeMs: number,
  ): ReadonlyArray<Turn.AgentExecutionTurn> => turns.filter((turn) => now - turn.createdAt > maxAgeMs),
)

export const staleQueuedTurnsError: {
  (
    turns: ReadonlyArray<Turn.AgentExecutionTurn>,
    now: number,
    maxAgeMs: number,
  ): (threadId: Thread.ThreadId) => StaleQueuedTurns | undefined
  (
    threadId: Thread.ThreadId,
    turns: ReadonlyArray<Turn.AgentExecutionTurn>,
    now: number,
    maxAgeMs: number,
  ): StaleQueuedTurns | undefined
} = Function.dual(
  4,
  (
    threadId: Thread.ThreadId,
    turns: ReadonlyArray<Turn.AgentExecutionTurn>,
    now: number,
    maxAgeMs: number,
  ): StaleQueuedTurns | undefined => {
    const stale = staleQueuedTurns(turns, now, maxAgeMs)
    if (stale.length === 0) return undefined
    return StaleQueuedTurns.make({
      threadId,
      turnIds: stale.map((turn) => turn.id),
      maxAgeMs,
      message: `Refusing to auto-run ${stale.length} queued turn(s) older than ${Math.round(maxAgeMs / 60_000)} minutes; dequeue or edit them explicitly`,
    })
  },
)
