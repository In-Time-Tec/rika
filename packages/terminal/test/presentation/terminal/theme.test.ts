import { expect, test } from "vitest"
import { buildTranscript } from "../../../src/opentui/rendering/renderer"

import { colors } from "../../../src/presentation/terminal/theme"
import { shell, agentToolBlock, model } from "./theme.fixture"
test("matches Amp edit, wait, explore, and subagent row shapes", () => {
  const presentation = {
    edit: { family: "edit" as const, action: "edit", activeLabel: "Editing", completeLabel: "Edited" },
    direct: { family: "direct" as const, action: "status", activeLabel: "Waiting for", completeLabel: "Waited for" },
    explore: {
      family: "explore" as const,
      action: "grep",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "search" as const,
    },
    agent: {
      family: "agent" as const,
      action: "task",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    },
  }
  const patch = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new"
  const state = model({
    blocks: [
      {
        _tag: "ToolCall",
        id: "patch",
        name: "edit",
        input: "{}",
        status: "running",
        presentation: presentation.edit,
        detail: "",
        files: [
          {
            key: "patch:0",
            path: "src/a.ts",
            kind: "update",
            patch,
            additions: 1,
            deletions: 1,
            preview: true,
            status: "running",
          },
        ],
      },
      {
        _tag: "ToolCall",
        id: "wait",
        name: "shell_command_status",
        input: JSON.stringify({ processId: "1" }),
        result: { text: "done" },
        status: "complete",
        presentation: presentation.direct,
        detail: "bun test",
        files: [],
      },
      {
        _tag: "ToolCall",
        id: "grep",
        name: "grep",
        input: JSON.stringify({ path: "src", pattern: "needle" }),
        result: { text: "src/a.ts:1:needle" },
        status: "failed",
        presentation: presentation.explore,
        detail: 'src "needle"',
        files: [],
      },
      {
        _tag: "ToolCall",
        id: "task",
        name: "task",
        input: "{}",
        result: { text: "child result" },
        status: "complete",
        presentation: presentation.agent,
        detail: "Fix packaging integration tests",
        files: [],
      },
    ],
    expandedRowKeys: ["tool:grep", "tool:task"],
  })
  const built = buildTranscript(state)
  const text = built.styled.chunks.map((chunk) => chunk.text).join("")
  expect(text).toContain("Editing src/a.ts +1 -1\n")
  expect(text).toContain("- old")
  expect(text).not.toContain("Edit src/a.ts")
  expect(text).toContain("Waited for bun test")
  expect(text).toContain('✕ Grep src "needle" src/a.ts:1:needle')
  expect(text).toContain("Subagent finished")
  expect(text).not.toMatch(/[▸▾]/u)
  expect(text).toContain("Fix packaging integration tests")
  expect(text).not.toContain("Subagent finished Fix packaging integration tests")
})
test("renders an expanded delegation prompt as markdown", () => {
  const state = model({
    blocks: [
      {
        _tag: "ToolCall",
        id: "task",
        name: "task",
        input: "{}",
        result: { text: "child result" },
        status: "complete",
        presentation: {
          family: "agent" as const,
          action: "task",
          activeLabel: "Subagent working",
          completeLabel: "Subagent finished",
        },
        detail: "Review `packages/coding-tools` first.\n\n1. Check the resolver\n2. Check the tests",
        files: [],
      },
    ],
    expandedRowKeys: ["tool:task"],
  })
  const built = buildTranscript(state)
  const text = built.styled.chunks.map((chunk) => chunk.text).join("")
  expect(text).toContain("packages/coding-tools")
  expect(text).not.toContain("`packages/coding-tools`")
  expect(text).toContain("1. Check the resolver")
})
test("keeps the exit code on a failed shell row with nested process waits", () => {
  const state = model({
    blocks: [
      {
        ...shell("bash", "bun test", "initial output"),
        status: "failed",
        process: { processId: "1", running: false, exitCode: 7 },
      },
      {
        _tag: "ToolCall",
        id: "wait",
        name: "shell_command_status",
        input: JSON.stringify({ processId: "1" }),
        result: { text: "failed output" },
        status: "failed",
        presentation: {
          family: "direct",
          action: "status",
          activeLabel: "Waiting for",
          completeLabel: "Waited for",
        },
        detail: "bun test",
        parentId: "bash",
        process: { processId: "1", running: false, exitCode: 7 },
        files: [],
      },
    ],
    items: [
      { _tag: "Block", index: 0, id: "tool:bash" },
      { _tag: "Block", index: 1, id: "tool:wait", parentId: "bash" },
    ],
    expandedRowKeys: ["tool:bash"],
  })

  const text = buildTranscript(state)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")
  expect(text).toContain("$ bun test (exit code: 7)")
  expect(text).toContain("Waited for bun test")
})
test("renders an expanded failed subagent's failure text in red", () => {
  const state = model({
    blocks: [agentToolBlock("failed", undefined)],
    items: [{ _tag: "Block", index: 0, id: "tool:agent" }],
    childExecutionOutcomes: { agent: { status: "failed", reason: "network exploded" } },
    expandedRowKeys: ["tool:agent"],
  })
  const built = buildTranscript(state)
  const chunk = built.styled.chunks.find((current) => current.text.includes("network exploded"))
  expect(chunk).toBeDefined()
  expect(chunk?.fg).toBe(colors.red)
})
test("tones a cancelled subagent amber and an empty completed subagent dim", () => {
  const cancelled = model({
    blocks: [agentToolBlock("cancelled", undefined)],
    items: [{ _tag: "Block", index: 0, id: "tool:agent" }],
    childExecutionOutcomes: { agent: { status: "cancelled", reason: "user stopped the run" } },
    expandedRowKeys: ["tool:agent"],
  })
  const cancelledChunk = buildTranscript(cancelled).styled.chunks.find((current) =>
    current.text.includes("user stopped the run"),
  )
  expect(cancelledChunk?.fg).toBe(colors.amber)

  const completed = model({
    blocks: [agentToolBlock("complete", undefined)],
    items: [{ _tag: "Block", index: 0, id: "tool:agent" }],
    expandedRowKeys: ["tool:agent"],
  })
  const built = buildTranscript(completed)
  const infoChunk = built.styled.chunks.find((current) => current.text.includes("finished without a final message"))
  expect(infoChunk).toBeDefined()
  expect(infoChunk?.fg).toBe(colors.text)
  expect(
    built.styled.chunks
      .map((current) => current.text)
      .join("")
      .match(/The subagent finished without a final message\./g),
  ).toHaveLength(1)
})
test("renders a completed subagent's final answer, not a blank terminal", () => {
  const state = model({
    entries: [{ role: "assistant", text: "The bug was a missing await." }],
    blocks: [agentToolBlock("complete", undefined)],
    items: [
      { _tag: "Block", index: 0, id: "tool:agent" },
      { _tag: "Entry", index: 0, id: "answer:0", parentId: "agent" },
    ],
    expandedRowKeys: ["tool:agent"],
  })
  const text = buildTranscript(state)
    .styled.chunks.map((current) => current.text)
    .join("")
  expect(text).toContain("The bug was a missing await.")
  expect(text).not.toContain("finished without a final message")
})
