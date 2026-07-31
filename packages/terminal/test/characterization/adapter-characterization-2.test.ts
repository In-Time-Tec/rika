import { expect, test, vi } from "vitest"

import { Effect } from "effect"

const shell = (id: string, command: string, output: string) => ({
  _tag: "ToolCall" as const,
  id,
  name: "bash",
  input: JSON.stringify({ command }),
  output,
  status: "complete" as const,
  presentation: { family: "shell" as const, action: "command", activeLabel: "Running", completeLabel: "Ran" },
  detail: command,
  files: [],
})

const _windowUnitToolCall = (id: string, family: "agent" | "explore") => ({
  _tag: "ToolCall" as const,
  id,
  name: family === "agent" ? "task" : "read",
  input: "{}",
  status: "complete" as const,
  presentation: {
    family,
    action: family === "agent" ? "task" : "read",
    activeLabel: family === "agent" ? "Exploring" : "Reading",
    completeLabel: family === "agent" ? "Explored" : "Read",
  },
  detail: id,
  files: [],
})

const agentToolBlock = (status: "running" | "complete" | "failed" | "cancelled", detail = "Investigate the crash") => ({
  _tag: "ToolCall" as const,
  id: "agent",
  name: "task",
  input: "{}",
  status,
  presentation: {
    family: "agent" as const,
    action: "task",
    activeLabel: "Subagent working",
    completeLabel: "Subagent finished",
  },
  detail,
  files: [],
})

const opentui = vi.hoisted(() => {
  const boxChildren: Array<object> = []
  const keyHandlers = new Set<(key: object) => void>()
  const pasteHandlers = new Set<(event: object) => void>()
  const resizeHandlers = new Set<(width: number, height: number) => void>()
  const frameHandlers = new Set<() => void>()
  const selectionHandlers = new Set<(selection: object) => void>()
  const rootChildren: Array<object> = []
  const requestRender = vi.fn()
  const textRenderables: Array<TextRenderable> = []

  class TextRenderable {
    content = ""
    fg = ""
    visible = true

    constructor(
      readonly renderer: object,
      options: Record<string, unknown>,
    ) {
      Object.assign(this, options)
      textRenderables.push(this)
    }

    destroy() {}
  }

  class EditBufferRenderable extends TextRenderable {
    plainText = ""
    cursorOffset = 0
    focused = false
    showCursor = true
    declare cursorStyle: unknown

    setText(text: string) {
      this.plainText = text
    }

    focus() {
      this.focused = true
    }

    blur() {
      this.focused = false
    }
  }

  class BoxRenderable {
    borderColor = ""
    title = ""
    titleColor = ""
    bottomTitle = ""
    readonly children: Array<object> = []

    constructor(
      readonly renderer: object,
      options: Record<string, unknown>,
    ) {
      Object.assign(this, options)
    }

    add(child: object, index?: number) {
      boxChildren.push(child)
      const previous = this.children.indexOf(child)
      if (previous >= 0) this.children.splice(previous, 1)
      if (index === undefined || index >= this.children.length) this.children.push(child)
      else this.children.splice(index, 0, child)
    }

    remove(child: object) {
      const index = this.children.indexOf(child)
      if (index >= 0) this.children.splice(index, 1)
    }

    getChildren() {
      return [...this.children]
    }
  }

  class ScrollBoxRenderable extends BoxRenderable {
    scrollTop = 0
    scrollHeight = 24
    stickyScroll = true
    viewport = { height: 24 }
    content = new BoxRenderable(this.renderer, { minHeight: 0, justifyContent: "flex-end" })
    verticalScrollBar = { visible: true }

    scrollTo(offset: number) {
      this.scrollTop = offset
    }
  }

  class ScrollBarRenderable {
    scrollSize = 0
    scrollPosition = 0
    viewportSize = 0
    visible = true

    constructor(
      readonly renderer: object,
      options: Record<string, unknown>,
    ) {
      Object.assign(this, options)
    }

    destroy() {}
  }

  class RGBA {
    a = 0

    constructor(readonly token: string = "rgba") {}

    static defaultBackground() {
      return new RGBA("default-bg")
    }

    static defaultForeground() {
      return new RGBA("default-fg")
    }

    static fromIndex(index: number) {
      return new RGBA(`ansi-${index}`)
    }
  }

  class SystemClock {
    now() {
      return 0
    }

    setTimeout(_action: () => void, _delay: number) {
      return 0
    }

    clearTimeout(_handle: number) {}

    setInterval(_action: () => void, _delay: number) {
      return 0
    }

    clearInterval(_handle: number) {}
  }

  const renderer = {
    _usesProcessStdout: true,
    stdout: { write: vi.fn() },
    realStdoutWrite: vi.fn(),
    terminalWidth: 80,
    terminalHeight: 24,
    destroy: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
    setBackgroundColor: vi.fn(),
    root: {
      add: vi.fn((child: object) => {
        rootChildren.push(child)
      }),
    },
    keyInput: {
      on(event: string, handler: (key: object) => void) {
        ;(event === "paste" ? pasteHandlers : keyHandlers).add(handler)
      },
      off(event: string, handler: (key: object) => void) {
        ;(event === "paste" ? pasteHandlers : keyHandlers).delete(handler)
      },
    },
    on(event: string, handler: (width: number, height: number) => void) {
      if (event === "selection") selectionHandlers.add(handler as unknown as (selection: object) => void)
      else if (event === "frame") frameHandlers.add(handler as unknown as () => void)
      else resizeHandlers.add(handler)
    },
    once(event: string, handler: (width: number, height: number) => void) {
      const once = (...args: [number, number]) => {
        renderer.off(event, once)
        handler(...args)
      }
      renderer.on(event, once)
    },
    off(event: string, handler: (width: number, height: number) => void) {
      if (event === "selection") selectionHandlers.delete(handler as unknown as (selection: object) => void)
      else if (event === "frame") frameHandlers.delete(handler as unknown as () => void)
      else resizeHandlers.delete(handler)
    },
    requestRender,
    resize: vi.fn((width: number, height: number) => {
      renderer.terminalWidth = width
      renderer.terminalHeight = height
      for (const handler of resizeHandlers) handler(width, height)
    }),
    getSelection: () => null,
    copyToClipboardOSC52: vi.fn(),
    setMousePointer: vi.fn(),
  }

  return {
    BoxRenderable,
    EditBufferRenderable,
    RGBA,
    ScrollBarRenderable,
    ScrollBoxRenderable,
    SystemClock,
    TextRenderable,
    boxChildren,
    createCliRenderer: vi.fn(() => Effect.runPromise(Effect.succeed(renderer))),
    frameHandlers,
    keyHandlers,
    pasteHandlers,
    renderer,
    requestRender,
    resizeHandlers,
    selectionHandlers,
    textRenderables,
    rootChildren,
  }
})

vi.mock("@opentui/core", () => ({
  BoxRenderable: opentui.BoxRenderable,
  EditBufferRenderable: opentui.EditBufferRenderable,
  RGBA: opentui.RGBA,
  ScrollBarRenderable: opentui.ScrollBarRenderable,
  ScrollBoxRenderable: opentui.ScrollBoxRenderable,
  SystemClock: opentui.SystemClock,
  CliRenderEvents: { FRAME: "frame", RESIZE: "resize", SELECTION: "selection" },
  TextRenderable: opentui.TextRenderable,
  createCliRenderer: opentui.createCliRenderer,
  decodePasteBytes: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  fg: (color: string) => (input: string | { text: string }) =>
    typeof input === "string" ? { text: input, fg: color } : { ...input, fg: color },
  bg: (_color: string) => (chunk: { text: string }) => chunk,
  bold: (chunk: { text: string }) => chunk,
  italic: (chunk: { text: string }) => chunk,
  dim: (chunk: { text: string }) => ({ ...chunk, attributes: 2 }),
  underline: (chunk: { text: string }) => chunk,
  strikethrough: (chunk: { text: string }) => chunk,
  link: () => (chunk: { text: string }) => chunk,
  StyledText: class StyledText {
    constructor(readonly chunks: ReadonlyArray<{ text: string }>) {}
  },
  stripAnsiSequences: (text: string) => text,
}))

import { buildTranscript, create, renderBlock, renderSidebar, renderTranscriptStyled } from "../../src/adapter"

import { initial } from "../../src/view-state"

import { colors } from "../../src/theme"

const _handlers = () => ({ key: vi.fn(), resize: vi.fn() })

const _nonEmptyLines = (text: string) => text.split("\n").filter((line) => line.length > 0)

const model = (changes: Partial<Model> = {}): Model => ({ ...initial("/workspace", "medium"), ...changes })

const thread = (input: Partial<ThreadItem> & Pick<ThreadItem, "id" | "title">): ThreadItem => ({
  workspace: "/workspace",
  pinned: false,
  archived: false,
  status: "idle",
  unread: false,
  lastActivityAt: 0,
  ...input,
})

const _createScoped = (callbacks: Parameters<typeof create>[0]) =>
  Effect.acquireRelease(create(callbacks), (created) => Effect.sync(created.releaseTerminal))

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
      recovery: "Press Enter to retry.",
    },
    { _tag: "ChildAgent", id: "child", name: "child", summary: "work", status: "running", activity: [] },
    { _tag: "Workflow", name: "flow", step: "wait", status: "waiting" },
    { _tag: "ImageAttachment", name: "a.png", mediaType: "image/png" },
    { _tag: "ImageAttachment", name: "partial.png", mediaType: "image/png", width: 2 },
    { _tag: "ImageAttachment", name: "b.png", mediaType: "image/png", width: 2, height: 3, bytes: 4 },
  ] as const
  const renderedBlocks = blocks.map((block) => renderBlock(block)).join("\n")
  expect(renderedBlocks).toContain("✕ Result")
  expect(renderedBlocks).toContain("↻ Auto-compacting context…")
  expect(renderedBlocks).toContain("✓ Auto-compacted context at 42\n  Kept recent turns")
  expect(renderedBlocks).toContain("✓ Auto-compacted context\n  No checkpoint")
  expect(renderedBlocks).toContain(
    "✖ ERROR: Execution failed · Turn turn-4\n  Model unavailable\n  Next: Press Enter to retry.",
  )
  expect(renderedBlocks).toContain("2×3 · 4 B")
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
        output: "done",
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
        output: "src/a.ts:1:needle",
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
        output: "child result",
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
  expect(text).toContain("Waited for bun test ▸")
  expect(text).toContain('✕ Grep src "needle" src/a.ts:1:needle')
  expect(text).toContain("Subagent finished ▾")
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
        output: "child result",
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
        output: "failed output",
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
    blocks: [agentToolBlock("failed")],
    items: [{ _tag: "Block", index: 0, id: "tool:agent" }],
    childExecutionOutcomes: { agent: { status: "failed", reason: "network exploded" } },
    expandedRowKeys: ["tool:agent"],
  })
  const built = buildTranscript(state)
  const chunk = built.styled.chunks.find((current) => current.text.includes("network exploded")) as
    | { readonly text: string; readonly fg?: string }
    | undefined
  expect(chunk).toBeDefined()
  expect(chunk?.fg).toBe(colors.red)
})

test("tones a cancelled subagent amber and an empty completed subagent dim", () => {
  const cancelled = model({
    blocks: [agentToolBlock("cancelled")],
    items: [{ _tag: "Block", index: 0, id: "tool:agent" }],
    childExecutionOutcomes: { agent: { status: "cancelled", reason: "user stopped the run" } },
    expandedRowKeys: ["tool:agent"],
  })
  const cancelledChunk = buildTranscript(cancelled).styled.chunks.find((current) =>
    current.text.includes("user stopped the run"),
  ) as { readonly text: string; readonly fg?: string } | undefined
  expect(cancelledChunk?.fg).toBe(colors.amber)

  const completed = model({
    blocks: [agentToolBlock("complete")],
    items: [{ _tag: "Block", index: 0, id: "tool:agent" }],
    expandedRowKeys: ["tool:agent"],
  })
  const built = buildTranscript(completed)
  const infoChunk = built.styled.chunks.find((current) => current.text.includes("finished without a final message")) as
    | { readonly text: string; readonly fg?: string }
    | undefined
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
    blocks: [agentToolBlock("complete")],
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

test("renders a completed subagent's tool-result fallback as markdown", () => {
  const state = model({
    blocks: [
      {
        ...agentToolBlock("complete"),
        output: JSON.stringify({ output: [{ type: "text", text: "## Review complete\n\n**No defects found.**" }] }),
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
