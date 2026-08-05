import { Fixtures } from "./thread-query-support"

export const workspace = "/work/acme"
export const storedThread: Fixtures.Thread.Thread = {
  id: Fixtures.Thread.ThreadId.make("one"),
  workspace,
  title: "Fix auth",
  labels: ["bug"],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 2,
}
export const storedTurn: Fixtures.Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: Fixtures.Turn.TurnId.make("turn-1"),
  threadId: storedThread.id,
  prompt: "fix auth",
  executionRoute: Fixtures.ExecutionRouteSnapshot.testExecutionRoute(),
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  status: "completed",
  executionLink: { runId: "turn-1-run", turnId: "turn-1", threadId: "one" },
  createdAt: 1,
  updatedAt: 2,
}
export const storedRunId = "turn-1-run"
export const projection = (
  units: ReadonlyArray<Fixtures.TranscriptUnit.Unit>,
): Fixtures.TranscriptProjectionModel.Projection => ({
  units,
  revision: units.reduce((maximum, unit) => Math.max(maximum, unit.revision), -1),
  modelPhase: 0,
})
export const relatedThread: Fixtures.Thread.Thread = {
  ...storedThread,
  id: Fixtures.Thread.ThreadId.make("two"),
  title: "Related work",
  createdAt: 3,
  updatedAt: 3,
}
export const stateThreads = (["waiting", "running", "queued", "failed"] as const).map((status, index) => ({
  thread: {
    ...storedThread,
    id: Fixtures.Thread.ThreadId.make(`state-${status}`),
    title: status,
    createdAt: 10 + index,
    updatedAt: 10 + index,
  },
  turn: {
    ...storedTurn,
    id: Fixtures.Turn.TurnId.make(`turn-${status}`),
    threadId: Fixtures.Thread.ThreadId.make(`state-${status}`),
    status,
    createdAt: 10 + index,
    updatedAt: 10 + index,
  },
}))
