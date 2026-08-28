import { describe, expect, test } from "vitest"
import { buildTranscript } from "../../../../src/opentui/rendering/renderer"
import { expandableRowIds, transcriptUnits } from "../../../../src/presentation/transcript/row"
import { initial, type Model } from "../../../../src/state/model"
import { colors } from "../../../../src/presentation/terminal/theme"
import stringWidth from "string-width"

const source = 'const result = await rika.workspace.read({"path":"nested.txt"})'

const rendered = (model: Model) =>
  buildTranscript(model)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")

const cell = {
  _tag: "Cell" as const,
  id: "oracle-cell",
  status: "complete" as const,
  visual: "ts",
  source: { text: source, lines: 1, truncated: false },
  output: { stdout: "NESTED_CELL_STDOUT", stderr: "", droppedBytes: 0, droppedEvents: 0 },
  durationMillis: 1_240,
  epoch: 0,
  notices: [],
  calls: [],
  files: [],
}

const model = (): Model => ({
  ...initial("/workspace", "medium"),
  width: 100,
  blocks: [
    {
      _tag: "SubagentCard",
      id: "oracle-card",
      name: "Oracle",
      prompt: "Read the nested fixture.",
      promptTruncated: false,
      summary: "",
      status: "complete",
      activity: [],
    },
    cell,
  ],
  entries: [],
  items: [
    { _tag: "Block", index: 0, id: "card", turnId: "turn" },
    { _tag: "Block", index: 1, id: "cell", turnId: "turn", parentId: "oracle-card" },
  ],
})

describe("a subagent's own cell", () => {
  test("is a child of the card that spawned it rather than being dropped", () => {
    const collapsed = model()
    const subagent = transcriptUnits(collapsed).find((unit) => unit.kind === "subagent")
    // A cell is the only way a subagent acts now, so a card whose cell is missing renders a
    // subagent that silently did nothing.
    expect(subagent).toMatchObject({ kind: "subagent", children: [{ kind: "cell", block: 1 }] })
    expect(transcriptUnits(collapsed).some((unit) => unit.kind === "cell")).toBe(false)
  })

  test("is expandable under its card and carries the same id rule as a top-level cell", () => {
    const collapsed = model()
    expect(expandableRowIds(collapsed)).toEqual(["subagent:oracle-card"])
    const cardOpen = { ...collapsed, expandedRowKeys: ["subagent:oracle-card"] }
    expect(expandableRowIds(cardOpen)).toEqual(["subagent:oracle-card", "cell:oracle-cell"])
  })

  test("renders its authored source on the card's timeline, never a tool label", () => {
    const cardOpen = { ...model(), expandedRowKeys: ["subagent:oracle-card"] }
    const collapsedCell = rendered(cardOpen)
    expect(collapsedCell).toContain(source)
    expect(collapsedCell).toContain("1.2s · ▸")
    expect(collapsedCell).not.toContain("ts ")
    expect(collapsedCell).not.toContain("1 line")
    expect(collapsedCell).not.toContain("Read nested.txt")
    expect(collapsedCell).not.toContain("NESTED_CELL_STDOUT")

    const chunks = buildTranscript(cardOpen).styled.chunks
    expect(chunks.find((chunk) => chunk.text.includes("1.2s"))?.fg).toBe(colors.subtle)
    expect(chunks.find((chunk) => chunk.text === "const")?.fg).not.toBe(colors.text)

    const cellOpen = { ...model(), expandedRowKeys: ["subagent:oracle-card", "cell:oracle-cell"] }
    const expandedCell = rendered(cellOpen)
    expect(expandedCell).toContain("NESTED_CELL_STDOUT")
    expect(expandedCell.match(new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1)
    expect(expandedCell).toContain("\u2502     NESTED_CELL_STDOUT")
  })

  test("wraps highlighted source inside the card timeline", () => {
    const longSource = `const result = await rika.workspace.read({"path":"${"nested/".repeat(12)}fixture.txt"})`
    const base = model()
    const current: Model = {
      ...base,
      width: 60,
      blocks: [
        base.blocks[0]!,
        {
          ...cell,
          source: { text: `${longSource}\nresult.text`, lines: 2, truncated: false },
        },
      ],
      expandedRowKeys: ["subagent:oracle-card", "cell:oracle-cell"],
    }
    const lines = rendered(current)
      .split("\n")
      .filter((line) => line.length > 0)
    expect(lines.filter((line) => line.includes("nested/")).length).toBeGreaterThan(1)
    expect(lines.filter((line) => line.includes("const result"))).toHaveLength(1)
    expect(lines.some((line) => line.includes("result.text"))).toBe(true)
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(60)
  })
})
