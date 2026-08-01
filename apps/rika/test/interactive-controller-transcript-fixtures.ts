import * as TranscriptPage from "@rika/product/transcript-page"
import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ThreadResult from "@rika/product/thread-result"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
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

export const entries = (
  id: string,
  createdAt: number,
  events: ReadonlyArray<{
    readonly cursor: string
    readonly sequence: number
    readonly type: string
    readonly createdAt: number
    readonly text?: string
    readonly data?: Readonly<Record<string, unknown>>
  }> = [],
) => {
  const turn = {
    _tag: "AgentExecution" as const,
    id: Turn.TurnId.make(id),
    threadId: thread.id,
    prompt: id,
    author: { _tag: "Human" } as const,
    lineage: { _tag: "Original" } as const,
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
    status: "completed" as const,
    stopIntent: "none" as const,
    createdAt,
    updatedAt: createdAt,
  }
  const projection = TranscriptProjection.Projection.project(id, id, events)
  return projection.units.map((unit) =>
    Object.assign(
      {
        turn,
        unit,
        projectionRevision: projection.revision,
        projectionModelPhase: projection.modelPhase,
      },
      projection.costUsd === undefined ? {} : { projectionCostUsd: projection.costUsd },
    ),
  )
}

type AgentTranscriptEntry = Omit<TranscriptPage.Entry, "turn"> & {
  readonly turn: Turn.AgentExecutionTurn
}

export const asRunningEntry = (entry: TranscriptPage.Entry): AgentTranscriptEntry => {
  if (!ThreadResult.TurnResult.isAgentExecution(entry.turn))
    throw new TypeError("Running transcript fixture requires an agent turn")
  return { ...entry, turn: { ...entry.turn, status: "running" } }
}

export const cursor = (entry: TranscriptPage.Entry): TranscriptPage.PageCursor => ({
  createdAt: entry.turn.createdAt,
  turnId: entry.turn.id,
  orderKey: TranscriptOrdering.encodeUnitOrder(entry.unit.order),
})

export const initialState = (): InteractiveController.State => ({
  model: ViewState.initial("/work", "medium"),
  replayTurns: new Map(),
  entries: [],
  revisions: new Map(),
  liveProjections: new Map(),
  threadCostUsd: 0,
  selectionEpoch: 0,
})

export const visibleState = (projection: TranscriptProjectionModel.Projection) => ({
  revision: projection.revision,
  modelPhase: projection.modelPhase,
  ...(projection.usableCompletionSequence === undefined
    ? {}
    : { usableCompletionSequence: projection.usableCompletionSequence }),
})

export const unitDelta = (
  previous: TranscriptProjectionModel.Projection,
  next: TranscriptProjectionModel.Projection,
): TranscriptProjection.UnitDelta => {
  const previousUnits = new Map(previous.units.map((unit) => [unit.key, unit] as const))
  const nextUnits = new Map(next.units.map((unit) => [unit.key, unit] as const))
  return {
    upsert: next.units.filter((unit) => JSON.stringify(previousUnits.get(unit.key)) !== JSON.stringify(unit)),
    remove: previous.units.flatMap((unit) => (nextUnits.has(unit.key) ? [] : [unit.key])),
  }
}
