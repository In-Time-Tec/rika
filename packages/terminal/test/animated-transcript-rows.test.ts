import { describe, expect, it } from "@effect/vitest"
import { StyledText } from "@opentui/core"
import { transcriptUnitBuilder } from "../src/opentui/rendering/opentui-render-unit"
import { isAnimatedChunk } from "../src/opentui/rendering/opentui-render-window"
import { restingFrame } from "../src/opentui/rendering/opentui-animation-frame"
import { transcriptUnits } from "../src/presentation/transcript/transcript-row"
import { initial, type Model } from "../src/state/model/terminal-state"

const shell = (id: string, status: "running" | "complete") => ({
  _tag: "ToolCall" as const,
  id,
  name: "bash",
  input: JSON.stringify({ command: `printf ${id}` }),
  status,
  presentation: { family: "shell" as const, action: "shell", activeLabel: "Running", completeLabel: "Ran" },
  detail: `printf ${id}`,
  files: [],
  ...(status === "complete" ? { output: "done" } : {}),
})

const modelOf = (input: Partial<Model>): Model => ({
  ...initial("/work", "high"),
  width: 100,
  height: 30,
  ...input,
})

const animatedTexts = (model: Model): ReadonlyArray<string> => {
  const builder = transcriptUnitBuilder(model, restingFrame)
  const marked: Array<string> = []
  for (const unit of transcriptUnits(model)) {
    if (!builder.isUnitVisible(unit)) continue
    const built = builder.renderUnit(unit)
    for (const chunk of new StyledText([...built.chunks]).chunks)
      if (isAnimatedChunk(chunk)) marked.push(chunk.text)
  }
  return marked
}

describe("animated transcript rows", () => {
  it("marks the glyph of a running row so the repaint pass can find it", () => {
    const model = modelOf({
      blocks: [shell("one", "running")],
      items: [{ _tag: "Block", index: 0, id: "tool:one", turnId: "turn" }],
    })
    expect(animatedTexts(model)).toEqual([restingFrame])
  })

  it("marks a running row that is selected, which a text search could never find", () => {
    const model = modelOf({
      blocks: [shell("one", "running")],
      items: [{ _tag: "Block", index: 0, id: "tool:one", turnId: "turn" }],
      detailSelection: "tool:one",
    })
    expect(animatedTexts(model)).toEqual([restingFrame])
  })

  it("marks every running glyph in a group, not only the first", () => {
    const model = modelOf({
      blocks: [shell("one", "running"), shell("two", "running"), shell("three", "running")],
      items: [
        { _tag: "Block", index: 0, id: "tool:one", turnId: "turn" },
        { _tag: "Block", index: 1, id: "tool:two", turnId: "turn" },
        { _tag: "Block", index: 2, id: "tool:three", turnId: "turn" },
      ],
      expandedRowKeys: ["tool:one", "tool:two", "tool:three"],
    })
    expect(animatedTexts(model).length).toBeGreaterThanOrEqual(3)
  })

  it("leaves a settled row unmarked so it never animates", () => {
    const model = modelOf({
      blocks: [shell("one", "complete")],
      items: [{ _tag: "Block", index: 0, id: "tool:one", turnId: "turn" }],
    })
    expect(animatedTexts(model)).toEqual([])
  })
})
