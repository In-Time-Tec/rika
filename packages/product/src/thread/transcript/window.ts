import { Effect, Order } from "effect"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import type * as TranscriptPage from "./page"
import type { Interface as TranscriptRepositoryInterface } from "../repository/transcript"

const compareEntries = (left: TranscriptPage.Entry, right: TranscriptPage.Entry): number =>
  left.turn.createdAt - right.turn.createdAt ||
  Order.String(left.turn.id, right.turn.id) ||
  TranscriptOrdering.compareUnitOrder(left.unit.order, right.unit.order)

const blockId = (unit: TranscriptUnit.Unit): string | undefined =>
  unit.content._tag === "Block" && "id" in unit.content.block ? unit.content.block.id : undefined

/**
 * Units a partially windowed turn needs so that its windowed units render: the prompt, every root-level
 * unit, and every ancestor of a windowed unit. Units already in the window are excluded.
 */
const structuralUnits = (
  units: ReadonlyArray<TranscriptUnit.Unit>,
  windowed: ReadonlySet<string>,
): ReadonlyArray<TranscriptUnit.Unit> => {
  const byBlockId = new Map<string, TranscriptUnit.Unit>()
  for (const unit of units) {
    const id = blockId(unit)
    if (id !== undefined) byBlockId.set(id, unit)
  }
  const required = new Set<string>()
  const requireAncestors = (unit: TranscriptUnit.Unit) => {
    let parentId = unit.parentId
    while (parentId !== undefined) {
      const parent = byBlockId.get(parentId)
      if (parent === undefined || required.has(parent.key)) return
      required.add(parent.key)
      parentId = parent.parentId
    }
  }
  for (const unit of units) {
    if (unit.parentId === undefined) required.add(unit.key)
    else if (windowed.has(unit.key)) requireAncestors(unit)
  }
  return units.filter((unit) => required.has(unit.key) && !windowed.has(unit.key))
}

/**
 * A newest-first row-count page can start in the middle of a turn, leaving nested units without their
 * prompt, cards, or parent tool calls. Add that turn's structural units so the window always renders.
 * The page cursor keeps pointing at the oldest contiguous entry, like byte-bounded partial pages.
 */
export const completeLeadingTurn = Effect.fn("TranscriptWindow.completeLeadingTurn")(function* (
  page: TranscriptPage.Page,
  transcripts: Pick<TranscriptRepositoryInterface, "get">,
) {
  const oldest = page.entries[0]
  if (oldest === undefined || !page.hasOlder) return page
  const turnId = oldest.turn.id
  const promptKey = `turn:${turnId}:user`
  if (page.entries.some((entry) => entry.unit.key === promptKey)) return page
  const projection = yield* transcripts.get(turnId)
  if (projection === undefined) return page
  const windowed = new Set(page.entries.filter((entry) => entry.turn.id === turnId).map((entry) => entry.unit.key))
  const added = structuralUnits(projection.units, windowed).map(
    (unit): TranscriptPage.Entry => ({
      turn: oldest.turn,
      unit,
      projectionRevision: oldest.projectionRevision,
      projectionModelPhase: oldest.projectionModelPhase,
      projectionState: oldest.projectionState,
    }),
  )
  if (added.length === 0) return page
  return { ...page, entries: [...added, ...page.entries].toSorted(compareEntries) }
})
