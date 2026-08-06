import { Schema } from "effect"
import { ThreadId } from "./thread-record"
import { TurnId } from "./turn-record"
import { ThreadState } from "./thread-state"

export const SummaryStatus = ThreadState
export type SummaryStatus = typeof SummaryStatus.Type

export const EditTotals = Schema.Struct({
  added: Schema.Int,
  modified: Schema.Int,
  removed: Schema.Int,
})
export type EditTotals = typeof EditTotals.Type

export const ThreadSummary = Schema.Struct({
  id: ThreadId,
  workspace: Schema.String,
  title: Schema.String,
  pinned: Schema.Boolean,
  archived: Schema.Boolean,
  status: SummaryStatus,
  unread: Schema.Boolean,
  lastActivityAt: Schema.Finite,
  editTotals: Schema.optionalKey(EditTotals),
})
export type ThreadSummary = typeof ThreadSummary.Type

export const RepairCandidate = Schema.Struct({
  turnId: TurnId,
  threadId: ThreadId,
  status: Schema.Literals(["accepted", "queued", "running", "waiting", "completed", "failed", "cancelled"]),
})
export type RepairCandidate = typeof RepairCandidate.Type
