import { expect, test, vi } from "vitest"
import { Effect } from "effect"
import stringWidth from "string-width"
import { buildTranscript, create, renderTranscriptStyled } from "../../src/opentui/surface/opentui-surface"
import { initial, type Model, type ThreadItem } from "../../src/state/model/terminal-state"
import { colors } from "../../src/presentation/terminal/terminal-theme"
const opentuiValue = vi.hoisted(() => {
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
const opentui = opentuiValue

vi.mock("@opentui/core", () => ({
  BoxRenderable: opentuiValue.BoxRenderable,
  EditBufferRenderable: opentuiValue.EditBufferRenderable,
  RGBA: opentuiValue.RGBA,
  ScrollBarRenderable: opentuiValue.ScrollBarRenderable,
  ScrollBoxRenderable: opentuiValue.ScrollBoxRenderable,
  SystemClock: opentuiValue.SystemClock,
  CliRenderEvents: { FRAME: "frame", RESIZE: "resize", SELECTION: "selection" },
  TextRenderable: opentuiValue.TextRenderable,
  createCliRenderer: opentuiValue.createCliRenderer,
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
import { shell, _windowUnitToolCall, _agentToolBlock, _handlers, nonEmptyLines, subagentToolBlock, editToolBlock, renderedText, model, _thread, _createScoped } from "./adapter-characterization-3.test-support"
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
  expect(continuationConnectors.every((chunk) => chunk.fg !== undefined)).toBe(true)
})
