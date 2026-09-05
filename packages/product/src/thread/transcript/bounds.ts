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
  readonly partialCursor?: TranscriptPage.PageCursor | undefined
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

const boundTranscriptEntriesImpl = (
  entries: ReadonlyArray<TranscriptPage.Entry>,
  encodeJson: JsonEncoder,
): BoundedTranscriptEntries => {
  const sizes = entries.map((entry) => transcriptPageEncoder.encode(encodeJson(entry)).byteLength + 1)
  if ((sizes.at(-1) ?? 0) + 1 > maximumTranscriptPayloadBytes)
    return { entries: [], truncated: false, oversizedEntry: true }
  const blocks = new Map<string, number>()
  const prompts = new Map<string, number>()
  const identity = (entry: TranscriptPage.Entry, id: string) => `${entry.turn.id}\0${id}`
  entries.forEach((entry, index) => {
    const { unit } = entry
    if (unit.key === `turn:${entry.turn.id}:user`) prompts.set(entry.turn.id, index)
    if (unit.content._tag === "Block" && "id" in unit.content.block)
      blocks.set(identity(entry, unit.content.block.id), index)
  })
  const selected = new Set<number>()
  const required = (index: number): Set<number> | undefined => {
    const needed = new Set<number>()
    const prompt = prompts.get(entries[index]!.turn.id)
    if (prompt !== undefined && !selected.has(prompt)) needed.add(prompt)
    let current: number | undefined = index
    const seen = new Set<number>()
    while (current !== undefined && !selected.has(current)) {
      if (seen.has(current)) return undefined
      seen.add(current)
      needed.add(current)
      const entry: TranscriptPage.Entry = entries[current]!
      const parentId: string | undefined = entry.unit.parentId
      current = parentId === undefined ? undefined : blocks.get(identity(entry, parentId))
      if (parentId !== undefined && current === undefined) return undefined
    }
    return needed
  }
  let bytes = 1
  // Admit a row together with its prompt and complete parent chain, never an orphan.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (selected.has(index)) continue
    const needed = required(index)
    if (needed === undefined) continue
    const addedBytes = [...needed].reduce((total, candidate) => total + sizes[candidate]!, 0)
    if (
      selected.size + needed.size > TranscriptPage.maximumTranscriptUnits ||
      bytes + addedBytes > maximumTranscriptPayloadBytes
    )
      continue
    for (const candidate of needed) selected.add(candidate)
    bytes += addedBytes
  }
  if (selected.size === entries.length) return { entries, truncated: false, oversizedEntry: false }
  let suffixStart = entries.length
  while (suffixStart > 0 && selected.has(suffixStart - 1)) suffixStart--
  return {
    entries: entries.filter((_, index) => selected.has(index)),
    partialCursor: transcriptCursorFor(entries[suffixStart]),
    truncated: true,
    oversizedEntry: false,
  }
}

export const boundTranscriptEntries: {
  (arg1: JsonEncoder): (arg0: ReadonlyArray<TranscriptPage.Entry>) => ReturnType<typeof boundTranscriptEntriesImpl>
  (arg0: ReadonlyArray<TranscriptPage.Entry>, arg1: JsonEncoder): ReturnType<typeof boundTranscriptEntriesImpl>
} = Function.dual(2, boundTranscriptEntriesImpl)
