import { describe, expect, test } from "vitest"
import { buildTranscript } from "../src/opentui/rendering/opentui-renderer"
import { expandableRowIds, transcriptUnits } from "../src/presentation/transcript/transcript-row"
import { initial, type Model } from "../src/state/model/terminal-state"

const source = 'await rika.workspace.read({"path":"nested.txt"})'

const rendered = (model: Model) =>
  buildTranscript(model)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")

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
    {
      _tag: "Cell",
      id: "oracle-cell",
      status: "complete",
      visual: "ts",
      summary: source,
      source: { text: source, lines: 1, truncated: false },
      output: { stdout: "NESTED_CELL_STDOUT", stderr: "", droppedBytes: 0, droppedEvents: 0 },
      epoch: 0,
      notices: [],
      files: [],
    },
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
    expect(collapsedCell).toContain(`ts ${source} \u00b7 1 line`)
    expect(collapsedCell).not.toContain("Read nested.txt")
    expect(collapsedCell).not.toContain("NESTED_CELL_STDOUT")

    const cellOpen = { ...model(), expandedRowKeys: ["subagent:oracle-card", "cell:oracle-cell"] }
    const expandedCell = rendered(cellOpen)
    expect(expandedCell).toContain("NESTED_CELL_STDOUT")
    // The body stays on the card's timeline instead of escaping to the left margin.
    for (const bodyLine of [source, "NESTED_CELL_STDOUT"]) expect(expandedCell).toContain(`\u2502   ${bodyLine}`)
  })
})
