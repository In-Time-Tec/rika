import type { TranscriptItem } from "../../state/transcript/model"

const knownIndexCache = new WeakMap<ReadonlyArray<unknown>, Map<string, number>>()

export const knownIndexesFor = (items: ReadonlyArray<TranscriptItem>): Map<string, number> => {
  const cached = knownIndexCache.get(items)
  if (cached !== undefined) return cached
  const built = new Map<string, number>()
  for (const [index, item] of items.entries()) if (item.id !== undefined) built.set(item.id, index)
  knownIndexCache.set(items, built)
  return built
}

export const ProjectionIndexCache = {
  set(items: ReadonlyArray<TranscriptItem>, indexes: Map<string, number>): void {
    knownIndexCache.set(items, indexes)
  },
}

let copiedTranscriptBytes = 0
let fullTranscriptArrayCopies = 0

export const recordArrayCopy = (length: number): void => {
  if (length === 0) return
  fullTranscriptArrayCopies += 1
  copiedTranscriptBytes += length * 8
}

export const transcriptProjectionDiagnostics = () => ({ copiedTranscriptBytes, fullTranscriptArrayCopies })

export const resetTranscriptProjectionDiagnostics = (): void => {
  copiedTranscriptBytes = 0
  fullTranscriptArrayCopies = 0
}
