import { describe, expect, test } from "vitest"
import { buildTentativeTranscriptUnitBundles } from "../../../../src/opentui/surface/transcript/rendering-models"

const renderedText = (entry: ReturnType<typeof buildTentativeTranscriptUnitBundles>): string =>
  entry.bundles
    .flatMap((bundle) => bundle.descriptors)
    .flatMap((descriptor) => descriptor.content.chunks)
    .map((chunk) => chunk.text)
    .join("")

describe("tentative reasoning rendering", () => {
  test("uses the Markdown renderer before syntax markers arrive", () => {
    const first = buildTentativeTranscriptUnitBundles({
      key: "block:tentative:reasoning",
      text: "Inspect the request and compare the state transitions.",
      width: 40,
      tone: "reasoning",
      revision: "1",
      cached: undefined,
    })

    expect(first.tentative?.markdown).toBe(true)
    expect(renderedText(first)).toContain("Inspect the request")
  })

  test("keeps the same Markdown layout across later reasoning deltas", () => {
    const initialText = "Inspect the request and compare the state transitions."
    const first = buildTentativeTranscriptUnitBundles({
      key: "block:tentative:reasoning",
      text: initialText,
      width: 32,
      tone: "reasoning",
      revision: "1",
      cached: undefined,
    })
    const second = buildTentativeTranscriptUnitBundles({
      key: "block:tentative:reasoning",
      text: `${initialText}\n\n- Validate the reducer.\n- Validate the renderer.`,
      width: 32,
      tone: "reasoning",
      revision: "2",
      cached: first,
    })

    expect(second.tentative).toBe(first.tentative)
    expect(second.tentative?.markdown).toBe(true)
    expect(renderedText(second)).not.toContain("- Validate")
    expect(renderedText(second)).toContain("Validate the reducer.")
    expect(renderedText(second)).toContain("Validate the renderer.")
  })
})
