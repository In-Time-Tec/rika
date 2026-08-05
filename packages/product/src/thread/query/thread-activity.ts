import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionStatus from "../../execution/contract/execution-status"
import * as ThreadSummary from "../model/thread-summary"
import * as ThreadSummaryRepository from "../repository/thread-summary-repository"
import type * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Function } from "effect"

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {}

const patchFromToolResult = (event: ExecutionEvent.Event): string | undefined => {
  if (event.type !== "tool.result.received") return undefined
  const data = event.data ?? record(event.content?.[0])
  const diff = record(data.output).diff
  return typeof diff === "string" && diff.length > 0 ? diff : undefined
}

const addChangeBlock = (totals: ThreadSummary.EditTotals, added: number, removed: number): ThreadSummary.EditTotals => {
  const modified = Math.min(added, removed)
  return {
    added: totals.added + added - modified,
    modified: totals.modified + modified,
    removed: totals.removed + removed - modified,
  }
}

export const editTotalsForPatch = (patch: string): ThreadSummary.EditTotals => {
  let totals: ThreadSummary.EditTotals = { added: 0, modified: 0, removed: 0 }
  let added = 0
  let removed = 0
  let insideHunk = false
  const flush = () => {
    totals = addChangeBlock(totals, added, removed)
    added = 0
    removed = 0
  }
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      flush()
      insideHunk = true
    } else if (!insideHunk) continue
    else if (line.startsWith("+++") || line.startsWith("---")) flush()
    else if (line.startsWith("+")) added += 1
    else if (line.startsWith("-")) removed += 1
    else flush()
  }
  flush()
  return totals
}

export const editTotals = (events: ReadonlyArray<ExecutionEvent.Event>): ThreadSummary.EditTotals => {
  const ordered = events.toSorted((left, right) => left.sequence - right.sequence)
  const patches = ordered.flatMap((event) => {
    const patch = patchFromToolResult(event)
    return patch === undefined ? [] : [patch]
  })
  return patches.reduce(
    (total, patch) => {
      const next = editTotalsForPatch(patch)
      return {
        added: total.added + next.added,
        modified: total.modified + next.modified,
        removed: total.removed + next.removed,
      }
    },
    { added: 0, modified: 0, removed: 0 },
  )
}

export const latestCursor: {
  (runId: string, events: ReadonlyArray<ExecutionEvent.Event>): string | undefined
  (events: ReadonlyArray<ExecutionEvent.Event>): (runId: string) => string | undefined
} = Function.dual(
  2,
  (runId: string, events: ReadonlyArray<ExecutionEvent.Event>): string | undefined =>
    events
      .filter((event) => event.executionId === runId && !TranscriptProjection.Fold.isTransientEvent(event))
      .reduce<
        ExecutionEvent.Event | undefined
      >((current, event) => (current === undefined || event.sequence >= current.sequence ? event : current), undefined)
      ?.cursor,
)

export const finalAssistantOutput = (events: ReadonlyArray<ExecutionEvent.Event>): string | undefined => {
  const latestToolSequence = events.reduce(
    (latest, event) => (event.type === "tool.call.requested" ? Math.max(latest, event.sequence) : latest),
    -1,
  )
  return events
    .flatMap((event) => {
      if (event.type !== "model.output.completed" || event.sequence <= latestToolSequence) return []
      const text =
        event.text ??
        event.content
          ?.flatMap((part) => {
            const value = record(part)
            return value.type === "text" && typeof value.text === "string" ? [value.text] : []
          })
          .join("")
      return text === undefined || text.trim().length === 0 ? [] : [{ sequence: event.sequence, text }]
    })
    .toSorted((left, right) => left.sequence - right.sequence)
    .at(-1)?.text
}

export const projectionInput: {
  (result: ExecutionEvent.Result, now: number): (threadId: Thread.ThreadId) => ThreadSummaryRepository.TurnActivityInput
  (threadId: Thread.ThreadId, result: ExecutionEvent.Result, now: number): ThreadSummaryRepository.TurnActivityInput
} = Function.dual(
  3,
  (
    threadId: Thread.ThreadId,
    result: ExecutionEvent.Result,
    now: number,
  ): ThreadSummaryRepository.TurnActivityInput => {
    const projectedCursor = latestCursor(result.turnId, result.events)
    return {
      turnId: Turn.TurnId.make(result.turnId),
      threadId,
      ...(projectedCursor === undefined ? {} : { projectedCursor }),
      complete: ExecutionStatus.isTerminalStatus(result.status),
      editTotals: editTotals(result.events),
      ...(result.events.length === 0
        ? {}
        : { lastEventAt: Math.max(...result.events.map((event) => event.createdAt)) }),
      now,
    }
  },
)
