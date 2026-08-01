import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import { executionRoute } from "./product-test-current-state"

export const turnProvenance = {
  _tag: "AgentExecution" as const,
  author: { _tag: "Human" as const },
  lineage: { _tag: "Original" as const },
}

export const threadLineage = { _tag: "Original" as const }

export const selectionThread = (id: string): Thread.Thread => ({
  id: Thread.ThreadId.make(id),
  workspace: "/work",
  title: id,
  lineage: threadLineage,
  labels: [],
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
})

export const replacementTurn = (status: Turn.Status = "running"): Turn.Turn => ({
  ...turnProvenance,
  id: Turn.TurnId.make("replacement-turn"),
  threadId: Thread.ThreadId.make("replacement-thread"),
  prompt: "replacement",
  executionRoute: executionRoute(),
  status,
  stopIntent: "none",
  createdAt: 1,
  updatedAt: 1,
})

export const replacementWorkflow = (
  status: ExecutionBackend.WorkflowInspection["status"],
): ExecutionBackend.WorkflowInspection => ({
  runId: "replacement-workflow",
  workflow: "delivery",
  revision: 1,
  digest: "digest",
  status,
  createdAt: 1,
  updatedAt: 1,
})
