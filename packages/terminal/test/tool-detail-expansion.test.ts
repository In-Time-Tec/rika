import { describe, expect, test } from "vitest"
import { buildTranscript } from "../src/opentui/rendering/opentui-renderer"
import { expandableRowIds } from "../src/presentation/transcript/transcript-row"
import { initial, type Model } from "../src/state/model/terminal-state"

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
  output: Array.from({ length: 40 }, (_, index) => `${index + 100}: line ${index + 100}`).join("\n"),
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

describe("read tool detail is inspectable", () => {
  test("the read child is registered as expandable once its group is open", () => {
    const opened = model(["tool:read-1"])
    expect(expandableRowIds(opened)).toContain("tool-child:read-1")
  })

  test("fully collapsed shows only the group summary, never file content", () => {
    const output = rendered(model([]))
    expect(output).toContain("Explored 1 file")
    expect(output).not.toContain("line 100")
  })

  test("opening the group shows the path but still not the content", () => {
    const output = rendered(model(["tool:read-1"]))
    expect(output).toContain("src/main.ts")
    expect(output).not.toContain("line 100")
  })

  test("expanded shows every line of the window, not a 12-line slice", () => {
    const output = rendered(model(["tool:read-1", "tool-child:read-1"]))
    expect(output).toContain("100")
    expect(output).toContain("line 100")
    expect(output).toContain("139")
    expect(output).toContain("line 139")
  })

  test("a read window renders through the Pierre gutter rather than raw numbered text", () => {
    const output = rendered(model(["tool:read-1", "tool-child:read-1"]))
    expect(output).not.toContain("100: line 100")
    expect(output).toMatch(/100\s+line 100/)
  })
})
