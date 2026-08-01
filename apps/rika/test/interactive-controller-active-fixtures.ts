import { Function } from "effect"
import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { entries, initialState, thread } from "./interactive-controller-transcript-fixtures"

export const runningTurn = (id: string): Turn.AgentExecutionTurn => ({
  _tag: "AgentExecution",
  id: Turn.TurnId.make(id),
  threadId: thread.id,
  prompt: `${id} prompt`,
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  status: "running",
  stopIntent: "none",
  createdAt: 2,
  updatedAt: 2,
})

const orphanEntriesImpl = (turn: Turn.Turn, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    turn,
    unit: {
      key: `${turn.id}:nested:${index}`,
      turnId: turn.id,
      order: TranscriptOrdering.unitOrder(`${turn.id}:nested:${index}`, index + 10),
      revision: index + 10,
      parentId: `${turn.id}:agent`,
      content: {
        _tag: "Block" as const,
        block: { _tag: "Notification" as const, title: `nested ${index}`, detail: "detail" },
      },
    },
    projectionRevision: index + 10,
    projectionModelPhase: 0,
  }))

export const orphanEntries: {
  (turn: Turn.Turn, count: number): ReturnType<typeof orphanEntriesImpl>
  (count: number): (turn: Turn.Turn) => ReturnType<typeof orphanEntriesImpl>
} = Function.dual(2, orphanEntriesImpl)

export const populatedSelection = (turn: Turn.Turn) =>
  InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("history", 1, [
      { cursor: "history-answer", sequence: 1, type: "model.output.completed", createdAt: 1, text: "history answer" },
    ]),
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn: turn,
  })

const projectionEventImpl = (turn: Turn.Turn, text: string, transient = false) => ({
  executionId: `execution:${turn.id}`,
  cursor: `output:${text}`,
  sequence: 1,
  type: "model.output.delta",
  createdAt: 3,
  text,
  ...(transient ? { data: { transient: true } } : {}),
})

export const projectionEvent: {
  (turn: Turn.Turn, text: string, transient?: boolean): ReturnType<typeof projectionEventImpl>
  (text: string, transient?: boolean): (turn: Turn.Turn) => ReturnType<typeof projectionEventImpl>
} = Function.dual((args) => typeof args[0] === "object", projectionEventImpl)
