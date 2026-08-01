import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionStatus from "@rika/product/execution-status"
import type { InterruptedOutcome } from "./execution-ingest-state"

export const isInterruptedOutcome = (
  outcome: NonNullable<TranscriptUnit.Unit["executionOutcome"]>,
): outcome is InterruptedOutcome => outcome.status === "failed" || outcome.status === "cancelled"

export const childExecutionIds = (event: ExecutionEvent.Event): ReadonlyArray<string> => {
  const ids = new Set<string>()
  const addAliases = (value: Readonly<Record<string, unknown>> | undefined) => {
    if (value === undefined) return
    for (const alias of ["child_execution_id", "child_run_id", "childId", "child_id"] as const) {
      const id = value[alias]
      if (typeof id === "string" && id.length > 0) ids.add(id)
    }
  }
  if (event.childExecutionId !== undefined && event.childExecutionId.length > 0) ids.add(event.childExecutionId)
  addAliases(event.data)
  const member = event.data?.member
  if (member !== null && typeof member === "object") addAliases(member as Readonly<Record<string, unknown>>)
  if (event.type === "child_fan_out.created" && Array.isArray(event.data?.children))
    for (const child of event.data.children)
      if (child !== null && typeof child === "object") addAliases(child as Readonly<Record<string, unknown>>)
  return [...ids]
}

export const bySequence = (left: ExecutionEvent.Event, right: ExecutionEvent.Event) => left.sequence - right.sequence

export const settledStatus = (
  status: ExecutionStatus.Status,
): NonNullable<import("@rika/product/transcript-page").ExecutionCheckpoint["status"]> | undefined =>
  status === "completed" || status === "failed" || status === "cancelled" ? status : undefined

export const isTerminalStatus = (status: ExecutionStatus.Status): boolean =>
  status === "completed" || status === "failed" || status === "cancelled"

export const terminalEventStatus = ExecutionStatus.terminalEventStatus
