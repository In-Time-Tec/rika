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
  expect(text).toContain("Editing src/a.ts +1 -1 ▾\n")
  expect(text).toContain("- old")
  expect(text).not.toContain("Edit src/a.ts")
  expect(text).toContain("✓ Checked 1 ▸")
  expect(text).toContain('✕ Grep src "needle" ▾')
  expect(text).toContain("src/a.ts:1:needle")
  expect(text).toContain("✓ Subagent finished ▾")
  expect(text).toMatch(/[▸▾]/u)
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
        detail: "Review `packages/execution` first.\n\n1. Check the resolver\n2. Check the tests",
        files: [],
      },
    ],
    expandedRowKeys: ["tool:task"],
  })
  const built = buildTranscript(state)
  const text = built.styled.chunks.map((chunk) => chunk.text).join("")
  expect(text).toContain("packages/execution")
  expect(text).not.toContain("`packages/execution`")
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
  expect(text).toContain("Checked 1")
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

test("renders a real SubagentGroup with live cards and streamed answers", () => {
  const counts = {
    total: 2,
    queued: 0,
    running: 1,
    waiting: 0,
    cancelling: 0,
    complete: 1,
    failed: 0,
    cancelled: 0,
  }
  const state = model({
    entries: [{ role: "assistant", text: "Do not show this tentative answer yet." }],
    blocks: [
      {
        _tag: "SubagentGroup",
        id: "group",
        name: "Reviewers",
        status: "running",
        settled: false,
        memberIds: ["one", "two"],
        counts,
      },
      {
        _tag: "SubagentCard",
        id: "one",
        name: "Oracle",
        prompt: "Review the design",
        promptTruncated: false,
        summary: "",
        status: "running",
        activity: ["Reading the projection", "Checking failure precedence"],
      },
      {
        _tag: "SubagentCard",
        id: "two",
        name: "Task",
        prompt: "Run the tests",
        promptTruncated: false,
        summary: "",
        status: "complete",
        activity: ["Tests passed"],
      },
    ],
    items: [
      { _tag: "Block", index: 0, id: "group" },
      { _tag: "Block", index: 1, id: "one", parentId: "group" },
      { _tag: "Entry", index: 0, id: "one-answer", parentId: "one" },
      { _tag: "Block", index: 2, id: "two", parentId: "group" },
    ],
  })
  const running = buildTranscript(state)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")
  expect(running).toContain("▾")
  expect(running).toContain("1 agent running, 1 agent finished")
  expect(running).toContain("Checking failure precedence")
  expect(running).toContain("Do not show this tentative answer yet.")

  const settled = {
    ...state,
    blocks: state.blocks.map((block, index) => {
      if (index === 0)
        return {
          _tag: "SubagentGroup" as const,
          id: "group",
          name: "Reviewers",
          status: "complete" as const,
          settled: true,
          memberIds: ["one", "two"],
          counts: { ...counts, running: 0, complete: 2 },
        }
      if (index === 1)
        return {
          _tag: "SubagentCard" as const,
          id: "one",
          name: "Oracle",
          prompt: "Review the design",
          promptTruncated: false,
          summary: "",
          status: "complete" as const,
          activity: ["Checking failure precedence"],
        }
      return block
    }),
    expandedRowKeys: ["subagent-group:group", "subagent:one"],
  }
  const complete = buildTranscript(settled)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")
  expect(complete).toContain("2 agents finished")
  expect(complete).toContain("Do not show this tentative answer yet.")
})

test("summarizes SubagentGroup progress as running and finished agents", () => {
  const renderProgress = (running: number, complete: number) =>
    buildTranscript(
      model({
        blocks: [
          {
            _tag: "SubagentGroup",
            id: "group",
            name: "3 agents",
            status: running > 0 ? ("running" as const) : ("complete" as const),
            settled: running === 0,
            memberIds: ["one", "two", "three"],
            counts: {
              total: 3,
              queued: 0,
              running,
              waiting: 0,
              cancelling: 0,
              complete,
              failed: 0,
              cancelled: 0,
            },
          },
        ],
        items: [{ _tag: "Block", index: 0, id: "group" }],
      }),
    )
      .styled.chunks.map((chunk) => chunk.text)
      .join("")

  expect(renderProgress(3, 0)).toContain("3 agents running")
  expect(renderProgress(2, 1)).toContain("2 agents running, 1 agent finished")
  expect(renderProgress(1, 2)).toContain("1 agent running, 2 agents finished")
  expect(renderProgress(0, 3)).toContain("3 agents finished")
})

test("uses failure precedence for mixed groups and distinct rejected and unknown tones", () => {
  const blocks = [
    shell("ok", "echo ok", "ok"),
    { ...shell("bad", "exit 7", "bad"), status: "failed" as const },
    {
      ...shell("rejected", "rm -rf build", ""),
      status: "rejected" as const,
    },
    {
      ...shell("unknown", "lost-process", ""),
      status: "unknown" as const,
    },
  ]
  const built = buildTranscript(model({ blocks, expandedRowKeys: ["tool:ok"] }))
  const text = built.styled.chunks.map((chunk) => chunk.text).join("")
  expect(text).toContain("✕ Ran 4 commands, 3 failed")
  expect(text).not.toContain("✓ Ran 4 commands")
  const rejected = built.styled.chunks.find((chunk) => chunk.text.includes("(rejected)"))
  const unknown = built.styled.chunks.find((chunk) => chunk.text.includes("(unknown)"))
  expect(rejected?.fg).toBe(colors.red)
  expect(unknown?.fg).toBe(colors.red)
})

test("renders gold Bash prompts, muted native process metadata, and underlined paths", () => {
  const state = model({
    blocks: [
      {
        ...shell("bash", "bun test\nbun run lint", "done"),
        process: {
          processId: "process-7",
          command: "bun test\nbun run lint",
          workdir: "/workspace/packages/terminal",
          background: true,
        },
      },
      {
        _tag: "ToolCall",
        id: "read",
        name: "read",
        input: JSON.stringify({ path: "src/main.ts" }),
        result: { text: "source" },
        status: "complete",
        presentation: {
          family: "explore",
          action: "read",
          activeLabel: "Exploring",
          completeLabel: "Explored",
          counter: "file",
        },
        detail: "src/main.ts",
        files: [],
      },
    ],
  })
  const built = buildTranscript(state)
  const prompt = built.styled.chunks.find((chunk) => chunk.text === "$")
  expect(prompt?.fg).toEqual(colors.gold)
  const metadata = built.styled.chunks.find((chunk) => chunk.text.includes("cwd /workspace/packages/terminal"))
  expect(metadata?.fg).toEqual(colors.muted)
  expect(metadata?.text).toContain("detached · script")
  expect(metadata?.text).not.toContain("process-7")
  const path = built.styled.chunks.find((chunk) => chunk.text.includes("src/main.ts"))
  expect((path?.attributes ?? 0) & 8).toBe(8)
})

test("renders every group member in memberIds order", () => {
  const state = model({
    blocks: [
      {
        _tag: "SubagentGroup",
        id: "group",
        name: "2 agents",
        status: "running",
        settled: false,
        memberIds: ["one", "two"],
        counts: { total: 2, queued: 0, running: 2, waiting: 0, cancelling: 0, complete: 0, failed: 0, cancelled: 0 },
      },
      {
        _tag: "SubagentCard",
        id: "one",
        name: "Oracle",
        prompt: "Prompt Oracle",
        promptTruncated: false,
        summary: "",
        status: "running",
        activity: [],
      },
      {
        _tag: "SubagentCard",
        id: "two",
        name: "Task",
        prompt: "Prompt Task",
        promptTruncated: false,
        summary: "",
        status: "running",
        activity: [],
      },
    ],
    items: [
      { _tag: "Block", index: 0, id: "group" },
      { _tag: "Block", index: 2, id: "two", parentId: "group" },
      { _tag: "Block", index: 1, id: "one", parentId: "group" },
    ],
  })
  const text = buildTranscript(state).styled.chunks.map((chunk) => chunk.text).join("")
  expect(text.indexOf("Prompt Oracle")).toBeLessThan(text.indexOf("Prompt Task"))
})

test("never reports more finished agents than rendered finished rows", () => {
  const state = model({
    blocks: [
      {
        _tag: "SubagentGroup",
        id: "group",
        name: "4 agents",
        status: "complete",
        settled: true,
        memberIds: ["one", "two"],
        counts: { total: 4, queued: 0, running: 0, waiting: 0, cancelling: 0, complete: 4, failed: 0, cancelled: 0 },
      },
      {
        _tag: "SubagentCard",
        id: "one",
        name: "Oracle",
        prompt: "Review the design",
        promptTruncated: false,
        summary: "",
        status: "complete",
        activity: [],
      },
      {
        _tag: "SubagentCard",
        id: "two",
        name: "Task",
        prompt: "Run the tests",
        promptTruncated: false,
        summary: "",
        status: "complete",
        activity: [],
      },
    ],
    items: [
      { _tag: "Block", index: 0, id: "group" },
      { _tag: "Block", index: 1, id: "one", parentId: "group" },
      { _tag: "Block", index: 2, id: "two", parentId: "group" },
    ],
    expandedRowKeys: ["subagent-group:group"],
  })
  const text = buildTranscript(state).styled.chunks.map((chunk) => chunk.text).join("")
  const header = text.match(/(\d+) agents? finished/)
  expect(header?.[1]).toBe("4")
  const finishedRows = text.split("\n").filter((line) => line.includes("✓")).length - 1
  expect(finishedRows).toBeGreaterThanOrEqual(Number(header?.[1] ?? "0"))
})

test("renders an integrity row instead of an inflated summary when a member is missing", () => {
  const state = model({
    blocks: [
      {
        _tag: "SubagentGroup",
        id: "group",
        name: "3 agents",
        status: "complete",
        settled: true,
        memberIds: ["one", "two", "ghost"],
        counts: { total: 3, queued: 0, running: 0, waiting: 0, cancelling: 0, complete: 2, failed: 0, cancelled: 0 },
      },
      {
        _tag: "SubagentCard",
        id: "one",
        name: "Oracle",
        prompt: "Review the design",
        promptTruncated: false,
        summary: "",
        status: "complete",
        activity: [],
      },
      {
        _tag: "SubagentCard",
        id: "two",
        name: "Task",
        prompt: "Run the tests",
        promptTruncated: false,
        summary: "",
        status: "complete",
        activity: [],
      },
    ],
    items: [
      { _tag: "Block", index: 0, id: "group" },
      { _tag: "Block", index: 1, id: "one", parentId: "group" },
      { _tag: "Block", index: 2, id: "two", parentId: "group" },
    ],
    expandedRowKeys: ["subagent-group:group"],
  })
  const text = buildTranscript(state).styled.chunks.map((chunk) => chunk.text).join("")
  expect(text).toMatch(/missing|integrity|unresolved/i)
})
