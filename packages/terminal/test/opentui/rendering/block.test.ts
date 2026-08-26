import { expect, test } from "vitest"
import { buildTranscript, renderTranscriptStyled } from "../../../src/opentui/rendering/renderer"
import { renderBlock, renderSidebar } from "../../../src/opentui/rendering/block"
import { colors } from "../../../src/presentation/terminal/theme"
import {
  shell,
  _windowUnitToolCall,
  _handlers,
  _nonEmptyLines,
  model,
  thread,
  _createScoped,
} from "../../presentation/terminal/theme.fixture"
test("renders every transcript block variant and sidebar state", () => {
  const blocks = [
    { _tag: "Reasoning", text: "why" },
    { _tag: "Reasoning", text: "why" },
    {
      _tag: "ToolCall",
      id: "1",
      name: "read",
      input: "a",
      status: "running",
      presentation: {
        family: "explore",
        action: "read",
        activeLabel: "Exploring",
        completeLabel: "Explored",
        counter: "file",
      },
      detail: "a",
      files: [],
    },
    {
      _tag: "ToolCall",
      id: "2",
      name: "write",
      input: "b",
      status: "complete",
      presentation: { family: "edit", action: "edit", activeLabel: "Editing", completeLabel: "Edited" },
      detail: "b",
      files: [],
    },
    { _tag: "ToolResult", id: "1", output: "ok", failed: false },
    { _tag: "ToolResult", id: "2", output: "bad", failed: true },
    { _tag: "Diff", path: "a", patch: "+x" },
    { _tag: "ContextUsage", text: "80%", cost: "$0.12" },
    { _tag: "ContextUsage", text: "unknown" },
    { _tag: "Compaction", summary: "Kept recent turns", checkpoint: "42", status: "complete" as const },
    { _tag: "Compaction", summary: "No checkpoint", status: "complete" as const },
    { _tag: "Compaction", summary: "", status: "running" as const },
    { _tag: "Notification", title: "Complete", detail: "Review finished" },
    {
      _tag: "Error",
      title: "Execution failed",
      detail: "Model unavailable",
      turnId: "turn-4",
      category: "operation",
      retryable: false,
    },
    {
      _tag: "SubagentCard",
      id: "child",
      name: "child",
      prompt: "",
      promptTruncated: false,
      summary: "work",
      status: "running",
      activity: [],
    },
    { _tag: "ImageAttachment", name: "a.png", mediaType: "image/png" },
    { _tag: "ImageAttachment", name: "partial.png", mediaType: "image/png", width: 2 },
    { _tag: "ImageAttachment", name: "b.png", mediaType: "image/png", width: 2, height: 3, bytes: 4 },
    {
      _tag: "Cell",
      id: "cell-running",
      status: "running",
      visual: "ts",
      summary: 'await rika.workspace.read({ path: "a.ts" })',
      source: { text: 'await rika.workspace.read({ path: "a.ts" })', lines: 1, truncated: false },
      output: { stdout: "", stderr: "", droppedBytes: 0, droppedEvents: 0 },
      epoch: 0,
      notices: [],
      files: [],
    },
    {
      _tag: "Cell",
      id: "cell-complete",
      status: "complete",
      visual: "shell",
      summary: "await Bun.$`bun test`",
      source: { text: "await Bun.$`bun test`", lines: 1, truncated: false },
      output: { stdout: "pass\n", stderr: "", droppedBytes: 12, droppedEvents: 1 },
      result: "0",
      durationMillis: 1_240,
      epoch: 1,
      notices: [{ kind: "restored", detail: "Restored total." }],
      files: [],
    },
    {
      _tag: "Cell",
      id: "cell-failed",
      status: "failed",
      visual: "ts",
      summary: 'throw new Error("boom")',
      source: { text: 'throw new Error("boom")', lines: 1, truncated: false },
      output: { stdout: "", stderr: "trace\n", droppedBytes: 0, droppedEvents: 0 },
      error: { name: "Error", message: "boom" },
      epoch: 1,
      notices: [],
      files: [],
    },
  ] as const
  const renderedBlocks = blocks.map((block) => renderBlock(block)).join("\n")
  expect(renderedBlocks).toContain("✕ Result")
  expect(renderedBlocks).toContain("↻ Auto-compacting context…")
  expect(renderedBlocks).toContain("❋ Auto-compacted\n  Kept recent turns")
  expect(renderedBlocks).toContain("❋ Auto-compacted\n  No checkpoint")
  expect(renderedBlocks).not.toContain(" at 42")
  expect(renderedBlocks).toContain("ERROR\n  Execution failed: Model unavailable")
  expect(renderedBlocks).toContain("2×3 · 4 B")
  expect(renderedBlocks).toContain('⠿ ts await rika.workspace.read({ path: "a.ts" })')
  expect(renderedBlocks).toContain("✓ $ await Bun.$`bun test` 1.2s truncated")
  expect(renderedBlocks).toContain('✕ ts throw new Error("boom")')
  const state = model({
    blocks: [...blocks],
    currentThreadId: "a",
    threads: [thread({ id: "a", title: "One", unread: true }), thread({ id: "b", title: "Two" })],
  })
  const sidebar = renderSidebar(state)
    .chunks.map((chunk) => chunk.text)
    .join("")
  expect(sidebar).toContain(" * One")
  expect(sidebar).toContain("   Two")
})
test("renders hidden tool output as inline presentation status in plain transcripts", () => {
  const block = {
    _tag: "ToolCall" as const,
    id: "web",
    name: "web_search",
    input: JSON.stringify({ objective: "Find current documentation" }),
    output: "HIDDEN SEARCH RESULT",
    status: "complete" as const,
    presentation: {
      family: "direct" as const,
      action: "web-search",
      activeLabel: "Web Search",
      completeLabel: "Web Search",
      outputDisplay: "hidden" as const,
    },
    detail: "Find current documentation",
    files: [],
  }
  const state = model({ blocks: [block] })

  const transcript = renderTranscriptStyled(state)
    .chunks.map((chunk) => chunk.text)
    .join("")
  expect(renderBlock(block)).toBe("✓ Web Search Find current documentation")
  expect(transcript).toContain("Web Search")
  expect(transcript).not.toContain("HIDDEN SEARCH RESULT")
})
test("shows the error cause on the first lines with no instructions", () => {
  const block = {
    _tag: "Error" as const,
    title: "Execution failed",
    detail: "Model unavailable",
    turnId: "turn-4",
    category: "operation",
    retryable: false,
  }
  const text = buildTranscript(model({ blocks: [block] }))
    .styled.chunks.map((chunk) => chunk.text)
    .join("")

  expect(text).toContain("ERROR\n  Execution failed: Model unavailable")
  expect(text).not.toContain("Next:")
  expect(text).not.toContain("▸")
  expect(text).not.toContain("▾")
  expect(text).not.toContain("✖")
  expect(
    buildTranscript(model({ blocks: [block] })).styled.chunks.find((chunk) => chunk.text.includes("ERROR"))?.fg,
  ).toBe(colors.red)
})
test("keeps tool cards generic without removed activity assumptions", () => {
  const rendered = renderBlock({
    _tag: "ToolCall",
    id: "custom-1",
    name: "Plugin-defined tool",
    input: "opaque input",
    status: "running",
    presentation: { family: "generic", action: "tool", activeLabel: "Running tool", completeLabel: "Ran tool" },
    detail: "opaque input",
    files: [],
  })

  expect(rendered).toBe("⠿ Running tool opaque input")
  expect(rendered).not.toMatch(/rivet|semantic[- ]search|ast[- ]grep[- ]outline/i)
})
test("expands grouped tools and each nested command independently", () => {
  const collapsedChild = model({
    blocks: [shell("one", "bun test", "passed"), shell("two", "bun run lint", "clean")],
    expandedRowKeys: ["tool:one"],
  })
  const collapsed = buildTranscript(collapsedChild)
  expect(collapsed.ranges.map((range) => range.unit)).toEqual(["tool:one", "tool-child:one", "tool-child:two"])
  expect(collapsed.styled.chunks.map((chunk) => chunk.text).join("")).not.toContain("passed")
  const expanded = buildTranscript({
    ...collapsedChild,
    expandedRowKeys: ["tool:one", "tool-child:one"],
  })
  const expandedLines = expanded.styled.chunks
    .map((chunk) => chunk.text)
    .join("")
    .split("\n")
  const commandRow = expandedLines.find((line) => line.includes("bun test"))!
  const outputRow = expandedLines.find((line) => line.includes("passed"))!
  expect(outputRow.indexOf("passed")).toBe(commandRow.indexOf("bun test"))
  expect(expandedLines.join("\n")).not.toContain("clean")
})
test("uses the tool presentation label for a single created file", () => {
  const rendered = buildTranscript(
    model({
      blocks: [
        {
          _tag: "ToolCall",
          id: "create",
          name: "write",
          input: JSON.stringify({ path: "src/new.ts" }),
          status: "complete",
          presentation: { family: "edit", action: "create", activeLabel: "Creating", completeLabel: "Created" },
          detail: "src/new.ts",
          files: [
            {
              key: "create:0",
              path: "src/new.ts",
              kind: "add",
              patch: "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+new",
              additions: 1,
              deletions: 0,
              preview: false,
              status: "complete",
            },
          ],
        },
      ],
    }),
  )

  expect(rendered.styled.chunks.map((chunk) => chunk.text).join("")).toContain("Created src/new.ts +1")
})
