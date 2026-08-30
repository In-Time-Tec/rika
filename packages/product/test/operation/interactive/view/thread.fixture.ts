import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"

export const threadId = Thread.ThreadId.make("thread")
export const turnId = Turn.TurnId.make("turn")
export const thread: Thread.Thread = {
  id: threadId,
  workspace: "/workspace",
  title: "Thread",
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}
export const turn: Turn.Turn = {
  _tag: "AgentExecution",
  id: turnId,
  threadId,
  prompt: "prompt",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  status: "running",
  createdAt: 1,
  updatedAt: 1,
}
