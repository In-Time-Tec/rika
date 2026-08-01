import { Fixtures } from "./execution-ingest-support"
import { Effect } from "effect"
import { executionRoute } from "../../../product-store/test/support/product-test-current-state"

const threadId = Fixtures.Thread.ThreadId.make("ingest-thread")
const rootId = Fixtures.Turn.TurnId.make("root")
const childId = "child:root:call_1"
const grandchildId = "child:child%3Aroot%3Acall_1:call_2"
const checkpoint = (projection: Fixtures.TranscriptPage.Projection | undefined, key: string) =>
  projection?.executionCheckpoints.find(
    (entry) => entry.executionKey === Fixtures.TranscriptCorrelation.executionKey(key),
  )
const makeTurn = (status: Fixtures.ExecutionStatus.Status): Fixtures.Turn.AgentExecutionTurn => ({
  _tag: "AgentExecution",
  id: rootId,
  threadId,
  prompt: "delegate",
  stopIntent: "none",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: executionRoute(),
  status,
  createdAt: 1,
  updatedAt: 1,
})
const event = (
  executionId: string,
  cursor: string,
  sequence: number,
  type: string,
  extra: Partial<Fixtures.ExecutionEvent.Event> = {},
): Fixtures.ExecutionEvent.Event => ({
  executionId,
  cursor,
  sequence,
  type,
  createdAt: sequence,
  timestampSource: "server",
  ...extra,
})
const started = (executionId: string): Fixtures.ExecutionEvent.Event =>
  event(executionId, `${executionId}:started`, 0, "execution.started", { createdAt: 0 })
const rootEvents: ReadonlyArray<Fixtures.ExecutionEvent.Event> = [
  started("root"),
  event("root", "r1", 1, "tool.call.requested", {
    data: { tool_call_id: "call_1", tool_name: "task", input: { prompt: "go" } },
  }),
  event("root", "r2", 2, "child_run.spawned", { data: { child_execution_id: childId, preset_name: "Oracle" } }),
  event("root", "r3", 3, "execution.completed"),
]
const childEvents: ReadonlyArray<Fixtures.ExecutionEvent.Event> = [
  started(childId),
  event(childId, "c1", 1, "tool.call.requested", {
    data: { tool_call_id: "child_call", tool_name: "bash", input: { command: "bun test" } },
  }),
  event(childId, "c2", 2, "model.output.completed", { text: "child answered" }),
  event(childId, "c3", 3, "execution.completed"),
]

export const ExecutionFixtures = {
  threadId,
  rootId,
  childId,
  grandchildId,
  checkpoint,
  makeTurn,
  event,
  started,
  rootEvents,
  childEvents,
  Effect,
}
