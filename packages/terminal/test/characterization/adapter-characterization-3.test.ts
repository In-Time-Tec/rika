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

const _agentToolBlock = (
  status: "running" | "complete" | "failed" | "cancelled",
  detail = "Investigate the crash",
) => ({
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

import stringWidth from "string-width"

import { buildTranscript, create } from "../../src/adapter"

import { initial } from "../../src/view-state"

import { colors } from "../../src/theme"

const _handlers = () => ({ key: vi.fn(), resize: vi.fn() })

const nonEmptyLines = (text: string) => text.split("\n").filter((line) => line.length > 0)

const model = (changes: Partial<Model> = {}): Model => ({ ...initial("/workspace", "medium"), ...changes })

const _thread = (input: Partial<ThreadItem> & Pick<ThreadItem, "id" | "title">): ThreadItem => ({
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

  expect(text).toContain("⊘ Subagent cancelled ▾")
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
        output: "NESTED SEARCH RESULT BODY",
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
  expect(lines.every((line) => !line.startsWith("│"))).toBe(true)
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
  expect(lines.every((line) => !line.startsWith("│"))).toBe(true)
})

test("renders an expanded Edited diff without any added left rail", () => {
  const lines = nonEmptyLines(renderedText({ blocks: [editToolBlock], expandedRowKeys: ["tool:patch"] }))
  expect(lines[0]).toContain("Edited")
  expect(lines.length).toBeGreaterThan(1)
  expect(lines.slice(1).some((line) => line.includes("old") || line.includes("new"))).toBe(true)
  expect(lines.every((line) => !line.startsWith("│"))).toBe(true)
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
  expect(lines.every((line) => !line.startsWith("│"))).toBe(true)
})

test("keeps wrapped nested shell continuation connectors subtle", () => {
  const state = model({
    width: 60,
    blocks: [
      { ...subagentToolBlock, status: "running", detail: "Inspect the projection" },
      shell("child-a", `git status --short ${"packages/terminal ".repeat(8)}`, "clean"),
      {
        ...shell("child-b", `bun run check ${"packages/relay-execution ".repeat(8)}`, "cancelled"),
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
  expect(continuationConnectors.every((chunk) => chunk.fg === colors.subtle)).toBe(true)
})

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
  expect(lines.every((line) => !line.startsWith("│"))).toBe(true)
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
  const items = blocks.map((block, index) => ({
    _tag: "Block" as const,
    index,
    id: `tool:${block.id}`,
    turnId: index === 0 ? "turn" : `child:agent-${index - 1}`,
    ...(index === 0 ? {} : { parentId: `agent-${index - 1}` }),
  }))
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
  expect(lines.every((line) => !line.startsWith("│"))).toBe(true)
})
