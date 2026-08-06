import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Function } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"

export const projectionVersion = 3

export const turn: {
  (index: number, threadId?: Thread.ThreadId): Turn.AgentExecutionTurn
  (threadId?: Thread.ThreadId): (index: number) => Turn.AgentExecutionTurn
} = Function.dual(
  (args) => typeof args[0] === "number",
  (index: number, threadId: Thread.ThreadId = Thread.ThreadId.make("thread-a")): Turn.AgentExecutionTurn => ({
    _tag: "AgentExecution",
    id: Turn.TurnId.make(`turn-${index}`),
    threadId,
    prompt: `prompt ${index}`,
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
    status: "completed",
    author: { _tag: "Human" },
    lineage: { _tag: "Original" },
    createdAt: index,
    updatedAt: index,
  }),
)

export const event = (index: number): TranscriptSourceEvent.SourceEvent => ({
  cursor: `cursor-${index}`,
  sequence: index,
  type: index === 2 ? "execution.completed" : "model.output.completed",
  createdAt: index,
  text: `output ${index}`,
})

export const unit: {
  (turnId: Turn.TurnId, sequence: number, part: number, key: string): TranscriptUnit.Unit
  (sequence: number, part: number, key: string): (turnId: Turn.TurnId) => TranscriptUnit.Unit
} = Function.dual(
  4,
  (turnId: Turn.TurnId, sequence: number, part: number, key: string): TranscriptUnit.Unit => ({
    key,
    turnId,
    order: TranscriptOrdering.unitOrder(key, sequence, part),
    revision: sequence,
    content: { _tag: "Entry", role: "assistant", text: key },
  }),
)
