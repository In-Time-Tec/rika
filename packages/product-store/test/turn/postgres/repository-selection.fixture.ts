import * as ExecutionStatus from "@rika/product/execution-status"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import { executionRoute } from "./repository-state.fixture"

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

export const replacementTurn = (status: ExecutionStatus.Status = "running"): Turn.Turn => ({
  ...turnProvenance,
  id: Turn.TurnId.make("replacement-turn"),
  threadId: Thread.ThreadId.make("replacement-thread"),
  prompt: "replacement",
  executionRoute: executionRoute(),
  status,
  createdAt: 1,
  updatedAt: 1,
})
