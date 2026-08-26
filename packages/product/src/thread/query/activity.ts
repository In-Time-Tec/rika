import * as ExecutionStatus from "../../execution/session/status"
import * as ThreadSummary from "../model/summary"
import type * as ThreadSummaryRepository from "../repository/summary"
import type * as Turn from "../turn/record"
import type { Unit } from "@rika/transcript/transcript-unit"
import { Function, Option, Schema } from "effect"

const DiffOutput = Schema.fromJsonString(Schema.Struct({ diff: Schema.optionalKey(Schema.String) }))

const resultDiff = (output: string | undefined): string | undefined => {
  if (output === undefined) return undefined
  const decoded = Schema.decodeOption(DiffOutput)(output)
  if (Option.isNone(decoded)) return undefined
  const diff = decoded.value.diff
  return diff !== undefined && diff.length > 0 ? diff : undefined
}

export const toolResultDiffs = (units: ReadonlyArray<Unit>): ReadonlyArray<string> =>
  units.flatMap((unit) => {
    if (unit.content._tag !== "Block" || unit.content.block._tag !== "ToolCall") return []
    const diff = resultDiff(unit.content.block.output)
    return diff === undefined ? [] : [diff]
  })

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

export const editTotals = (units: ReadonlyArray<Unit>): ThreadSummary.EditTotals =>
  toolResultDiffs(units).reduce(
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

const projectionInputImpl = (
  turn: Pick<Turn.Turn, "id" | "threadId" | "status" | "updatedAt">,
  units: ReadonlyArray<Unit>,
  now: number,
): ThreadSummaryRepository.TurnActivityInput => ({
  turnId: turn.id,
  threadId: turn.threadId,
  complete: ExecutionStatus.isTerminalStatus(turn.status),
  editTotals: editTotals(units),
  lastEventAt: turn.updatedAt,
  now,
})

export const projectionInput: {
  (
    arg1: Parameters<typeof projectionInputImpl>[1],
    arg2: Parameters<typeof projectionInputImpl>[2],
  ): (arg0: Parameters<typeof projectionInputImpl>[0]) => ReturnType<typeof projectionInputImpl>
  (
    arg0: Parameters<typeof projectionInputImpl>[0],
    arg1: Parameters<typeof projectionInputImpl>[1],
    arg2: Parameters<typeof projectionInputImpl>[2],
  ): ReturnType<typeof projectionInputImpl>
} = Function.dual(3, projectionInputImpl)
