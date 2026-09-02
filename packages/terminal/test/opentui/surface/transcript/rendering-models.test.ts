import { TextAttributes } from "@opentui/core"
import { expect, test } from "vitest"
import { buildTentativeTranscriptUnitBundles } from "../../../../src/opentui/surface/transcript/rendering-models"
import type { TranscriptUnitCacheEntry } from "../../../../src/opentui/rendering/transcript/revision"

const renderedText = (entry: TranscriptUnitCacheEntry) =>
  entry.bundles
    .flatMap((bundle) => bundle.descriptors)
    .map((descriptor) => descriptor.content.chunks.map((chunk) => chunk.text).join(""))
    .join("\n")

const chunksWith = (entry: TranscriptUnitCacheEntry, attribute: number) =>
  entry.bundles
    .flatMap((bundle) => bundle.descriptors)
    .flatMap((descriptor) => descriptor.content.chunks)
    .filter((chunk) => ((chunk.attributes ?? 0) & attribute) === attribute)

test("formats a streaming paragraph before its closing blank line arrives", () => {
  const streamed =
    "I explored `/Users/dallen/projects`.\n\n| Project | Copies |\n|---|---:|\n| **Rika** | 4 |\n| rincon"
  let cached: TranscriptUnitCacheEntry | undefined
  for (let end = 1; end <= streamed.length; end += 7)
    cached = buildTentativeTranscriptUnitBundles({
      key: "entry:tentative:answer",
      text: streamed.slice(0, end),
      width: 60,
      tone: "answer",
      revision: `r${end}`,
      cached,
    })
  const final = buildTentativeTranscriptUnitBundles({
    key: "entry:tentative:answer",
    text: streamed,
    width: 60,
    tone: "answer",
    revision: "final",
    cached,
  })
  const text = renderedText(final)
  expect(text).not.toContain("|---")
  expect(text).not.toContain("**")
  expect(text).toContain("│")
  expect(text).toContain("rincon")
  expect(chunksWith(final, TextAttributes.BOLD).map((chunk) => chunk.text)).toContain("Rika")
})

test("renders streaming reasoning as dim italic Markdown", () => {
  const entry = buildTentativeTranscriptUnitBundles({
    key: "block:tentative:reasoning",
    text: "**Inspecting user projects directory**\n\nThe home folder has `projects`",
    width: 60,
    tone: "reasoning",
    revision: "r1",
    cached: undefined,
  })
  const text = renderedText(entry)
  expect(text).not.toContain("**")
  expect(text).toContain("Inspecting user projects directory")
  expect(chunksWith(entry, TextAttributes.BOLD).map((chunk) => chunk.text)).toContain(
    "Inspecting user projects directory",
  )
  const visible = entry.bundles
    .flatMap((bundle) => bundle.descriptors)
    .flatMap((descriptor) => descriptor.content.chunks)
    .filter((chunk) => chunk.text.trim().length > 0)
  expect(visible.length).toBeGreaterThan(0)
  for (const chunk of visible)
    expect((chunk.attributes ?? 0) & (TextAttributes.DIM | TextAttributes.ITALIC)).toBe(
      TextAttributes.DIM | TextAttributes.ITALIC,
    )
})
