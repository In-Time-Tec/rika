import type { PageCursor } from "@rika/product/transcript-page"
import type { ThreadViewSnapshot, ThreadViewSource } from "@rika/product/thread-view"
import { compareUnitOrder, encodeUnitOrder } from "@rika/transcript/transcript-unit-order"

type View = ThreadViewSnapshot
const compareCursor = (left: PageCursor, right: PageCursor) => {
  const order = left.orderKey < right.orderKey ? -1 : Number(left.orderKey > right.orderKey)
  return left.createdAt - right.createdAt || String(left.turnId).localeCompare(String(right.turnId)) || order
}
const withOldest = (source: ThreadViewSource, oldestCursor: PageCursor | undefined): ThreadViewSource =>
  oldestCursor === undefined ? source : { ...source, oldestCursor }

const matchingRevisions = (older: View, latest: View) => {
  const revisions = new Map(older.turns.map((entry) => [entry.turn.id, entry.projectionRevision]))
  return latest.turns.every((turn) => {
    const revision = revisions.get(turn.turn.id)
    return revision === undefined || revision === turn.projectionRevision
  })
}

/** Only retain the prefix outside a replacement's contiguous authoritative range. */
const prepend = (older: View, latest: View): View => {
  const boundary = latest.source.oldestCursor
  if (
    older.thread.id !== latest.thread.id ||
    older.source.projectionVersion !== latest.source.projectionVersion ||
    !latest.hasOlder ||
    boundary === undefined
  )
    return latest
  const turns = new Map(latest.turns.map((turn) => [String(turn.turn.id), turn]))
  for (const entry of older.turns) {
    const current = turns.get(String(entry.turn.id))
    if (current !== undefined && current.projectionRevision !== entry.projectionRevision) continue
    const prefix = entry.units.filter(
      (unit) =>
        compareCursor(
          { createdAt: entry.turn.createdAt, turnId: entry.turn.id, orderKey: encodeUnitOrder(unit.order) },
          boundary,
        ) < 0,
    )
    if (prefix.length === 0) continue
    const units = new Map(prefix.map((unit) => [unit.key, unit]))
    for (const unit of current?.units ?? []) units.set(unit.key, unit)
    turns.set(String(entry.turn.id), {
      ...(current ?? entry),
      units: [...units.values()].toSorted((a, b) => compareUnitOrder(a.order, b.order)),
    })
  }
  return {
    ...latest,
    turns: [...turns.values()].toSorted(
      (a, b) => a.turn.createdAt - b.turn.createdAt || String(a.turn.id).localeCompare(String(b.turn.id)),
    ),
  }
}

const merge = (older: View, latest: View): View => ({
  ...prepend(older, latest),
  hasOlder: older.hasOlder,
  source: withOldest(latest.source, older.source.oldestCursor),
})

const boundaryRevisionMatches = (cached: View, incoming: View): boolean => {
  const turnId = incoming.source.oldestCursor?.turnId
  const older = cached.turns.find((entry) => entry.turn.id === turnId)
  const latest = incoming.turns.find((entry) => entry.turn.id === turnId)
  return older === undefined || latest === undefined || older.projectionRevision === latest.projectionRevision
}

const retain = (cached: View | undefined, incoming: View): View => {
  if (
    cached === undefined ||
    !incoming.hasOlder ||
    cached.thread.id !== incoming.thread.id ||
    cached.source.projectionVersion !== incoming.source.projectionVersion ||
    cached.source.newestCursor === undefined ||
    cached.source.oldestCursor === undefined ||
    incoming.source.oldestCursor === undefined ||
    compareCursor(incoming.source.oldestCursor, cached.source.newestCursor) > 0 ||
    compareCursor(incoming.source.oldestCursor, cached.source.oldestCursor) < 0 ||
    !boundaryRevisionMatches(cached, incoming)
  )
    return incoming
  return merge(cached, incoming)
}

const validPage = (page: View, starting: View, before: PageCursor) =>
  page.thread.id === starting.thread.id &&
  page.source.projectionVersion === starting.source.projectionVersion &&
  (!page.hasOlder || (page.source.oldestCursor !== undefined && compareCursor(page.source.oldestCursor, before) < 0)) &&
  matchingRevisions(page, starting)

export const HistoryView = { merge, retain, validPage, withOldest }
