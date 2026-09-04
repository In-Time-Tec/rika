import { TextAttributes } from "@opentui/core"
import { expect, test } from "vitest"
import { buildTentativeTranscriptUnitBundles } from "../../../../src/opentui/surface/transcript/rendering-models"
import type { TranscriptUnitCacheEntry } from "../../../../src/opentui/rendering/transcript/revision"
import { renderMarkdownLines } from "../../../../src/opentui/rendering/text-adapter"
import { renderMarkdown } from "../../../../src/presentation/markdown/renderer"

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

test("cached blocks respect reference definitions outside the block's raw source", () => {
  expect(renderMarkdown("[label][ref]\n\n[ref]: https://first.example").split("\n")[0]).toBe(
    "label <https://first.example>",
  )
  expect(renderMarkdown("[label][ref]\n\n[ref]: https://second.example").split("\n")[0]).toBe(
    "label <https://second.example>",
  )
})

test("updates a retained band's hyperlink when a distant reference destination grows", () => {
  const text = "[label][ref]\n\n" + "paragraph\n\n".repeat(100) + "[ref]: https://example.com"
  const cached = buildTentativeTranscriptUnitBundles({
    key: "link",
    text,
    width: 80,
    tone: "answer",
    revision: "first",
    cached: undefined,
  })
  const updated = buildTentativeTranscriptUnitBundles({
    key: "link",
    text: text + "/new",
    width: 80,
    tone: "answer",
    revision: "last",
    cached,
  })
  const label = updated.bundles
    .flatMap((bundle) => bundle.descriptors)
    .flatMap((descriptor) => descriptor.content.chunks)
    .find((chunk) => chunk.text === "label")
  expect(label?.link?.url).toBe("https://example.com/new")
})

test.each([1, 7, 10_000])("streamed Markdown matches durable interpretation at chunk size %i", (step) => {
  for (const width of [30, 100]) {
    for (const text of [
      "```text\nFIRST_CODE\n\nSECOND_CODE\n```\n\nAFTER_CODE",
      "- first\n\n  continuation\n- second",
      "[label][ref]\n\n[ref]: https://example.com",
      "| Name | Value |\n|---|---|\n| **bold** | 🙂 |",
      "```text\n" + "long code 🙂\n".repeat(20) + "\nLAST_LINE\n```",
    ]) {
      let cached: TranscriptUnitCacheEntry | undefined
      for (let end = Math.min(step, text.length); ; end = Math.min(end + step, text.length)) {
        cached = buildTentativeTranscriptUnitBundles({
          key: "stream",
          text: text.slice(0, end),
          width,
          tone: "answer",
          revision: String(end),
          cached,
        })
        if (end === text.length) break
      }
      expect(renderedText(cached)).toBe(
        renderMarkdownLines(text, width)
          .map((line) => line.map((chunk) => chunk.text).join(""))
          .join("\n"),
      )
    }
  }
})

test("renders the last delta of a long code block without waiting for another update", () => {
  const text = "```text\n" + "long code 🙂\n".repeat(250)
  const cached = buildTentativeTranscriptUnitBundles({
    key: "long",
    text,
    width: 100,
    tone: "answer",
    revision: "first",
    cached: undefined,
  })
  const last = buildTentativeTranscriptUnitBundles({
    key: "long",
    text: text + "FINAL_DELTA\n```",
    width: 100,
    tone: "answer",
    revision: "last",
    cached,
  })
  expect(renderedText(last)).toContain("FINAL_DELTA")
})

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
