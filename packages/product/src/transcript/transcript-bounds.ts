import { Function } from "effect"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { selectTranscriptWindow } from "./transcript-window-selection"

export const transcriptPageEncoder = new TextEncoder()
export const maximumTranscriptPageBytes = 8 * 1024 * 1024
export const maximumTranscriptPayloadBytes = maximumTranscriptPageBytes - 64 * 1024

const sameTranscriptCursorImpl = (
  left: TranscriptPage.PageCursor | undefined,
  right: TranscriptPage.PageCursor | undefined,
  encodeJson: (value: unknown) => string,
) => left !== undefined && right !== undefined && encodeJson(left) === encodeJson(right)

export const sameTranscriptCursor: {
  (
    arg1: TranscriptPage.PageCursor | undefined,
    arg2: (value: unknown) => string,
  ): (arg0: TranscriptPage.PageCursor | undefined) => ReturnType<typeof sameTranscriptCursorImpl>
  (
    arg0: TranscriptPage.PageCursor | undefined,
    arg1: TranscriptPage.PageCursor | undefined,
    arg2: (value: unknown) => string,
  ): ReturnType<typeof sameTranscriptCursorImpl>
} = Function.dual(3, sameTranscriptCursorImpl)

export const transcriptCursorFor = (entry: TranscriptPage.Entry | undefined): TranscriptPage.PageCursor | undefined =>
  entry === undefined
    ? undefined
    : {
        createdAt: entry.turn.createdAt,
        turnId: entry.turn.id,
        orderKey: TranscriptOrdering.encodeUnitOrder(entry.unit.order),
      }

export const isSemanticTranscriptEntry = (entry: TranscriptPage.Entry): boolean =>
  entry.unit.parentId === undefined &&
  (entry.unit.content._tag === "Entry" ||
    entry.unit.content.block._tag === "Compaction" ||
    entry.unit.executionOutcome !== undefined)

const boundTurnEntriesImpl = (
  entries: ReadonlyArray<TranscriptPage.Entry>,
  detail: number,
): { readonly entries: ReadonlyArray<TranscriptPage.Entry>; readonly contiguousFrom: number } => {
  if (detail >= entries.length) return { entries, contiguousFrom: 0 }
  const semantic = entries.filter(isSemanticTranscriptEntry).length
  const selection = selectTranscriptWindow({
    values: entries,
    unit: (entry) => entry.unit,
    maximum: Math.max(0, detail - semantic),
    focus: "newest",
    retain: isSemanticTranscriptEntry,
  })
  const contiguousFrom =
    selection.contiguousStart === undefined
      ? entries.length
      : Math.max(
          0,
          entries.findIndex((entry) => entry.unit.key === selection.contiguousStart!.unit.key),
        )
  return { entries: selection.values, contiguousFrom }
}

export const boundTurnEntries: {
  (arg1: number): (arg0: ReadonlyArray<TranscriptPage.Entry>) => ReturnType<typeof boundTurnEntriesImpl>
  (arg0: ReadonlyArray<TranscriptPage.Entry>, arg1: number): ReturnType<typeof boundTurnEntriesImpl>
} = Function.dual(2, boundTurnEntriesImpl)

const boundTranscriptEntriesImpl = (
  sourceEntries: ReadonlyArray<TranscriptPage.Entry>,
  encodeJson: (value: unknown) => string,
): {
  readonly entries: ReadonlyArray<TranscriptPage.Entry>
  readonly partialCursor?: TranscriptPage.PageCursor
  readonly truncated: boolean
  readonly oversizedEntry: boolean
} => {
  let entries = sourceEntries
  let boundedStart = entries.length
  let boundedBytes = 0
  while (boundedStart > 0) {
    const entryBytes = transcriptPageEncoder.encode(encodeJson(entries[boundedStart - 1])).byteLength
    if (boundedBytes + entryBytes > maximumTranscriptPayloadBytes) {
      if (boundedStart === entries.length) return { entries: [], truncated: false, oversizedEntry: true }
      const bounded = boundPartialTranscriptEntries(entries, boundedStart, boundedBytes, encodeJson)
      return transcriptPageEncoder.encode(encodeJson(bounded.entries)).byteLength > maximumTranscriptPayloadBytes
        ? { entries: [], truncated: false, oversizedEntry: true }
        : bounded
    }
    boundedStart -= 1
    boundedBytes += entryBytes
  }
  return { entries, truncated: false, oversizedEntry: false }
}

export const boundTranscriptEntries: {
  (
    arg1: (value: unknown) => string,
  ): (arg0: ReadonlyArray<TranscriptPage.Entry>) => ReturnType<typeof boundTranscriptEntriesImpl>
  (
    arg0: ReadonlyArray<TranscriptPage.Entry>,
    arg1: (value: unknown) => string,
  ): ReturnType<typeof boundTranscriptEntriesImpl>
} = Function.dual(2, boundTranscriptEntriesImpl)

const boundPartialTranscriptEntries = (
  sourceEntries: ReadonlyArray<TranscriptPage.Entry>,
  initialStart: number,
  initialBytes: number,
  encodeJson: (value: unknown) => string,
): {
  readonly entries: ReadonlyArray<TranscriptPage.Entry>
  readonly partialCursor?: TranscriptPage.PageCursor
  readonly truncated: true
  readonly oversizedEntry: false
} => {
  let entries = sourceEntries
  let boundedStart = initialStart
  let boundedBytes = initialBytes
  let partialCursor: TranscriptPage.PageCursor | undefined
  const turnBoundary = entries.findIndex(
    (entry, index) => index >= boundedStart && entry.unit.key === `turn:${entry.turn.id}:user`,
  )
  if (turnBoundary < 0) {
    const newest = entries.at(-1)
    const userBoundary =
      newest === undefined ? -1 : entries.findIndex((entry) => entry.unit.key === `turn:${newest.turn.id}:user`)
    if (userBoundary >= 0) {
      const userEntry = entries[userBoundary]!
      const semanticIndexes = new Set([userBoundary])
      let semanticBytes = transcriptPageEncoder.encode(encodeJson(userEntry)).byteLength
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (index === userBoundary) continue
        const entry = entries[index]!
        if (!isSemanticTranscriptEntry(entry)) continue
        const entryBytes = transcriptPageEncoder.encode(encodeJson(entry)).byteLength
        if (semanticBytes + entryBytes > maximumTranscriptPayloadBytes) continue
        semanticIndexes.add(index)
        semanticBytes += entryBytes
      }
      boundedStart = entries.length
      boundedBytes = semanticBytes
      while (boundedStart > userBoundary + 1) {
        const index = boundedStart - 1
        const entryBytes = semanticIndexes.has(index)
          ? 0
          : transcriptPageEncoder.encode(encodeJson(entries[index])).byteLength
        if (boundedBytes + entryBytes > maximumTranscriptPayloadBytes && boundedStart < entries.length) break
        boundedStart -= 1
        boundedBytes += entryBytes
      }
      partialCursor = transcriptCursorFor(entries[boundedStart])
      entries = entries.filter((_, index) => semanticIndexes.has(index) || index >= boundedStart)
    } else entries = entries.slice(boundedStart)
  } else entries = entries.slice(turnBoundary)
  return { entries, ...(partialCursor === undefined ? {} : { partialCursor }), truncated: true, oversizedEntry: false }
}
