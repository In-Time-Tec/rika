import { describe, expect, test } from "vitest"
import { buildTranscript } from "../src/adapter"
import { toolDetail, transcriptUnits } from "../src/transcript-units"
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
      call("read", "read_file", { path: "missing.ts" }, explore("read", "file"), {
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

  test("uses user-facing expanded labels for every exploration action", () => {
    const blocks = [
      call("read", "get_diagnostics", { path: "src/a.ts" }, explore("read", "file"), { detail: "src/a.ts" }),
      call("media", "view_media", { path: "image.png" }, explore("media", "media file"), {
        detail: "image.png",
      }),
      call("status", "git_status", {}, explore("git-status", "file"), { detail: "git status" }),
      call("grep", "ripgrep", { query: "needle" }, explore("grep", "search"), { detail: "needle" }),
      call("search", "glob", { glob: "**/*.ts" }, explore("search", "search"), { detail: "**/*.ts" }),
      call("skill", "skill", { name: "tool-authoring" }, explore("skill", "skill"), {
        detail: "tool-authoring",
      }),
    ]
    const rendered = text(model(blocks, ["tool:read"]))

    expect(rendered).toContain("Read src/a.ts")
    expect(rendered).toContain("Viewed image.png")
    expect(rendered).toContain("Checked git status")
    expect(rendered).toContain("Grep needle")
    expect(rendered).toContain("Searched **/*.ts")
    expect(rendered).toContain("tool-authoring")
    expect(rendered).not.toContain("Searched tool-authoring")
  })

  test("keeps source order while grouping only adjacent compatible families", () => {
    const blocks = [
      call("read", "read_file", { path: "a.ts" }, explore("read", "file")),
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
        "shell_command",
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
        "run_terminal_command",
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
      "shell_command",
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
})
