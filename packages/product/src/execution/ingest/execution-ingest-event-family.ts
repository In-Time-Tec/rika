import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionStatus from "@rika/product/execution-status"
import { Function } from "effect"
import type { InterruptedOutcome } from "./execution-ingest-state"

export const isInterruptedOutcome = (
  outcome: NonNullable<TranscriptUnit.Unit["executionOutcome"]>,
): outcome is InterruptedOutcome => outcome.status === "failed" || outcome.status === "cancelled"

export const childExecutionIds = (event: ExecutionEvent.Event): ReadonlyArray<string> => {
  if (event.type !== "child_run.spawned") return []
  const childRunId = event.data?.child_execution_id
  return typeof childRunId === "string" && childRunId.length > 0 ? [childRunId] : []
}

export const bySequence: {
  (right: ExecutionEvent.Event): (left: ExecutionEvent.Event) => number
  (left: ExecutionEvent.Event, right: ExecutionEvent.Event): number
} = Function.dual(2, (left: ExecutionEvent.Event, right: ExecutionEvent.Event) => left.sequence - right.sequence)

export const settledStatus = (
  status: ExecutionStatus.Status,
): NonNullable<import("@rika/product/transcript-page").ExecutionCheckpoint["status"]> | undefined =>
  status === "completed" || status === "failed" || status === "cancelled" ? status : undefined

export const isTerminalStatus = (status: ExecutionStatus.Status): boolean =>
  status === "completed" || status === "failed" || status === "cancelled"

export const terminalEventStatus = ExecutionStatus.terminalEventStatus
