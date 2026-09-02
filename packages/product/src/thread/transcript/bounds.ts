import { Function } from "effect"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"

export const transcriptPageEncoder = new TextEncoder()
const maximumTranscriptPageBytes = 32 * 1024 * 1024
export const maximumTranscriptPayloadBytes = maximumTranscriptPageBytes - 64 * 1024

interface JsonEncoder {
  <Value>(value: Value): string
}

interface BoundedTranscriptEntries {
  readonly entries: ReadonlyArray<TranscriptPage.Entry>
  readonly partialCursor?: TranscriptPage.PageCursor
  readonly truncated: boolean
  readonly oversizedEntry: boolean
}

export const transcriptCursorFor = (entry: TranscriptPage.Entry | undefined): TranscriptPage.PageCursor | undefined =>
  entry === undefined
    ? undefined
    : {
        createdAt: entry.turn.createdAt,
        turnId: entry.turn.id,
        orderKey: TranscriptOrdering.encodeUnitOrder(entry.unit.order),
      }

const isSemanticTranscriptEntry = (entry: TranscriptPage.Entry): boolean =>
  entry.unit.parentId === undefined &&
  (entry.unit.content._tag === "Entry" ||
    entry.unit.content.block._tag === "Compaction" ||
    entry.unit.content.block._tag === "ToolCall" ||
    entry.unit.executionOutcome !== undefined)

const boundTranscriptEntriesImpl = (
  sourceEntries: ReadonlyArray<TranscriptPage.Entry>,
  encodeJson: JsonEncoder,
): BoundedTranscriptEntries => {
  const entries = sourceEntries
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
  (arg1: JsonEncoder): (arg0: ReadonlyArray<TranscriptPage.Entry>) => ReturnType<typeof boundTranscriptEntriesImpl>
  (arg0: ReadonlyArray<TranscriptPage.Entry>, arg1: JsonEncoder): ReturnType<typeof boundTranscriptEntriesImpl>
} = Function.dual(2, boundTranscriptEntriesImpl)

const boundPartialTranscriptEntries = (
  sourceEntries: ReadonlyArray<TranscriptPage.Entry>,
  initialStart: number,
  initialBytes: number,
  encodeJson: JsonEncoder,
): BoundedTranscriptEntries => {
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
      const userEntry = entries[userBoundary]
      if (userEntry === undefined)
        return { entries: entries.slice(boundedStart), truncated: true, oversizedEntry: false }
      const semanticIndexes = new Set([userBoundary])
      let semanticBytes = transcriptPageEncoder.encode(encodeJson(userEntry)).byteLength
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (index === userBoundary) continue
        const entry = entries[index]
        if (entry === undefined) continue
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
  return partialCursor === undefined
    ? { entries, truncated: true, oversizedEntry: false }
    : { entries, partialCursor, truncated: true, oversizedEntry: false }
}
