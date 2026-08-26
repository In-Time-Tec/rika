import { expect, test } from "vitest"
import stringWidth from "string-width"
import { buildTranscript } from "../../../src/opentui/rendering/renderer"
import { adapterFixtures3 } from "../../support/surface/lifecycle.fixture"
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
  _createScoped,
} = adapterFixtures3
test("closes an expanded settled subagent's nested tree with the terminal connector", () => {
  const state = model({
    entries: [{ role: "assistant", text: "All checks passed." }],
    blocks: [
      { ...subagentToolBlock, detail: "Inspect the projection" },
      shell("child-a", "bun test", "passed"),
      shell("child-b", "bun run check", "clean"),
    ],
    items: [
      { _tag: "Block", index: 0, id: "tool:agent", turnId: "turn" },
      { _tag: "Block", index: 1, id: "tool:child-a", turnId: "child:agent", parentId: "agent" },
      { _tag: "Block", index: 2, id: "tool:child-b", turnId: "child:agent", parentId: "agent" },
      { _tag: "Entry", index: 0, id: "answer:0", turnId: "child:agent", parentId: "agent" },
    ],
    expandedRowKeys: ["tool:agent"],
  })
  const lines = nonEmptyLines(
    buildTranscript(state)
      .styled.chunks.map((chunk) => chunk.text)
      .join(""),
  )
  expect(lines.some((line) => line.trimStart().startsWith("├"))).toBe(true)
  expect(lines.some((line) => line.includes("╰"))).toBe(true)
  expect(lines.some((line) => line.includes("All checks passed."))).toBe(true)
  expect(lines.every((line) => String(line).startsWith("│") === false)).toBe(true)
})
test("shows a nested agent title and renders its prompt once in the expanded body", () => {
  const state = model({
    width: 48,
    entries: [{ role: "assistant", text: "Nested summary", turnId: "child:child" }],
    blocks: [
      { ...subagentToolBlock, id: "parent", detail: "Explore the project" },
      {
        ...subagentToolBlock,
        id: "child",
        detail: "Read-only explore packages/configuration, extensions, and tools with concise source-file evidence.",
      },
      shell("grandchild", "git status", "clean"),
      shell("following", "git status", "clean"),
    ],
    items: [
      { _tag: "Block", index: 0, id: "tool:parent", turnId: "turn" },
      { _tag: "Block", index: 1, id: "tool:child", turnId: "child:parent", parentId: "parent" },
      { _tag: "Block", index: 2, id: "tool:grandchild", turnId: "child:child", parentId: "child" },
      { _tag: "Block", index: 3, id: "tool:following", turnId: "child:parent", parentId: "parent" },
      { _tag: "Entry", index: 0, id: "assistant:child:child:0", turnId: "child:child", parentId: "child" },
    ],
    expandedRowKeys: ["tool:parent", "tool:child"],
  })
  const lines = buildTranscript(state)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")
    .split("\n")

  const text = lines.join("\n")
  expect(lines.some((line) => line.startsWith("  ├ ✓ Subagent finished ▾"))).toBe(true)
  expect(lines.some((line) => line.startsWith("  │   Read-only explore"))).toBe(true)
  expect(lines.some((line) => line.startsWith("  │   ├ ✓ $ git status"))).toBe(true)
  expect(lines.some((line) => line.startsWith("  │   ╰   Nested summary"))).toBe(true)
  expect(text.match(/Read-only explore/g)).toHaveLength(1)
  expect(lines.every((line) => stringWidth(line) <= 44)).toBe(true)
})
test("keeps deep nested agent headers within a narrow terminal with wide text", () => {
  const blocks = Array.from({ length: 6 }, (_, index) => ({
    ...subagentToolBlock,
    id: `agent-${index}`,
    detail: `界界界 inspect nested package ${index} with source evidence`,
  }))
  const items = blocks.map((block, index) =>
    index === 0
      ? { _tag: "Block" as const, index, id: `tool:${block.id}`, turnId: "turn" }
      : {
          _tag: "Block" as const,
          index,
          id: `tool:${block.id}`,
          turnId: `child:agent-${index - 1}`,
          parentId: `agent-${index - 1}`,
        },
  )
  const built = buildTranscript(
    model({
      width: 20,
      blocks,
      items,
      expandedRowKeys: blocks.map((block) => `tool:${block.id}`),
    }),
  )
  const lines = built.styled.chunks
    .map((chunk) => chunk.text)
    .join("")
    .split("\n")
  const nestedRanges = built.ranges.filter(
    (range) => range.unit.startsWith("tool:agent-") && range.headerEnd !== undefined,
  )
  const headers = nestedRanges.flatMap((range) => lines.slice(range.start, range.headerEnd! + 1))

  expect(headers.some((line) => line.includes("界"))).toBe(false)
  expect(headers.every((line) => stringWidth(line) <= 16)).toBe(true)
  expect(nestedRanges.every((range) => lines[range.headerEnd!]!.endsWith("▾"))).toBe(true)
})
test("labels a new-file patch Create and an existing-file patch Edit", () => {
  const createBlock = {
    ...editToolBlock,
    id: "create",
    files: [
      {
        key: "create:0",
        path: "tmp-agent-test.txt",
        kind: "add",
        patch: "--- /dev/null\n+++ b/tmp-agent-test.txt\n@@ -0,0 +1 @@\n+hello",
        additions: 1,
        deletions: 0,
        preview: false,
        status: "complete",
      },
    ],
  } as const
  const created = renderedText({ blocks: [createBlock], expandedRowKeys: [] })
  expect(created).toContain("Created tmp-agent-test.txt +1")
  expect(created).not.toContain("-0")
  const edited = renderedText({ blocks: [editToolBlock], expandedRowKeys: [] })
  expect(edited).toContain("Edited src/a.ts +1 -1")
  const runningCreate = renderedText({
    blocks: [{ ...createBlock, status: "running" }],
    expandedRowKeys: [],
  })
  expect(runningCreate).toContain("Creating tmp-agent-test.txt +1")
})
test("keeps Edited for a mixed group and labels each child row by its file kind", () => {
  const mixedBlock = {
    ...editToolBlock,
    id: "mixed",
    files: [
      {
        key: "mixed:0",
        path: "tmp-agent-test.txt",
        kind: "add",
        patch: "--- /dev/null\n+++ b/tmp-agent-test.txt\n@@ -0,0 +1 @@\n+hello",
        additions: 1,
        deletions: 0,
        preview: false,
        status: "complete",
      },
      {
        key: "mixed:1",
        path: "src/a.ts",
        kind: "update",
        patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
        additions: 1,
        deletions: 1,
        preview: false,
        status: "complete",
      },
    ],
  } as const
  const collapsed = renderedText({ blocks: [mixedBlock], expandedRowKeys: [] })
  expect(collapsed).toContain("Edited 2 files")
  const expanded = renderedText({ blocks: [mixedBlock], expandedRowKeys: ["tool:mixed"] })
  expect(expanded).toContain("Create tmp-agent-test.txt +1")
  expect(expanded).toContain("Edit src/a.ts +1 -1")
})
test("labels a new-file Diff block Created", () => {
  const created = renderedText({
    blocks: [
      {
        _tag: "Diff",
        path: "tmp-agent-test.txt",
        patch: "--- /dev/null\n+++ b/tmp-agent-test.txt\n@@ -0,0 +1 @@\n+hello",
      },
    ],
    expandedRowKeys: [],
  })
  expect(created).toContain("Created tmp-agent-test.txt")
})
test("connects and aligns the subagent response after two blank timeline rows", () => {
  const state = model({
    entries: [
      {
        role: "assistant",
        text: "Architectural overview\n\nThe projection stays pure.",
        turnId: "child:agent",
      },
    ],
    blocks: [{ ...subagentToolBlock, detail: "Inspect the projection" }, shell("child-a", "bun test", "passed")],
    items: [
      { _tag: "Block", index: 0, id: "tool:agent", turnId: "turn" },
      { _tag: "Block", index: 1, id: "tool:child-a", turnId: "child:agent", parentId: "agent" },
      { _tag: "Entry", index: 0, id: "assistant:child:agent:0", turnId: "child:agent", parentId: "agent" },
    ],
    expandedRowKeys: ["tool:agent"],
  })
  const lines = buildTranscript(state)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")
    .split("\n")
  const childRow = lines.findIndex((line) => line.includes("bun test"))
  const responseRow = lines.findIndex((line) => line.includes("Architectural overview"))
  expect(childRow).toBeGreaterThan(-1)
  expect(lines[childRow]!.startsWith("  ├ ✓ $ bun test")).toBe(true)
  expect(responseRow).toBe(childRow + 3)
  expect(lines[childRow + 1]).toBe("  │")
  expect(lines[childRow + 2]).toBe("  │")
  expect(lines[responseRow]!.indexOf("Architectural overview")).toBe(lines[childRow]!.indexOf("$ bun test"))
  const lastResponseRow = lines.findIndex((line) => line.includes("stays pure"))
  expect(lastResponseRow).toBeGreaterThan(responseRow)
  for (const [offset, row] of lines.slice(childRow + 1, lastResponseRow).entries())
    expect([offset, row.startsWith("  │")]).toEqual([offset, true])
  expect(lines[lastResponseRow]!.startsWith("  ╰ ")).toBe(true)
  expect(lines.every((line) => String(line).startsWith("│") === false)).toBe(true)
})
