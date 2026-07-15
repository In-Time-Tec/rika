import type { ThreadSummary, ThreadSummaryRepository } from "@rika/persistence"
import type * as Thread from "@rika/persistence/thread"
import * as Turn from "@rika/persistence/turn"
import type * as ExecutionBackend from "@rika/runtime/contract"
import { Function } from "effect"

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {}

const patchFromExplicitEvent = (event: ExecutionBackend.Event): string | undefined => {
  if (!event.type.includes("diff")) return undefined
  if (event.text !== undefined && event.text.length > 0) return event.text
  const data = event.data ?? record(event.content?.[0])
  const patch = data.patch ?? data.diff
  return typeof patch === "string" && patch.length > 0 ? patch : undefined
}

const patchFromToolResult = (event: ExecutionBackend.Event): string | undefined => {
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

export const editTotals = (events: ReadonlyArray<ExecutionBackend.Event>): ThreadSummary.EditTotals => {
  const ordered = events.toSorted((left, right) => left.sequence - right.sequence)
  const explicit = ordered.flatMap((event) => {
    const patch = patchFromExplicitEvent(event)
    return patch === undefined ? [] : [patch]
  })
  const patches =
    explicit.length > 0
      ? explicit
      : ordered.flatMap((event) => {
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

export const projectionInput: {
  (
    result: ExecutionBackend.Result,
    now: number,
  ): (threadId: Thread.ThreadId) => ThreadSummaryRepository.TurnActivityInput
  (threadId: Thread.ThreadId, result: ExecutionBackend.Result, now: number): ThreadSummaryRepository.TurnActivityInput
} = Function.dual(
  3,
  (
    threadId: Thread.ThreadId,
    result: ExecutionBackend.Result,
    now: number,
  ): ThreadSummaryRepository.TurnActivityInput => ({
    turnId: Turn.TurnId.make(result.turnId),
    threadId,
    ...(result.events.at(-1)?.cursor === undefined ? {} : { projectedCursor: result.events.at(-1)!.cursor }),
    complete: result.status === "completed" || result.status === "failed" || result.status === "cancelled",
    editTotals: editTotals(result.events),
    ...(result.events.length === 0 ? {} : { lastEventAt: Math.max(...result.events.map((event) => event.createdAt)) }),
    now,
  }),
)
