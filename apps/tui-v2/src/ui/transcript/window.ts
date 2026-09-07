import type { TranscriptGroup } from "./presenter"

export const transcriptWindowSize = 250

export const transcriptWindow = (input: { readonly count: number; readonly start: number | undefined }) => {
  const start =
    input.start === undefined || input.count <= transcriptWindowSize
      ? Math.max(0, input.count - transcriptWindowSize)
      : Math.max(0, Math.min(input.start, Math.max(0, input.count - 1)))
  const end = Math.min(input.count, start + transcriptWindowSize)
  return { start, end, earlier: start, newer: input.count - end }
}

export const selectedGroupIndex = (input: {
  readonly groups: readonly TranscriptGroup[]
  readonly id: string
}): number =>
  input.groups.findIndex((group) => {
    if (group.id === input.id) return true
    if (group.kind === "children") return group.items.some((item) => item.id === input.id)
    if (group.kind === "tools") return group.items.some((tool) => `tool-child:${tool.item.id}` === input.id)
    return false
  })
