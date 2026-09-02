import { Schema } from "effect"
import { ThreadId } from "./record"
import { TurnId } from "../turn/record"
import { ThreadState } from "./state"

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
  turnCount: Schema.Int,
  editTotals: Schema.optionalKey(EditTotals),
})
export type ThreadSummary = typeof ThreadSummary.Type

/**
 * The Thread `thread continue --last` reopens. Summaries arrive ordered by activity, but a Thread created moments
 * ago and never prompted ranks first by that order while having nothing to continue, so the most recently active
 * Thread with at least one Turn wins. Only when no Thread has a Turn does the newest empty Thread count.
 */
export const lastContinuable = (summaries: ReadonlyArray<ThreadSummary>): ThreadSummary | undefined =>
  summaries.find((summary) => summary.turnCount > 0) ?? summaries[0]

export const RepairCandidate = Schema.Struct({
  turnId: TurnId,
  threadId: ThreadId,
  status: Schema.Literals([
    "accepted",
    "queued",
    "running",
    "waiting",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
  ]),
})
export type RepairCandidate = typeof RepairCandidate.Type
