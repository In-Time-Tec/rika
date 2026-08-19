import { Function } from "effect"
import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as ViewState from "@rika/terminal/terminal-state"

export const thread: Thread.Thread = {
  id: Thread.ThreadId.make("thread-a"),
  workspace: "/work",
  title: "Thread A",
  lineage: { _tag: "Original" },
  labels: [],
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
}

type SemanticFixture = {
  readonly cursor: string
  readonly sequence: number
  readonly type: string
  readonly createdAt: number
  readonly text?: string
  readonly data?: Readonly<Record<string, unknown>>
}
const entriesImpl = (id: string, createdAt: number, events: ReadonlyArray<SemanticFixture> = []) => {
  const turn: Turn.AgentExecutionTurn = {
    _tag: "AgentExecution",
    id: Turn.TurnId.make(id),
    threadId: thread.id,
    prompt: id,
    author: { _tag: "Human" },
    lineage: { _tag: "Original" },
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
    status: "completed",
    createdAt,
    updatedAt: createdAt,
  }
  const units = [
    {
      key: `turn:${id}:user`,
      turnId: turn.id,
      order: TranscriptOrdering.unitOrder(`turn:${id}:user`, 0),
      revision: 0,
      content: { _tag: "Entry" as const, role: "user" as const, text: id },
    },
    ...events.flatMap((event) =>
      event.type === "model.output.completed" || event.type === "model.output.delta"
        ? [
            {
              key: `assistant:${id}:${event.sequence}`,
              turnId: turn.id,
              order: TranscriptOrdering.unitOrder(`assistant:${id}:${event.sequence}`, event.sequence + 1),
              revision: event.sequence + 1,
              content: { _tag: "Entry" as const, role: "assistant" as const, text: event.text ?? "" },
            },
          ]
        : [],
    ),
  ]
  const revision = units.reduce((maximum, unit) => Math.max(maximum, unit.revision), 0)
  return units.map((unit) => ({ turn, unit, projectionRevision: revision, projectionModelPhase: -1 }))
}

export const initialState = (): InteractiveController.State => ({
  model: ViewState.initial("/work", "medium"),
})

export const entries: {
  (id: string, createdAt: number, events?: ReadonlyArray<SemanticFixture>): ReturnType<typeof entriesImpl>
  (createdAt: number, events?: ReadonlyArray<SemanticFixture>): (id: string) => ReturnType<typeof entriesImpl>
} = Function.dual((args) => typeof args[0] === "string", entriesImpl)
