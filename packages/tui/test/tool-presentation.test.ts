import { TextAttributes, type TextChunk } from "@opentui/core"
import { project } from "@rika/transcript"
import { describe, expect, test } from "vitest"
import { buildTranscript } from "../src/adapter"
import { colors } from "../src/theme"
import { expandableRowIds, toolDetail, rows as transcriptUnits } from "../src/transcript-presenter"
import { initial, type Model, type TranscriptBlock } from "../src/view-state"

type ToolCall = Extract<TranscriptBlock, { readonly _tag: "ToolCall" }>

const call = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  presentation: ToolCall["presentation"],
  changes: Partial<ToolCall> = {},
): ToolCall => ({
  _tag: "ToolCall",
  id,
  name,
  input: JSON.stringify(input),
  status: "complete",
  presentation,
  detail: "",
  files: [],
  ...changes,
})

const model = (blocks: ReadonlyArray<ToolCall>, expandedRowKeys: ReadonlyArray<string> = []): Model => ({
  ...initial("/workspace", "medium"),
  blocks,
  items: blocks.map((_, index) => ({ _tag: "Block" as const, index, id: `item:${index}`, turnId: "turn" })),
  expandedRowKeys,
})

const text = (value: Model): string =>
  buildTranscript(value)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")

const chunkFor = (chunks: ReadonlyArray<TextChunk>, snippet: string): TextChunk => {
  const chunk = chunks.find((candidate) => candidate.text.includes(snippet))
  if (chunk === undefined) throw new Error(`Missing styled chunk for ${snippet}`)
  return chunk
}

const hasAttribute = (chunk: TextChunk, attribute: number): boolean =>
  ((chunk.attributes ?? TextAttributes.NONE) & attribute) === attribute

const shellPresentation: ToolCall["presentation"] = {
  family: "shell",
  action: "command",
  activeLabel: "Running",
  completeLabel: "Ran",
}

const explore = (
  action: string,
  counter: NonNullable<ToolCall["presentation"]["counter"]>,
): ToolCall["presentation"] => ({
  family: "explore",
  action,
  activeLabel: "Exploring",
  completeLabel: "Explored",
  counter,
})

describe("tool presentation", () => {
  test("keeps a completed Explore group successful while showing its failed tool", () => {
    const blocks = [
      call("read", "read", { path: "missing.ts" }, explore("read", "file"), {
        detail: "missing.ts",
        status: "failed",
        output: "File not found",
      }),
      call("search", "grep", { pattern: "owner" }, explore("grep", "search"), { detail: "owner" }),
    ]

    const rendered = text(model(blocks, ["tool:read"]))

    expect(rendered).toContain("✓ Explored 1 file, 1 search")
    expect(rendered).toContain("✕ Read missing.ts File not found")
  })

  test.each([
    ["all failed", ["failed", "failed"], "✕ Explored"],
    ["all cancelled", ["cancelled", "cancelled"], "⊘ Explored"],
    ["failed and cancelled", ["failed", "cancelled"], "✕ Explored"],
  ] as const)("shows an Explore group as terminal when %s", (_, statuses, expected) => {
    const blocks = statuses.map((status, index) =>
      call(`read-${index}`, "read", { path: `${index}.ts` }, explore("read", "file"), {
        detail: `${index}.ts`,
        status,
      }),
    )

    expect(text(model(blocks))).toContain(`${expected} 2 files`)
  })

  test("uses user-facing expanded labels for every exploration action", () => {
    const blocks = [
      call("read", "get_diagnostics", { path: "src/a.ts" }, explore("read", "file"), { detail: "src/a.ts" }),
      call("media", "view_media", { path: "image.png" }, explore("media", "media file"), {
        detail: "image.png",
      }),
      call("grep", "ripgrep", { query: "needle" }, explore("grep", "search"), { detail: "needle" }),
      call("search", "glob", { glob: "**/*.ts" }, explore("search", "search"), { detail: "**/*.ts" }),
      call("skill", "skill", { name: "tool-authoring" }, explore("skill", "skill"), {
        detail: "tool-authoring",
      }),
    ]
    const rendered = text(model(blocks, ["tool:read"]))

    expect(rendered).toContain("Read src/a.ts")
    expect(rendered).toContain("Viewed image.png")
    expect(rendered).toContain("Grep needle")
    expect(rendered).toContain("Searched **/*.ts")
    expect(rendered).toContain("tool-authoring")
    expect(rendered).not.toContain("Searched tool-authoring")
  })

  test("keeps source order while grouping only adjacent compatible families", () => {
    const blocks = [
      call("read", "read", { path: "a.ts" }, explore("read", "file")),
      call("search", "grep", { pattern: "x" }, explore("grep", "search")),
      call(
        "unknown",
        "mcp__server__lookup",
        { query: "x" },
        {
          family: "generic",
          action: "tool",
          activeLabel: "Running tool",
          completeLabel: "Ran tool",
        },
        { detail: "x" },
      ),
      call(
        "shell-one",
        "bash",
        { command: "one" },
        {
          family: "shell",
          action: "command",
          activeLabel: "Running",
          completeLabel: "Ran",
        },
      ),
      call(
        "shell-two",
        "bash",
        { command: "two" },
        {
          family: "shell",
          action: "command",
          activeLabel: "Running",
          completeLabel: "Ran",
        },
      ),
      call("read-two", "view_file", { path: "b.ts" }, explore("read", "file")),
    ]

    expect(transcriptUnits(model(blocks))).toMatchObject([
      { kind: "tool", group: "explore", blocks: [0, 1] },
      { kind: "tool", group: "other", blocks: [2] },
      { kind: "tool", group: "shell", blocks: [3, 4] },
      { kind: "tool", group: "explore", blocks: [5] },
    ])
    const rendered = text(model(blocks, ["tool:unknown", "tool:shell-one"]))
    expect(rendered).toContain("Ran tool x")
    expect(rendered).not.toContain("mcp__server__lookup")
    expect(rendered).toContain("Ran 2 commands")
  })

  test("shows failed details and bounds expanded tool and command output", () => {
    const output = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n")
    const unknown = call(
      "unknown",
      "mcp__server__lookup",
      { query: "needle" },
      { family: "generic", action: "tool", activeLabel: "Running tool", completeLabel: "Ran tool" },
      { status: "failed", detail: "needle", output },
    )
    const shell = call(
      "shell",
      "bash",
      { command: "failing-command" },
      { family: "shell", action: "command", activeLabel: "Running", completeLabel: "Ran" },
      { status: "failed", detail: "failing-command", output, process: { exitCode: 23 } },
    )
    const rendered = text(model([unknown, shell], ["tool:unknown", "tool:shell"]))

    expect(rendered).toContain("✕ Ran tool needle")
    expect(rendered).toContain("$ failing-command (exit code: 23)")
    expect(rendered).toContain("line-12")
    expect(rendered).not.toContain("line-13")
  })

  test("highlights shell command syntax in transcript rows", () => {
    const command = 'git commit --amend -m "fix" && git push'
    const shell = call("shell", "bash", { command }, shellPresentation, { detail: command })
    const chunks = buildTranscript(model([shell])).styled.chunks
    expect(hasAttribute(chunkFor(chunks, "$ "), TextAttributes.DIM)).toBe(true)
    expect(hasAttribute(chunkFor(chunks, "git"), TextAttributes.BOLD)).toBe(true)
    expect(chunkFor(chunks, "--amend").fg?.equals(colors.amber)).toBe(true)
    expect(chunkFor(chunks, '"fix"').fg?.equals(colors.green)).toBe(true)
    expect(hasAttribute(chunkFor(chunks, "&&"), TextAttributes.DIM)).toBe(true)
  })

  test("highlights each command of an expanded shell group", () => {
    const first = call("shell-one", "bash", { command: "git fetch origin main" }, shellPresentation, {
      detail: "git fetch origin main",
    })
    const second = call("shell-two", "bash", { command: "git push --force-with-lease" }, shellPresentation, {
      detail: "git push --force-with-lease",
    })
    const chunks = buildTranscript(model([first, second], ["tool:shell-one"])).styled.chunks
    const commands = chunks.filter((chunk) => chunk.text === "git")
    expect(commands).toHaveLength(2)
    for (const word of commands) expect(hasAttribute(word, TextAttributes.BOLD)).toBe(true)
    expect(chunkFor(chunks, "--force-with-lease").fg?.equals(colors.amber)).toBe(true)
  })

  test("keeps a selected shell row uniformly highlighted", () => {
    const shell = call("shell", "bash", { command: "git status --short" }, shellPresentation, {
      detail: "git status --short",
      output: "ok",
    })
    const chunks = buildTranscript({ ...model([shell]), detailSelection: "tool:shell" }).styled.chunks
    const row = chunkFor(chunks, "$ git status --short")
    expect(hasAttribute(row, TextAttributes.BOLD)).toBe(true)
    expect(row.fg?.equals(colors.blue)).toBe(true)
  })

  test("shows web research as inline status without displaying or expanding output", () => {
    const webSearch = call(
      "web-search",
      "web_search",
      { objective: "Find current documentation" },
      {
        family: "direct",
        action: "web-search",
        activeLabel: "Web Search",
        completeLabel: "Web Search",
        outputDisplay: "hidden",
      },
      { detail: "Find current documentation", output: "SEARCH RESULT BODY" },
    )
    const readPage = call(
      "read-page",
      "read_web_page",
      { url: "https://example.com" },
      {
        family: "direct",
        action: "read-web-page",
        activeLabel: "Read",
        completeLabel: "Read",
        outputDisplay: "hidden",
      },
      { detail: "https://example.com", output: "PAGE RESULT BODY" },
    )
    const value = model([webSearch, readPage], ["tool:web-search", "tool:read-page"])
    const rendered = text(value)

    expect(rendered).toContain("Web Search Find current documentation")
    expect(rendered).toContain("Read https://example.com")
    expect(rendered).not.toContain("SEARCH RESULT BODY")
    expect(rendered).not.toContain("PAGE RESULT BODY")
    expect(rendered).not.toContain("▸")
    expect(rendered).not.toContain("▾")
    expect(expandableRowIds(value)).toEqual([])
  })

  test.each(["running", "failed"] as const)("keeps %s hidden web output inline and out of navigation", (status) => {
    const webSearch = call(
      `web-${status}`,
      "web_search",
      { objective: "Find current documentation" },
      {
        family: "direct",
        action: "web-search",
        activeLabel: "Web Search",
        completeLabel: "Web Search",
        outputDisplay: "hidden",
      },
      { status, detail: "Find current documentation", output: "HIDDEN LIFECYCLE OUTPUT" },
    )
    const value = model([webSearch], [`tool:web-${status}`])
    const rendered = text(value)

    expect(rendered).toContain("Web Search Find current documentation")
    expect(rendered).not.toContain("HIDDEN LIFECYCLE OUTPUT")
    expect(rendered).not.toContain("▸")
    expect(rendered).not.toContain("▾")
    expect(expandableRowIds(value)).toEqual([])
  })

  test("does not navigate to an expandable direct tool until it has output", () => {
    const direct = call(
      "direct",
      "custom_status",
      {},
      {
        family: "direct",
        action: "custom-status",
        activeLabel: "Checking",
        completeLabel: "Checked",
      },
    )

    expect(expandableRowIds(model([direct]))).toEqual([])
    expect(expandableRowIds(model([{ ...direct, output: "DISPLAYED RESULT" }]))).toEqual(["tool:direct"])
  })

  test("keeps explicit expandable output behavior", () => {
    const direct = call(
      "direct",
      "custom_status",
      {},
      {
        family: "direct",
        action: "custom-status",
        activeLabel: "Checking",
        completeLabel: "Checked",
        outputDisplay: "expandable",
      },
      { output: "DISPLAYED RESULT" },
    )
    const value = model([direct], ["tool:direct"])

    expect(text(value)).toContain("DISPLAYED RESULT")
    expect(expandableRowIds(value)).toEqual(["tool:direct"])
  })

  test("switches one stable row from its running label to its completed label", () => {
    const presentation = {
      family: "direct" as const,
      action: "message-thread",
      activeLabel: "Sending message to thread",
      completeLabel: "Sent message to thread",
    }
    const running = call("message", "send_message_to_thread", { thread: "T-1" }, presentation, {
      status: "running",
    })
    const complete = { ...running, status: "complete" as const, output: "sent" }

    expect(text(model([running]))).toContain("Sending message to thread")
    expect(text(model([complete]))).toContain("Sent message to thread")
    expect(transcriptUnits(model([running]))).toHaveLength(1)
    expect(transcriptUnits(model([complete]))).toHaveLength(1)
    expect(toolDetail(0, complete).label).toBe("Sent message to thread")
  })

  const streamingBlock = (name: string, partialInput: string): ToolCall => {
    const projection = project("turn", "prompt", [
      {
        cursor: "0",
        sequence: 0,
        type: "model.toolcall.delta",
        createdAt: 0,
        data: { tool_call_id: "call", tool_name: name, delta: partialInput },
      },
    ])
    const unit = projection.units.find((candidate) => candidate.key === "tool:turn:call")
    if (unit?.content._tag !== "Block" || unit.content.block._tag !== "ToolCall")
      throw new Error("expected a streaming ToolCall block")
    return unit.content.block
  }

  test("renders a styled shell command line while the tool input is still streaming", () => {
    const block = streamingBlock("bash", '{"command":"mkdir -p src/tools')
    const rendered = text(model([block]))

    expect(rendered).toContain("mkdir -p src/tools")
    expect(rendered).not.toContain('{"command"')
    expect(text(model([{ ...block, status: "complete" }]))).toContain("$ mkdir -p src/tools")
  })

  test("unescapes streamed shell newlines into real command lines", () => {
    const block = streamingBlock("bash", '{"command":"mkdir -p src/tools\\ncat > a.ts')
    const rendered = text(model([block]))

    expect(rendered).toContain("mkdir -p src/tools")
    expect(rendered).toContain("cat > a.ts")
    expect(rendered).not.toContain("\\n")
    expect(rendered).not.toContain('{"command"')
  })

  test("labels a streaming edit with its file path, never the tool name", () => {
    const block = streamingBlock("edit", '{"path":"src/tools/edit.ts","old_str":"const x')
    const rendered = text(model([block]))

    expect(rendered).toContain("Editing src/tools/edit.ts")
    expect(rendered).not.toContain("Editing edit")
    expect(rendered).not.toContain('{"path"')
  })

  test("labels a streaming write with its file path, never the tool name", () => {
    const block = streamingBlock("write", '{"path":"src/app.ts","content":"export const a')
    const rendered = text(model([block]))

    expect(rendered).toContain("Creating src/app.ts")
    expect(rendered).not.toContain("Creating write")
    expect(rendered).not.toContain('{"content"')
  })

  test("settles a streamed edit into its completed presentation", () => {
    const streaming = streamingBlock("edit", '{"path":"src/app.ts","old_str":"a","new_str":"b')
    const settled = streamingBlock("edit", '{"path":"src/app.ts","old_str":"a","new_str":"b"}')

    expect(text(model([streaming]))).toContain("Editing src/app.ts")
    expect(text(model([{ ...settled, status: "complete" }]))).toContain("Edited src/app.ts")
  })

  test("toolDetail never surfaces raw JSON or the tool name while streaming", () => {
    expect(toolDetail(0, streamingBlock("bash", '{"command":"mkdir -p src')).label).toBe("$ mkdir -p src")
    expect(toolDetail(0, streamingBlock("bash", '{"comm')).label).toBe("$")
    expect(toolDetail(0, streamingBlock("edit", '{"path":"src/app.ts","old_str":"a')).label).toBe("Edit src/app.ts")
    expect(toolDetail(0, streamingBlock("edit", '{"old_str":"a')).label).toBe("Edit")
  })

  test("shows only the running label before a shell command value begins streaming", () => {
    const rendered = text(model([streamingBlock("bash", '{"command":')]))

    expect(rendered).not.toContain('{"command"')
    expect(rendered).not.toContain("{")
  })

  test("shows the active edit label with no tool-name argument before a path streams", () => {
    const rendered = text(model([streamingBlock("edit", '{"old_str":"a')]))

    expect(rendered).toContain("Editing")
    expect(rendered).not.toContain("Editing edit")
    expect(rendered).not.toContain("{")

    const creating = text(model([streamingBlock("write", '{"content":"export')]))
    expect(creating).toContain("Creating")
    expect(creating).not.toContain("Creating write")
    expect(creating).not.toContain("{")
  })
})
