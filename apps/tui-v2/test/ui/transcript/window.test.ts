import { expect, test } from "vitest"
import { selectedGroupIndex, transcriptAnchorId, transcriptWindow } from "../../../src/ui/transcript/window"
import { buildTranscriptGroups } from "../../../src/ui/transcript/presenter"

test("short transcripts need no paging controls or phantom geometry", () => {
  expect(transcriptWindow({ count: 0, start: undefined })).toEqual({ start: 0, end: 0, earlier: 0, newer: 0 })
  expect(transcriptWindow({ count: 200, start: undefined })).toEqual({ start: 0, end: 200, earlier: 0, newer: 0 })
})

test("the newest window advances while an earlier window stays anchored during streaming", () => {
  expect(transcriptWindow({ count: 10_000, start: undefined })).toEqual({
    start: 9750,
    end: 10_000,
    earlier: 9750,
    newer: 0,
  })
  expect(transcriptWindow({ count: 10_001, start: undefined }).start).toBe(9751)
  expect(transcriptWindow({ count: 10_001, start: 500 })).toEqual({ start: 500, end: 750, earlier: 500, newer: 9251 })
})

test("successive windows cover every group exactly once", () => {
  const visited: number[] = []
  let start = 0
  while (start < 10_013) {
    const window = transcriptWindow({ count: 10_013, start })
    for (let index = window.start; index < window.end; index += 1) visited.push(index)
    expect(window.end - window.start).toBeLessThanOrEqual(250)
    start = window.end
  }
  expect(visited).toEqual(Array.from({ length: 10_013 }, (_, index) => index))
})

test("oversized first families keep every member independently of the mounted group budget", () => {
  for (const kind of ["tool", "child"] as const) {
    const items = Array.from({ length: 501 }, (_, index) => ({
      id: `${kind}-${index}`,
      kind,
      title: kind === "tool" ? "bash" : "Reviewer",
      text: "result",
    }))
    const groups = buildTranscriptGroups(items)
    expect(groups).toHaveLength(1)
    expect(transcriptWindow({ count: groups.length, start: 0 })).toEqual({ start: 0, end: 1, earlier: 0, newer: 0 })
    const id = transcriptAnchorId(groups[0]!)
    const prepended = buildTranscriptGroups([{ ...items[0]!, id: "older" }, ...items])
    expect(selectedGroupIndex({ groups: prepended, id })).toBe(0)
    for (const item of items) {
      expect(selectedGroupIndex({ groups, id: kind === "tool" ? `tool-child:${item.id}` : item.id })).toBe(0)
    }
  }
})
