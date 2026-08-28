import { describe, expect, test } from "vitest"
import { buildTranscript } from "../../src/opentui/rendering/renderer"
import { initial, type Model } from "../../src/state/model"

const webBlock = {
  _tag: "ToolCall" as const,
  id: "web-1",
  name: "read_web_page",
  input: '{"url":"https://example.com"}',
  status: "complete" as const,
  presentation: {
    family: "direct" as const,
    action: "read-web-page" as const,
    activeLabel: "Reading",
    completeLabel: "Read",
    outputDisplay: "expandable" as const,
  },
  detail: "https://example.com",
  files: [],
  result: { text: "# Heading\n\nSome **bold** text." },
}

const model = (expanded: ReadonlyArray<string>): Model => ({
  ...initial("/workspace", "medium"),
  width: 100,
  blocks: [webBlock],
  entries: [],
  items: [{ _tag: "Block", index: 0, id: "web", turnId: "turn" }],
  expandedRowKeys: expanded,
})

const rendered = (current: Model) =>
  buildTranscript(current)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")

describe("web page tool output", () => {
  test("is expandable rather than hidden", () => {
    expect(rendered(model([]))).toContain("▸")
  })

  test("renders markdown instead of raw source when expanded", () => {
    const output = rendered(model(["tool:web-1"]))
    expect(output).toContain("Heading")
    expect(output).toContain("bold")
    expect(output).not.toContain("**bold**")
    expect(output).not.toContain("# Heading")
  })
})
