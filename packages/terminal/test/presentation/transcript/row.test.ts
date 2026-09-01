import { describe, expect, test } from "vitest"
import { buildTranscript } from "../../../src/opentui/rendering/renderer"
import { expandableRowIds } from "../../../src/presentation/transcript/row"
import { initial, type Model } from "../../../src/state/model"

const readBlock = {
  _tag: "ToolCall" as const,
  id: "read-1",
  name: "read",
  input: '{"path":"src/main.ts"}',
  status: "complete" as const,
  presentation: {
    family: "direct" as const,
    action: "read" as const,
    activeLabel: "Reading",
    completeLabel: "Read",
  },
  detail: "src/main.ts",
  files: [],
  result: { text: Array.from({ length: 40 }, (_, index) => `${index + 100}: line ${index + 100}`).join("\n") },
}

const model = (expanded: ReadonlyArray<string>): Model => ({
  ...initial("/workspace", "medium"),
  width: 100,
  blocks: [readBlock],
  entries: [],
  items: [{ _tag: "Block", index: 0, id: "read", turnId: "turn" }],
  expandedRowKeys: expanded,
})

const rendered = (current: Model) =>
  buildTranscript(current)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")

describe("singleton Read detail is inspectable", () => {
  test("registers the flat Read row itself as expandable", () => {
    expect(expandableRowIds(model([]))).toEqual(["tool:read-1"])
  })

  test("collapsed shows Read plus its path and a chevron, never file content", () => {
    const output = rendered(model([]))
    expect(output).toContain("▸ ✓ Read src/main.ts")
    expect(output).not.toContain("Explored 1 file")
    expect(output).not.toContain("line 100")
  })

  test("opening the Read row shows every line without an intermediate child disclosure", () => {
    const output = rendered(model(["tool:read-1"]))
    expect(output).toContain("▾ ✓ Read src/main.ts")
    expect(output).toContain("100: line 100")
    expect(output).toContain("139: line 139")
    expect(expandableRowIds(model(["tool:read-1"]))).not.toContain("tool-child:read-1")
  })

  test("a typed read result renders its numbered text directly", () => {
    expect(rendered(model(["tool:read-1"]))).toContain("100: line 100")
  })
})
