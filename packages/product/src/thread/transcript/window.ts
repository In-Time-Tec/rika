import { Effect, Order } from "effect"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptPage from "./page"
import { RepositoryError, type Interface as TranscriptRepositoryInterface } from "../repository/transcript"
import type { ThreadId } from "../model/record"
import { projectionVersion } from "../../execution/projection/contract"
import { boundTranscriptEntries, transcriptCursorFor } from "./bounds"

const compareEntries = (left: TranscriptPage.Entry, right: TranscriptPage.Entry): number =>
  left.turn.createdAt - right.turn.createdAt ||
  Order.String(left.turn.id, right.turn.id) ||
  TranscriptOrdering.compareUnitOrder(left.unit.order, right.unit.order)

/**
 * Restore a bounded set of roots and member cards without loading an unbounded projection.
 * Never combine projection revisions or replace the contiguous page cursor with a sparse structural cursor.
 */
export const completeLeadingTurn = Effect.fn("TranscriptWindow.completeLeadingTurn")(function* (
  page: TranscriptPage.Page,
  transcripts: Pick<TranscriptRepositoryInterface, "page">,
) {
  const oldest = page.entries[0]
  if (oldest === undefined || !page.hasOlder) return page
  const turnId = oldest.turn.id
  const promptKey = `turn:${turnId}:user`
  if (page.entries.some((entry) => entry.unit.key === promptKey)) return page
  const structure = yield* transcripts.page(oldest.turn.threadId, {
    structuralTurnId: turnId,
    limit: TranscriptPage.maximumTranscriptUnits,
    projectionVersion,
  })
  if (
    structure.entries.some(
      (entry) =>
        entry.projectionRevision !== oldest.projectionRevision ||
        entry.projectionGeneration !== oldest.projectionGeneration,
    )
  )
    return page
  const windowed = new Set(page.entries.filter((entry) => entry.turn.id === turnId).map((entry) => entry.unit.key))
  const added = structure.entries.filter((entry) => !windowed.has(entry.unit.key))
  if (added.length === 0) return page
  return { ...page, entries: [...added, ...page.entries].toSorted(compareEntries) }
})

const precedes = (entry: TranscriptPage.Entry, before: TranscriptPage.PageCursor): boolean => {
  const order =
    entry.turn.createdAt - before.createdAt ||
    Order.String(String(entry.turn.id), String(before.turnId)) ||
    Order.String(TranscriptOrdering.encodeUnitOrder(entry.unit.order), before.orderKey)
  return order < 0
}

/** Shared initial/reload read: bounded storage reads followed by structural count/byte selection. */
export const loadTranscriptWindow = Effect.fn("TranscriptWindow.load")(function* (
  threadId: ThreadId,
  transcripts: Pick<TranscriptRepositoryInterface, "page">,
  before?: TranscriptPage.PageCursor,
) {
  const completed = yield* completeLeadingTurn(
    yield* transcripts.page(threadId, { limit: TranscriptPage.maximumTranscriptUnits, projectionVersion, before }),
    transcripts,
  )
  // Structural completion reads the whole leading Turn. Never let later member cards
  // consume an older page's budget or move its cursor back into already loaded history.
  const page =
    before === undefined
      ? completed
      : { ...completed, entries: completed.entries.filter((entry) => precedes(entry, before)) }
  const bounded = boundTranscriptEntries(page.entries, JSON.stringify)
  if (bounded.oversizedEntry)
    return yield* RepositoryError.make({ message: "Transcript entry exceeds the transcript event limit" })
  if (!bounded.truncated) return page
  return {
    ...page,
    entries: bounded.entries,
    hasOlder: true,
    oldestCursor: bounded.partialCursor ?? page.oldestCursor,
    newestCursor: transcriptCursorFor(bounded.entries.at(-1)),
  }
})
