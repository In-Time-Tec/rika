import { TextAttributes } from "@opentui/core"
import { Lexer } from "marked"
import { expect, test, vi } from "vitest"
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
const canonicalReasoningSource = `**Inspecting repository state**
The first logical line.
The second logical line.
- Validate the reducer.
- Validate the renderer.

| Area | Result |
|---|---|
| State | valid |

\`\`\`ts
const marker = "*inside code*"
\`\`\``

const normalizedRows = (entry: TranscriptUnitCacheEntry): Array<string> =>
  entry.bundles.flatMap((bundle) =>
    bundle.descriptors.flatMap((descriptor) =>
      descriptor.content.chunks.map((chunk) => chunk.text).join("").split("\n")
    )
  )

const streamReasoningText = (text: string, step: number): TranscriptUnitCacheEntry => {
  let cached: TranscriptUnitCacheEntry | undefined
  for (let end = step; end < text.length; end += step)
    cached = buildTentativeTranscriptUnitBundles({
      key: "block:tentative:reasoning",
      text: text.slice(0, end),
      width: 80,
      tone: "reasoning",
      revision: `r${end}`,
      cached,
    })
  return buildTentativeTranscriptUnitBundles({
    key: "block:tentative:reasoning",
    text,
    width: 80,
    tone: "reasoning",
    revision: "final",
    cached,
  })
}

const buildReasoningFrame = (
  text: string,
  revision: string,
  cached: TranscriptUnitCacheEntry | undefined,
): TranscriptUnitCacheEntry =>
  buildTentativeTranscriptUnitBundles({
    key: "block:tentative:reasoning",
    text,
    width: 80,
    tone: "reasoning",
    revision,
    cached,
  })

test("renders tentative reasoning through Markdown before a marker arrives", () => {
  const entry = buildReasoningFrame("The first logical line.", "r1", undefined)
  expect(entry.tentative?.markdown).toBe(true)
  expect(entry.bundles.some((bundle) => bundle.key.includes(":tail:"))).toBe(true)
})

test("preserves reasoning source lines during one-character streaming", () => {
  const first = "The first logical line."
  const second = "The second logical line."
  let cached: TranscriptUnitCacheEntry | undefined
  for (let end = 1; end <= canonicalReasoningSource.length; end += 1) {
    cached = buildReasoningFrame(canonicalReasoningSource.slice(0, end), `r${end}`, cached)
    const frame = cached
    const source = canonicalReasoningSource.slice(0, end)
    if (source.includes(`${first}\n${second}`)) {
      const rows = normalizedRows(frame)
      expect(rows.indexOf(first)).not.toBe(-1)
      expect(rows.indexOf(second)).not.toBe(-1)
      expect(rows.indexOf(first)).not.toBe(rows.indexOf(second))
    }
    expect(
      normalizedRows(frame).some((row) => row.includes("**")),
      `frame ${end} shows raw emphasis markers`,
    ).toBe(false)
  }
  const finalRows = normalizedRows(cached ?? buildReasoningFrame(canonicalReasoningSource, "final", undefined))
  expect(finalRows.indexOf(first)).not.toBe(-1)
  expect(finalRows.indexOf(second)).not.toBe(-1)
  expect(finalRows.indexOf(first)).not.toBe(finalRows.indexOf(second))
})

test("produces equivalent reasoning rows for one-character seven-character and whole-source delivery", () => {
  const byOne = normalizedRows(streamReasoningText(canonicalReasoningSource, 1))
  const bySeven = normalizedRows(streamReasoningText(canonicalReasoningSource, 7))
  const whole = normalizedRows(streamReasoningText(canonicalReasoningSource, canonicalReasoningSource.length))
  expect(bySeven).toEqual(byOne)
  expect(whole).toEqual(byOne)
})

test("does not expose complete Markdown delimiters as raw reasoning text", () => {
  let cached: TranscriptUnitCacheEntry | undefined
  for (let end = 1; end <= canonicalReasoningSource.length; end += 1) {
    cached = buildReasoningFrame(canonicalReasoningSource.slice(0, end), `r${end}`, cached)
    const visible = renderedText(cached ?? buildReasoningFrame(canonicalReasoningSource, "final", undefined))
    expect(visible, `frame ${end}`).not.toContain("**")
    expect(visible, `frame ${end}`).not.toContain("|---")
    expect(visible, `frame ${end}`).not.toContain("```")
  }
  const finalText = renderedText(cached ?? buildReasoningFrame(canonicalReasoningSource, "final", undefined))
  expect(finalText).toContain('*inside code*')
})

test("preserves CRLF and split surrogate boundaries during reasoning streaming", () => {
  const source = `${canonicalReasoningSource.replaceAll("\n", "\r\n")}\r\n🎉`
  let cached: TranscriptUnitCacheEntry | undefined
  for (let end = 1; end <= source.length; end += 1) {
    cached = buildReasoningFrame(source.slice(0, end), `r${end}`, cached)
    const visible = renderedText(cached ?? buildReasoningFrame(source, "final", undefined))
    expect(visible, `frame ${end}`).not.toContain("�")
  }
  const finalText = renderedText(cached ?? buildReasoningFrame(source, "final", undefined))
  expect(finalText).toContain("🎉")
  expect(finalText).not.toContain("�")
})

test("keeps stable reasoning bands mounted across tail changes", async () => {
  const paragraph = (index: number) =>
    `Paragraph ${String(index).padStart(3, "0")} padding to keep the stable bands growing steadily onward.`
  const seed = `**Inspecting repository state**\n\n${
    Array.from({ length: 140 }, (_, index) => paragraph(index)).join("\n\n")
  }\n\n`
  expect(seed.length).toBeGreaterThan(10_000)
  let entry = buildReasoningFrame(seed, "seed", undefined)
  const stableKeys = entry.bundles.filter((bundle) => !bundle.key.includes(":tail:")).map((bundle) => bundle.key)
  expect(stableKeys.length).toBeGreaterThan(0)
  const stableIdentities = stableKeys.map((key) => {
    const descriptor = entry.bundles.find((bundle) => bundle.key === key)?.descriptors[0]
    return { key, revision: descriptor?.revision, content: descriptor?.content }
  })
  let text = seed
  for (let delta = 1; delta <= 1000; delta += 1) {
    text += delta === 1000 ? "\n\nClosing note padding text for the stability check." : "·"
    entry = buildReasoningFrame(text, `d${delta}`, entry)
  }
  const tailRevisionsBefore = entry.bundles
    .filter((bundle) => bundle.key.includes(":tail:"))
    .map((bundle) => ({ key: bundle.key, revision: bundle.descriptors[0]?.revision }))
  // The settle throttle gates on the process wall clock, which fake timers cannot advance,
  // so this characterization waits out one throttle window with a real delay.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 650)
  })
  entry = buildReasoningFrame(text, "final", entry)
  for (const before of stableIdentities) {
    const descriptor = entry.bundles.find((bundle) => bundle.key === before.key)?.descriptors[0]
    expect(descriptor?.revision, `stable band ${before.key} keeps its revision`).toBe(before.revision)
    expect(descriptor?.content, `stable band ${before.key} keeps its content`).toBe(before.content)
  }
  const tailChanged = entry.bundles
    .filter((bundle) => bundle.key.includes(":tail:"))
    .some(
      (bundle) =>
        tailRevisionsBefore.find((before) => before.key === bundle.key)?.revision !==
        bundle.descriptors[0]?.revision,
    )
  expect(tailChanged).toBe(true)
})

test("bounds Markdown tail reparsing for long reasoning", () => {
  const spy = vi.spyOn(Lexer, "lex")
  try {
    const codeLine = (index: number) =>
      `const value${String(index).padStart(4, "0")} = "padding padding padding"; // note`
    const longOpenFence =
      `**Inspecting repository state**\n\n\`\`\`ts\n${Array.from({ length: 180 }, (_, index) => codeLine(index)).join("\n")}`
    expect(longOpenFence.length).toBeGreaterThan(9000)
    buildReasoningFrame(longOpenFence, "r1", undefined)
    const longestLex = Math.max(...spy.mock.calls.map((call) => String(call[0]).length))
    expect(longestLex).toBeLessThanOrEqual(4096)
    spy.mockClear()
    const base = `**Inspecting repository state**\n\n\`\`\`ts\n// base\n`
    let entry: TranscriptUnitCacheEntry | undefined
    let text = base
    for (let delta = 1; delta <= 120; delta += 1) {
      text += "x"
      entry = buildReasoningFrame(text, `d${delta}`, entry)
    }
    const fenceLexes = spy.mock.calls.length
    const totalLexed = spy.mock.calls.reduce((total, call) => total + String(call[0]).length, 0)
    expect(entry?.tentative?.markdown).toBe(true)
    expect(fenceLexes).toBeLessThanOrEqual(10)
    expect(totalLexed).toBeLessThan(8 * text.length)
  } finally {
    spy.mockRestore()
  }
})
