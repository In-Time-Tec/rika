import { expect, test, vi } from "vitest"

import { it } from "@effect/vitest"

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

import { buildTranscript, create } from "../../src/adapter"

import { initial, ready } from "../../src/view-state"

const handlers = () => ({ key: vi.fn(), resize: vi.fn() })

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

const createScoped = (callbacks: Parameters<typeof create>[0]) =>
  Effect.acquireRelease(create(callbacks), (created) => Effect.sync(created.releaseTerminal))

test("keeps wrapped response continuations inside the rail and curls the final row", () => {
  const state = model({
    width: 60,
    entries: [
      {
        role: "assistant",
        text: "1. Splitting the resident endpoint into separate host and client transports removes the restart complexity.",
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
  const first = lines.findIndex((line) => line.includes("Splitting"))
  const continuation = lines.findIndex((line) => line.includes("complexity"))
  expect(first).toBeGreaterThan(-1)
  expect(continuation).toBeGreaterThan(first)
  const responseRows = lines.slice(first, continuation + 1)
  expect(responseRows.length).toBeGreaterThan(1)
  for (const row of responseRows.slice(0, -1)) expect(row.startsWith("  │   ")).toBe(true)
  expect(responseRows[responseRows.length - 1]!.startsWith("  ╰   ")).toBe(true)
  for (const row of responseRows) expect(row.length).toBeLessThanOrEqual(60)
})

test("expands a failed subagent to its prompt and stored error text", () => {
  const lines = nonEmptyLines(
    renderedText({
      blocks: [
        {
          ...subagentToolBlock,
          status: "failed",
          detail: "Inspect the projection",
          output: "AgentToolError: Model gpt-5.6-luna is not available",
        },
      ],
      expandedRowKeys: ["tool:agent"],
    }),
  )
  expect(lines.some((line) => line.includes("Inspect the projection"))).toBe(true)
  expect(lines.some((line) => line.includes("AgentToolError: Model gpt-5.6-luna is not available"))).toBe(true)
  expect(lines.filter((line) => line.includes("AgentToolError: Model gpt-5.6-luna is not available"))).toHaveLength(1)
})

test("renders a finished subagent response as markdown inside the expanded unit", () => {
  const state = model({
    entries: [{ role: "assistant", text: "**Child result**\n\n**Checks passed.**", turnId: "child" }],
    blocks: [
      {
        _tag: "ToolCall",
        id: "oracle",
        name: "oracle",
        input: JSON.stringify({ prompt: "Review the code" }),
        status: "complete",
        presentation: {
          family: "agent",
          action: "oracle",
          activeLabel: "Oracle exploring",
          completeLabel: "Oracle has spoken",
        },
        detail: "Review the code",
        files: [],
      },
    ],
    items: [
      { _tag: "Block", index: 0, id: "tool:oracle", turnId: "turn" },
      { _tag: "Entry", index: 0, id: "assistant:child:0", turnId: "child", parentId: "oracle" },
    ],
    expandedRowKeys: ["tool:oracle"],
  })

  const text = buildTranscript(state)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")

  expect(text).toContain("Oracle has spoken ▾")
  expect(text).toContain("Review the code")
  expect(text).toContain("Child result")
  expect(text).toContain("Checks passed.")
  expect(text).not.toContain("**")
})

test("never renders a serialized child result as subagent output", () => {
  const serialized =
    '{"status":"completed","output":[{"type":"text","text":"## Child result\\n\\n**Checks passed.**"}]}'
  const state = model({
    blocks: [
      {
        _tag: "ToolCall",
        id: "task",
        name: "task",
        input: "{}",
        output: serialized,
        status: "complete",
        presentation: {
          family: "agent",
          action: "task",
          activeLabel: "Subagent working",
          completeLabel: "Subagent finished",
        },
        detail: "",
        files: [],
      },
    ],
    expandedRowKeys: ["tool:task"],
  })
  const text = buildTranscript(state)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")

  expect(text).toContain("Subagent finished")
  expect(text).not.toContain("\\n")
  expect(text).not.toContain('"}]}')
  expect(text).not.toContain(serialized)
})

test("presents successful and failed shell commands with expandable output", () => {
  const command = (status: "complete" | "failed", output: string) =>
    buildTranscript(
      model({
        blocks: [
          {
            _tag: "ToolCall",
            id: "git-status",
            name: "bash",
            input: '{"command":"git --no-optional-locks status --short --branch"}',
            output,
            status,
            presentation: { family: "shell", action: "command", activeLabel: "Running", completeLabel: "Ran" },
            detail: "git --no-optional-locks status --short --branch",
            files: [],
          },
        ],
        expandedRowKeys: ["tool:git-status"],
      }),
    )
      .styled.chunks.map((chunk) => chunk.text)
      .join("")
  const successful = command("complete", "## inspection\nM  staged.ts")
  const failed = command("failed", "fatal: not a git repository")
  expect(successful).toContain("$ git --no-optional-locks status --short --branch")
  expect(successful).toContain("## inspection")
  expect(failed).toContain("fatal: not a git repository")
})

test("uses the child profile activity label with a Subagent fallback", () => {
  const rendered = buildTranscript(
    model({
      blocks: [
        { _tag: "ChildAgent", id: "oracle", name: "oracle", summary: "", status: "running", activity: [] },
        { _tag: "ChildAgent", id: "task", name: "task", summary: "", status: "running", activity: [] },
      ],
    }),
  )
  const text = rendered.styled.chunks.map((chunk) => chunk.text).join("")

  expect(text).toContain("Oracle exploring")
  expect(text).toContain("Subagent working")
  expect(text).not.toContain("Task working")
})

it.effect("constructs the render tree and forwards key and resize events", () =>
  Effect.gen(function* () {
    const callbacks = handlers()
    const { surface } = yield* createScoped(callbacks)

    expect(opentui.rootChildren.length).toBeGreaterThanOrEqual(6)
    expect(opentui.rootChildren.slice(-6)).toEqual([
      surface.main,
      surface.modeLabel,
      surface.statusLabel,
      surface.workspaceLabel,
      surface.paletteBox,
      surface.toastBox,
    ])
    expect(opentui.boxChildren).toContain(surface.input)
    expect(opentui.boxChildren).toContain(surface.palette)
    expect(opentui.boxChildren).toContain(surface.changedFilesText)
    expect(opentui.boxChildren).toContain(surface.contentColumn)
    expect(opentui.boxChildren).toContain(surface.inputBox)
    expect(surface.changedFilesBox).toBeInstanceOf(opentui.ScrollBoxRenderable)

    for (const listener of opentui.keyHandlers)
      listener({ name: "o", ctrl: true, option: true, super: false, shift: true, sequence: "o", eventType: "repeat" })
    for (const listener of opentui.resizeHandlers) listener(101, 37)

    expect(callbacks.key).toHaveBeenLastCalledWith({
      name: "o",
      ctrl: true,
      alt: true,
      meta: false,
      shift: true,
      sequence: "o",
      eventType: "repeat",
    })
    expect(callbacks.resize).toHaveBeenLastCalledWith(101, 37)
  }),
)

it.effect("registers no SIGWINCH handler and relies on OpenTUI's debounced resize", () =>
  Effect.gen(function* () {
    const before = process.listenerCount("SIGWINCH")
    const callbacks = handlers()
    const { surface: _surface } = yield* createScoped(callbacks)
    expect(process.listenerCount("SIGWINCH")).toBe(before)
    opentui.renderer.resize.mockClear()
    const stdout = opentui.renderer.stdout as { columns?: number; rows?: number }
    for (const [columns, rows] of [
      [100, 40],
      [90, 30],
      [140, 45],
    ] as const) {
      stdout.columns = columns
      stdout.rows = rows
      process.emit("SIGWINCH", "SIGWINCH")
    }
    expect(opentui.renderer.resize).not.toHaveBeenCalled()
    for (const listener of opentui.resizeHandlers) listener(140, 45)
    expect(callbacks.resize).toHaveBeenLastCalledWith(140, 45)
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        const stdout = opentui.renderer.stdout as { columns?: number; rows?: number }
        delete stdout.columns
        delete stdout.rows
        opentui.renderer.terminalWidth = 80
        opentui.renderer.terminalHeight = 24
      }),
    ),
  ),
)

it.effect("uses the terminal's native blinking block cursor on the composer", () =>
  Effect.gen(function* () {
    const callbacks = { key: vi.fn(), paste: vi.fn(), resize: vi.fn() }
    const { surface } = yield* createScoped(callbacks)
    surface.update(model({ input: "draft", cursor: 5 }))

    expect(surface.composerEditor.cursorStyle).toEqual({ style: "block", blinking: true })
    expect(surface.composerEditor.showCursor).toBe(true)
  }),
)

it.effect("routes image paste, text paste, and non-empty selections through their dedicated callbacks", () =>
  Effect.gen(function* () {
    const callbacks = { key: vi.fn(), paste: vi.fn(), pasteImage: vi.fn(), resize: vi.fn() }
    yield* createScoped(callbacks)

    for (const listener of opentui.keyHandlers) {
      listener({
        name: "v",
        ctrl: true,
        option: false,
        super: false,
        shift: false,
        sequence: "v",
        eventType: "press",
      })
      listener({
        name: "x",
        ctrl: false,
        option: false,
        super: false,
        shift: false,
        sequence: "x",
        eventType: "press",
      })
    }
    for (const listener of opentui.pasteHandlers) {
      listener({ bytes: new TextEncoder().encode("pasted text") })
      listener({ bytes: Uint8Array.from([1, 2, 3]), metadata: { kind: "binary", mimeType: "image/png" } })
      listener({ bytes: new Uint8Array() })
    }
    for (const listener of opentui.selectionHandlers) {
      listener({ getSelectedText: () => "selected text\n" })
      listener({ getSelectedText: () => "  " })
    }

    expect(callbacks.pasteImage).toHaveBeenCalledTimes(2)
    expect(callbacks.pasteImage).toHaveBeenLastCalledWith({
      bytes: Uint8Array.from([1, 2, 3]),
      mediaType: "image/png",
    })
    expect(callbacks.key).toHaveBeenCalledOnce()
    expect(callbacks.paste).toHaveBeenCalledOnce()
    expect(callbacks.paste).toHaveBeenCalledWith("pasted text")
    expect(opentui.renderer.copyToClipboardOSC52).toHaveBeenCalledWith("selected text")
  }),
)

it.effect("never decodes binary paste as text without an image handler", () =>
  Effect.gen(function* () {
    const callbacks = { key: vi.fn(), paste: vi.fn(), resize: vi.fn() }
    yield* createScoped(callbacks)

    for (const listener of opentui.pasteHandlers)
      listener({ bytes: Uint8Array.from([0xff, 0xfe]), metadata: { kind: "binary" } })

    expect(callbacks.paste).not.toHaveBeenCalled()
  }),
)

it.effect("opens a clicked changed file through the host callback", () =>
  Effect.gen(function* () {
    const callbacks = { ...handlers(), openPath: vi.fn() }
    const { surface } = yield* createScoped(callbacks)
    surface.update(
      model({
        changedFilesOpen: true,
        changedFiles: ready([{ path: "apps/rika/src/main.ts", status: "M", added: 2, removed: 1 }]),
      }),
    )
    const text = surface.changedFilesText as unknown as {
      screenY: number
      onMouseDown: (event: { button: number; y: number; stopPropagation: () => void }) => void
    }
    text.screenY = 0
    text.onMouseDown({ button: 0, y: 3, stopPropagation: vi.fn() })

    expect(callbacks.openPath).toHaveBeenCalledWith({ path: "apps/rika/src/main.ts" })
  }),
)

it.effect("expands an existing collapsed attachment when the same text is pasted twice quickly", () =>
  Effect.gen(function* () {
    const callbacks = { ...handlers(), paste: vi.fn(), expandPaste: vi.fn() }
    const { surface } = yield* createScoped(callbacks)
    const token = String.fromCharCode(0xe000)
    surface.update(
      model({
        input: token,
        cursor: 1,
        pastedText: [{ type: "text", token, value: "line one\nline two", label: "[Pasted text #1 +2 lines]" }],
      }),
    )

    for (const listener of opentui.pasteHandlers) {
      listener({ bytes: new TextEncoder().encode("line one\nline two") })
      listener({ bytes: new TextEncoder().encode("line one\nline two") })
    }

    expect(callbacks.paste).toHaveBeenCalledOnce()
    expect(callbacks.expandPaste).toHaveBeenCalledWith(token)
  }),
)

it.effect("resizes the composer by dragging its top border", () =>
  Effect.gen(function* () {
    const callbacks = { ...handlers(), composerResize: vi.fn() }
    const { surface } = yield* createScoped(callbacks)
    surface.update(model())
    const inputBox = surface.inputBox as unknown as {
      y: number
      height: number
      onMouseDown: (event: object) => void
      onMouseOver: (event: object) => void
      onMouseMove: (event: object) => void
      onMouseOut: () => void
    }
    const root = opentui.renderer.root as unknown as {
      onMouseDrag: (event: object) => void
      onMouseUp: (event: object) => void
    }
    inputBox.y = 19
    const event = (y: number) => ({ button: 0, y, preventDefault: vi.fn(), stopPropagation: vi.fn() })

    inputBox.onMouseDown(event(19))
    root.onMouseDrag(event(15))
    expect(callbacks.composerResize).toHaveBeenLastCalledWith(9)
    root.onMouseUp(event(15))
    root.onMouseDrag(event(12))
    expect(callbacks.composerResize).toHaveBeenCalledOnce()

    opentui.renderer.realStdoutWrite.mockClear()
    inputBox.onMouseOver(event(19))
    expect(opentui.renderer.realStdoutWrite).toHaveBeenLastCalledWith("\u001b]22;ns-resize\u001b\\")
    inputBox.onMouseMove(event(20))
    expect(opentui.renderer.realStdoutWrite).toHaveBeenLastCalledWith("\u001b]22;default\u001b\\")
    inputBox.onMouseMove(event(19))
    inputBox.onMouseOut()
    expect(opentui.renderer.realStdoutWrite).toHaveBeenLastCalledWith("\u001b]22;default\u001b\\")

    surface.update(model({ shortcutsOpen: true }))
    inputBox.onMouseDown(event(7))
    root.onMouseDrag(event(3))
    expect(callbacks.composerResize).toHaveBeenCalledOnce()
  }),
)
