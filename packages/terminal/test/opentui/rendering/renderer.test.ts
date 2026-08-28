import { expect, test } from "vitest"
import { buildTranscript } from "../../../src/opentui/rendering/renderer"
import {
  _windowUnitToolCall,
  agentToolBlock,
  _handlers,
  _nonEmptyLines,
  model,
  _createScoped,
} from "../../presentation/terminal/theme.fixture"
test("renders a completed subagent's tool-result fallback as markdown", () => {
  const state = model({
    blocks: [
      {
        ...agentToolBlock("complete", undefined),
        result: { output: [{ type: "text", text: "## Review complete\n\n**No defects found.**" }] },
      },
    ],
    items: [{ _tag: "Block", index: 0, id: "tool:agent" }],
    expandedRowKeys: ["tool:agent"],
  })
  const text = buildTranscript(state)
    .styled.chunks.map((current) => current.text)
    .join("")
  expect(text).toContain("Review complete")
  expect(text).toContain("No defects found.")
  expect(text).not.toContain("##")
  expect(text).not.toContain("**")
})
