import { expect, test } from "vitest"
import { buildTranscript } from "../../../../src/opentui/rendering/renderer"

import { colors } from "../../../../src/presentation/terminal/theme"
import { adapterFixtures3 } from "../../../support/surface/lifecycle.fixture"
const {
  shell,
  _windowUnitToolCall,
  _agentToolBlock,
  _handlers,
  nonEmptyLines,
  subagentToolBlock,
  editToolBlock,
  renderedText,
  model,
  _thread,
} = adapterFixtures3
test("matches Amp cancelled subagent and shell treatment", () => {
  const state = model({
    blocks: [
      {
        _tag: "ToolCall",
        id: "parent",
        name: "task",
        input: "{}",
        status: "cancelled",
        presentation: {
          family: "agent",
          action: "task",
          activeLabel: "Subagent working",
          completeLabel: "Subagent finished",
        },
        detail: "Wait then run the checks",
        childId: "child",
        files: [],
      },
      {
        _tag: "ToolCall",
        id: "child-shell",
        name: "bash",
        input: JSON.stringify({ command: "sleep 60" }),
        status: "cancelled",
        presentation: {
          family: "shell",
          action: "command",
          activeLabel: "Running",
          completeLabel: "Ran",
        },
        detail: "sleep 60",
        files: [],
      },
    ],
    items: [
      { _tag: "Block", index: 0, id: "tool:parent", turnId: "turn" },
      { _tag: "Block", index: 1, id: "tool:child-shell", turnId: "child", parentId: "parent" },
    ],
    expandedRowKeys: ["tool:parent"],
  })

  const built = buildTranscript(state)
  const text = built.styled.chunks.map((chunk) => chunk.text).join("")
  const marker = built.styled.chunks.find((chunk) => chunk.text === "⊘")

  expect(text).toContain("⊘ Subagent cancelled")
  expect(text).toContain("▾ ⊘ Subagent cancelled")
  expect(text).toContain("$ sleep 60 (cancelled)")
  expect(
    text
      .split("\n")
      .find((line) => line.includes("$ sleep 60"))
      ?.trimEnd()
      .endsWith("(cancelled)"),
  ).toBe(true)
  expect(marker?.fg).toBe(colors.amber)
  expect(built.ranges.find((range) => range.unit === "tool:parent")?.animated).toBe(false)
  expect(built.ranges.find((range) => range.unit === "tool:child-shell")?.animated).toBe(false)
})
test("keeps hidden nested web output inline", () => {
  const state = model({
    blocks: [
      {
        _tag: "ToolCall",
        id: "parent",
        name: "task",
        input: "{}",
        status: "complete",
        presentation: {
          family: "agent",
          action: "task",
          activeLabel: "Subagent working",
          completeLabel: "Subagent finished",
        },
        detail: "Research documentation",
        childId: "child",
        files: [],
      },
      {
        _tag: "ToolCall",
        id: "child-web",
        name: "web_search",
        input: JSON.stringify({ objective: "Find current documentation" }),
        status: "complete",
        presentation: {
          family: "direct",
          action: "web-search",
          activeLabel: "Web Search",
          completeLabel: "Web Search",
          outputDisplay: "hidden",
        },
        detail: "Find current documentation",
        result: { text: "NESTED SEARCH RESULT BODY" },
        files: [],
      },
    ],
    items: [
      { _tag: "Block", index: 0, id: "tool:parent", turnId: "turn" },
      { _tag: "Block", index: 1, id: "tool:child-web", turnId: "child", parentId: "parent" },
    ],
    expandedRowKeys: ["tool:parent", "tool:child-web"],
  })

  const built = buildTranscript(state)
  const text = built.styled.chunks.map((chunk) => chunk.text).join("")

  expect(text).toContain("Web Search Find current documentation")
  expect(text).not.toContain("NESTED SEARCH RESULT BODY")
  expect(built.ranges.find((range) => range.unit === "tool:child-web")?.expandable).toBe(false)
})
test("keeps collapsed tool, Edited, and subagent rows free of the left gutter", () => {
  const collapsed = renderedText({
    blocks: [editToolBlock, subagentToolBlock, shell("run", "bun test", "passed")],
    expandedRowKeys: [],
  })
  const lines = nonEmptyLines(collapsed)
  expect(lines.some((line) => line.includes("Edited"))).toBe(true)
  expect(lines.some((line) => line.includes("Subagent finished"))).toBe(true)
  expect(lines.every((line) => line.startsWith("│") === false)).toBe(true)
})
test("does not add an active-agent count to agent labels", () => {
  const blocks = Array.from({ length: 4 }, (_, index) => ({
    ...subagentToolBlock,
    id: `agent-${index}`,
    status: index === 3 ? ("complete" as const) : ("running" as const),
  }))
  const text = renderedText({
    blocks,
    items: blocks.map((block, index) => ({ _tag: "Block", index, id: `tool:${block.id}` })),
  })
  expect(text.match(/Subagent working/g)).toHaveLength(3)
  expect(text).not.toContain("active")
  expect(text).toContain("Subagent finished")
})
test("renders an expanded subagent body without any added left rail", () => {
  const lines = nonEmptyLines(renderedText({ blocks: [subagentToolBlock], expandedRowKeys: ["tool:agent"] }))
  expect(lines[0]).toContain("Subagent finished")
  expect(lines.length).toBeGreaterThan(1)
  expect(lines.some((line) => line.includes("Inspect"))).toBe(true)
  expect(lines.every((line) => line.startsWith("│") === false)).toBe(true)
})
test("renders an expanded Edited diff without any added left rail", () => {
  const lines = nonEmptyLines(renderedText({ blocks: [editToolBlock], expandedRowKeys: ["tool:patch"] }))
  expect(lines[0]).toContain("Edited")
  expect(lines.length).toBeGreaterThan(1)
  expect(lines.slice(1).some((line) => line.includes("old") || line.includes("new"))).toBe(true)
  expect(lines.every((line) => line.startsWith("│") === false)).toBe(true)
})
test("renders an expanded Diff block without any added left rail", () => {
  const block = {
    _tag: "Diff",
    path: "src/a.ts",
    patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
  } as const
  const collapsed = nonEmptyLines(renderedText({ blocks: [block], expandedRowKeys: [] }))
  expect(collapsed[0]).toContain("Edited")
  expect(collapsed.every((line) => !line.startsWith("│"))).toBe(true)
  const expanded = nonEmptyLines(renderedText({ blocks: [block], expandedRowKeys: ["block:Diff:0"] }))
  expect(expanded.length).toBeGreaterThan(1)
  expect(expanded.every((line) => !line.startsWith("│"))).toBe(true)
})
test("keeps the nested connector tree as the only vertical treatment in an expanded subagent", () => {
  const state = model({
    blocks: [
      { ...subagentToolBlock, status: "running", detail: "Inspect the projection" },
      shell("child-a", "bun test", "passed"),
      shell("child-b", "bun run check", "clean"),
    ],
    items: [
      { _tag: "Block", index: 0, id: "tool:agent", turnId: "turn" },
      { _tag: "Block", index: 1, id: "tool:child-a", turnId: "child:agent", parentId: "agent" },
      { _tag: "Block", index: 2, id: "tool:child-b", turnId: "child:agent", parentId: "agent" },
    ],
    expandedRowKeys: ["tool:agent", "tool:child-a"],
  })
  const lines = nonEmptyLines(
    buildTranscript(state)
      .styled.chunks.map((chunk) => chunk.text)
      .join(""),
  )
  expect(lines.some((line) => line.trimStart().startsWith("├"))).toBe(true)
  expect(lines.some((line) => line.trimStart().startsWith("└"))).toBe(true)
  const commandRow = lines.find((line) => line.includes("bun test"))!
  const outputRow = lines.find((line) => line.includes("passed"))!
  expect(outputRow.indexOf("passed")).toBe(commandRow.indexOf("bun test"))
  expect(lines.every((line) => line.startsWith("│") === false)).toBe(true)
})
test("keeps wrapped nested shell continuation connectors subtle", () => {
  const state = model({
    width: 60,
    blocks: [
      { ...subagentToolBlock, status: "running", detail: "Inspect the projection" },
      shell("child-a", `git status --short ${"packages/terminal ".repeat(8)}`, "clean"),
      {
        ...shell("child-b", `bun run check ${"packages/execution ".repeat(8)}`, "cancelled"),
        status: "cancelled",
      },
      shell("child-c", "git diff --check", "clean"),
    ],
    items: [
      { _tag: "Block", index: 0, id: "tool:agent", turnId: "turn" },
      { _tag: "Block", index: 1, id: "tool:child-a", turnId: "child:agent", parentId: "agent" },
      { _tag: "Block", index: 2, id: "tool:child-b", turnId: "child:agent", parentId: "agent" },
      { _tag: "Block", index: 3, id: "tool:child-c", turnId: "child:agent", parentId: "agent" },
    ],
    expandedRowKeys: ["tool:agent"],
  })
  const continuationConnectors = buildTranscript(state).styled.chunks.filter((chunk) => chunk.text.includes("│     "))
  expect(continuationConnectors.length).toBeGreaterThan(1)
  expect(continuationConnectors.every((chunk) => chunk.fg !== undefined)).toBe(true)
})
