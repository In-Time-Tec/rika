import * as TranscriptPage from "@rika/product/transcript-page"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { HashMap } from "effect"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import type { ProjectionStream } from "./interactive-controller"

const entryBytes = (entry: TranscriptPage.Entry): number => new TextEncoder().encode(JSON.stringify(entry)).byteLength

export const cursorForEntry = (entry: TranscriptPage.Entry | undefined): TranscriptPage.PageCursor | undefined =>
  entry === undefined
    ? undefined
    : {
        createdAt: entry.turn.createdAt,
        turnId: entry.turn.id,
        orderKey: TranscriptOrdering.encodeUnitOrder(entry.unit.order),
      }

export const sameCursor = (left: TranscriptPage.PageCursor | undefined, right: TranscriptPage.PageCursor | undefined) =>
  left?.createdAt === right?.createdAt && left?.turnId === right?.turnId && left?.orderKey === right?.orderKey

export const boundWindow = (entries: ReadonlyArray<TranscriptPage.Entry>, edge: "oldest" | "newest") => {
  const retained = [...entries]
  let bytes = retained.reduce((total, entry) => total + entryBytes(entry), 0)
  let evicted = false
  while (retained.length > 400 || bytes > 4 * 1024 * 1024) {
    const index = edge === "oldest" ? 0 : retained.length - 1
    bytes -= entryBytes(retained[index]!)
    retained.splice(index, 1)
    evicted = true
  }
  return { entries: retained, evicted }
}

const compareText = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export const normalizeEntries = (entries: ReadonlyArray<TranscriptPage.Entry>): ReadonlyArray<TranscriptPage.Entry> => {
  const unique = new Map<string, TranscriptPage.Entry>()
  for (const entry of entries) {
    const current = unique.get(entry.unit.key)
    if (current === undefined || entry.projectionRevision >= current.projectionRevision)
      unique.set(entry.unit.key, entry)
  }
  return [...unique.values()].toSorted(
    (left, right) =>
      left.turn.createdAt - right.turn.createdAt ||
      compareText(left.turn.id, right.turn.id) ||
      TranscriptOrdering.compareUnitOrder(left.unit.order, right.unit.order),
  )
}

export const revisionsForWindow = (
  entries: ReadonlyArray<TranscriptPage.Entry>,
  activeTurnId: string | undefined,
  current: ReadonlyMap<string, number>,
  projectionStreams: ReadonlyMap<string, ProjectionStream> | undefined,
): ReadonlyMap<string, number> => {
  const revisions = new Map<string, number>(entries.map((entry) => [entry.turn.id, entry.projectionRevision] as const))
  if (activeTurnId !== undefined) {
    const activeRevision = current.get(activeTurnId)
    if (activeRevision !== undefined) revisions.set(activeTurnId, activeRevision)
  }
  for (const [rootTurnId, stream] of projectionStreams ?? [])
    if (stream._tag !== "Stopped") revisions.set(rootTurnId, stream.state.revision)
  return revisions
}

export const projectedRootIds = (
  projectionStreams: ReadonlyMap<string, ProjectionStream> | undefined,
): ReadonlySet<string> =>
  new Set(
    [...(projectionStreams ?? [])].flatMap(([rootTurnId, stream]) => (stream._tag === "Stopped" ? [] : [rootTurnId])),
  )

export const replayTurnsForWindow = (
  entries: ReadonlyArray<TranscriptPage.Entry>,
  previous: ReadonlyMap<string, Turn.Turn>,
  projectionStreams: ReadonlyMap<string, ProjectionStream> | undefined,
  activeTurnId: string | undefined,
): ReadonlyMap<string, Turn.Turn> => {
  const retained = new Set(projectedRootIds(projectionStreams))
  if (activeTurnId !== undefined) retained.add(activeTurnId)
  return new Map([
    ...entries.map((entry) => [entry.turn.id, entry.turn] as const),
    ...[...previous].filter(([turnId]) => retained.has(turnId)),
  ])
}

export const projectionFromStream = (
  stream: Extract<ProjectionStream, { readonly _tag: "Open" | "Failed" }>,
): TranscriptProjectionModel.Projection => ({
  units: HashMap.toValues(stream.units).toSorted((left, right) =>
    TranscriptOrdering.compareUnitOrder(left.order, right.order),
  ),
  revision: stream.state.revision,
  modelPhase: stream.state.modelPhase,
  ...(stream.state.usableCompletionSequence === undefined
    ? {}
    : { usableCompletionSequence: stream.state.usableCompletionSequence }),
})
