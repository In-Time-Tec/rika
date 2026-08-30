import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"

export const link = { runId: "root-run", threadId: "thread", turnId: "turn" }

export const turn: Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: Turn.TurnId.make("turn"),
  threadId: Thread.ThreadId.make("thread"),
  prompt: "work",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  executionLink: link,
  status: "running",
  createdAt: 0,
  updatedAt: 0,
}
