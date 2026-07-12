import { describe, expect, test, vi } from "vitest"

const opentui = vi.hoisted(() => {
  const boxChildren: Array<object> = []
  const keyHandlers = new Set<(key: object) => void>()
  const pasteHandlers = new Set<(event: object) => void>()
  const resizeHandlers = new Set<(width: number, height: number) => void>()
  const selectionHandlers = new Set<(selection: object) => void>()
  const rootChildren: Array<object> = []
  const requestRender = vi.fn()

  class TextRenderable {
    content = ""
    fg = ""
    visible = true

    constructor(
      readonly renderer: object,
      options: Record<string, unknown>,
    ) {
      Object.assign(this, options)
    }

    destroy() {}
  }

  class BoxRenderable {
    borderColor = ""
    title = ""
    titleColor = ""
    bottomTitle = ""

    constructor(
      readonly renderer: object,
      options: Record<string, unknown>,
    ) {
      Object.assign(this, options)
    }

    add(child: object) {
      boxChildren.push(child)
    }

    remove() {}
  }

  class ScrollBoxRenderable extends BoxRenderable {
    scrollTop = 0
    scrollHeight = 24
    stickyScroll = true
    viewport = { height: 24 }
    content = { minHeight: 0, justifyContent: "flex-end" }
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

  const renderer = {
    stdout: { write: vi.fn() },
    realStdoutWrite: vi.fn(),
    root: {
      add(child: object) {
        rootChildren.push(child)
      },
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
      else resizeHandlers.add(handler)
    },
    off(event: string, handler: (width: number, height: number) => void) {
      if (event === "selection") selectionHandlers.delete(handler as unknown as (selection: object) => void)
      else resizeHandlers.delete(handler)
    },
    requestRender,
    copyToClipboardOSC52: vi.fn(),
    setMousePointer: vi.fn(),
  }

  return {
    BoxRenderable,
    RGBA,
    ScrollBarRenderable,
    ScrollBoxRenderable,
    TextRenderable,
    boxChildren,
    createCliRenderer: vi.fn(async () => renderer),
    keyHandlers,
    pasteHandlers,
    renderer,
    requestRender,
    resizeHandlers,
    selectionHandlers,
    rootChildren,
  }
})

vi.mock("@opentui/core", () => ({
  BoxRenderable: opentui.BoxRenderable,
  RGBA: opentui.RGBA,
  ScrollBarRenderable: opentui.ScrollBarRenderable,
  ScrollBoxRenderable: opentui.ScrollBoxRenderable,
  CliRenderEvents: { RESIZE: "resize", SELECTION: "selection" },
  TextRenderable: opentui.TextRenderable,
  createCliRenderer: opentui.createCliRenderer,
  decodePasteBytes: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  fg: (color: string) => (text: string) => ({ text, fg: color }),
  bg: (_color: string) => (chunk: { text: string }) => chunk,
  bold: (chunk: { text: string }) => chunk,
  italic: (chunk: { text: string }) => chunk,
  dim: (chunk: { text: string }) => chunk,
  underline: (chunk: { text: string }) => chunk,
  strikethrough: (chunk: { text: string }) => chunk,
  link: () => (chunk: { text: string }) => chunk,
  StyledText: class StyledText {
    constructor(readonly chunks: ReadonlyArray<{ text: string }>) {}
  },
  stripAnsiSequences: (text: string) => text,
}))

import {
  Surface,
  create,
  renderBlock,
  renderChangedFiles,
  renderSidebar,
  renderTranscript,
  renderTranscriptStyled,
} from "../src/adapter"
import { defaultReasoningEffort, initial, ready, type Mode, type Model } from "../src/view-state"

const handlers = () => ({ key: vi.fn(), resize: vi.fn() })

const model = (changes: Partial<Model> = {}): Model => ({ ...initial("/workspace", "medium"), ...changes })

test("renders changed files as an indented path tree", () => {
  const rendered = renderChangedFiles(
    model({
      changedFiles: ready([
        { path: "apps/rika/src/main.ts", status: "M", added: 3, removed: 1 },
        { path: "apps/rika/test/main.test.ts", status: "A", added: 8, removed: 0 },
        { path: "README.md", status: "M" },
      ]),
    }),
    29,
  )
    .chunks.map(({ text }) => text)
    .join("")

  expect(rendered).toBe(
    "apps/\n  rika/\n    src/\n      main.ts +3 -1\n    test/\n      main.test.ts +8 -0\nREADME.md +0 -0",
  )
  expect(
    renderChangedFiles(model({ changedFiles: ready([{ path: "src/main.ts", status: "M", added: 3, removed: 1 }]) }), 28)
      .chunks,
  ).toEqual([
    { text: "src/", fg: opentui.RGBA.fromIndex(8) },
    { text: "\n", fg: opentui.RGBA.defaultForeground() },
    { text: "  ", fg: opentui.RGBA.defaultForeground() },
    { text: "main.ts", fg: opentui.RGBA.fromIndex(3) },
    { text: " +3", fg: opentui.RGBA.fromIndex(2) },
    { text: " -1", fg: opentui.RGBA.fromIndex(1) },
  ])
})

describe("Surface", () => {
  test("renders every transcript block variant and sidebar state", () => {
    const blocks = [
      { _tag: "Reasoning", text: "why", expanded: false },
      { _tag: "Reasoning", text: "why", expanded: true },
      { _tag: "ToolCall", id: "1", name: "Read", input: "a", status: "running" },
      { _tag: "ToolCall", id: "2", name: "Write", input: "b", status: "complete" },
      { _tag: "ToolResult", id: "1", output: "ok", failed: false },
      { _tag: "ToolResult", id: "2", output: "bad", failed: true },
      { _tag: "Diff", path: "a", patch: "+x" },
      { _tag: "ContextUsage", text: "80%", cost: "$0.12" },
      { _tag: "ContextUsage", text: "unknown" },
      { _tag: "Compaction", summary: "Kept recent turns", checkpoint: "42" },
      { _tag: "Compaction", summary: "No checkpoint" },
      { _tag: "Notification", title: "Complete", detail: "Review finished" },
      {
        _tag: "Error",
        title: "Execution failed",
        detail: "Model unavailable",
        turnId: "turn-4",
        recovery: "Press Enter to retry.",
      },
      { _tag: "Permission", id: "p", kind: "tool-approval", title: "Write", detail: "a", status: "pending" },
      { _tag: "ChildAgent", name: "child", summary: "work", status: "running" },
      { _tag: "Workflow", name: "flow", step: "wait", status: "waiting" },
      { _tag: "ImageAttachment", name: "a.png", mediaType: "image/png" },
      { _tag: "ImageAttachment", name: "partial.png", mediaType: "image/png", width: 2 },
      { _tag: "ImageAttachment", name: "b.png", mediaType: "image/png", width: 2, height: 3, bytes: 4 },
    ] as const
    expect(blocks.map(renderBlock).join("\n")).toContain("✕ Result")
    expect(blocks.map(renderBlock).join("\n")).toContain(
      "✖ ERROR: Execution failed · Turn turn-4\n  Model unavailable\n  Next: Press Enter to retry.",
    )
    expect(blocks.map(renderBlock).join("\n")).toContain("2×3 · 4 bytes")
    const state = model({
      blocks: [...blocks],
      threads: [
        { id: "a", title: "One", active: true, unread: true },
        { id: "b", title: "Two", active: false, unread: false },
      ],
    })
    expect(renderTranscript(state)).toContain("Reasoning")
    const styledTranscript = renderTranscriptStyled(state)
      .chunks.map((chunk) => chunk.text)
      .join("")
    expect(styledTranscript).toContain("Allow once")
    expect(styledTranscript).toContain("Always")
    expect(styledTranscript).toContain("Deny")
    expect(renderSidebar(state)).toContain("› ● One")
    expect(renderSidebar(state)).toContain("    Two")
  })

  test("keeps tool cards generic without removed activity assumptions", () => {
    const rendered = renderBlock({
      _tag: "ToolCall",
      id: "custom-1",
      name: "Plugin-defined tool",
      input: "opaque input",
      status: "running",
    })

    expect(rendered).toBe("⠿ Plugin-defined tool [running] ▸")
    expect(rendered).not.toMatch(/rivet|semantic[- ]search|ast[- ]grep[- ]outline/i)
  })

  test("constructs the render tree and forwards key and resize events", async () => {
    const callbacks = handlers()
    const { renderer } = await create(callbacks)

    expect(opentui.rootChildren).toHaveLength(6)
    const surface = new Surface(renderer, callbacks)
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
  })

  test("routes image paste, text paste, and non-empty selections through their dedicated callbacks", async () => {
    const callbacks = { key: vi.fn(), paste: vi.fn(), pasteImage: vi.fn(), resize: vi.fn() }
    await create(callbacks)

    for (const listener of opentui.keyHandlers) {
      listener({ name: "v", ctrl: true, option: false, super: false, shift: false, sequence: "v", eventType: "press" })
      listener({ name: "x", ctrl: false, option: false, super: false, shift: false, sequence: "x", eventType: "press" })
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
  })

  test("never decodes binary paste as text without an image handler", async () => {
    const callbacks = { key: vi.fn(), paste: vi.fn(), resize: vi.fn() }
    await create(callbacks)

    for (const listener of opentui.pasteHandlers)
      listener({ bytes: Uint8Array.from([0xff, 0xfe]), metadata: { kind: "binary" } })

    expect(callbacks.paste).not.toHaveBeenCalled()
  })

  test("opens a clicked changed file through the host callback", async () => {
    const callbacks = { ...handlers(), openPath: vi.fn() }
    const { surface } = await create(callbacks)
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
  })

  test("expands an existing collapsed attachment when the same text is pasted twice quickly", async () => {
    const callbacks = { ...handlers(), paste: vi.fn(), expandPaste: vi.fn() }
    const { surface } = await create(callbacks)
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
  })

  test("resizes the composer by dragging its top border", async () => {
    const callbacks = { ...handlers(), composerResize: vi.fn() }
    const { surface } = await create(callbacks)
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
  })

  test("renders welcome, entries, modes, activity, cursor, and palette", async () => {
    const callbacks = handlers()
    const { surface } = await create(callbacks)

    const inputText = () =>
      (surface.input.content as { chunks: ReadonlyArray<{ text: string }> }).chunks.map(({ text }) => text).join("")

    const modeLabelText = () =>
      (surface.modeLabel.content as { chunks: ReadonlyArray<{ text: string }> }).chunks.map(({ text }) => text).join("")

    surface.update(model({ input: "abcd", cursor: 2 }))
    expect(surface.transcriptContent).toBeInstanceOf(Object)
    expect(inputText()).toBe("abcd")
    expect(surface.inputBox.title).toBe("")
    expect(modeLabelText()).toBe(" medium ")
    expect(surface.inputBox.borderColor).toEqual(opentui.RGBA.defaultForeground())
    expect(surface.inputBox.bottomTitle).toBe("")
    expect(surface.workspaceLabel.content).toEqual(
      expect.objectContaining({ chunks: [expect.objectContaining({ text: " /workspace " })] }),
    )
    expect(surface.palette.visible).toBe(false)

    surface.update(model({ width: 40, input: "one\ntwo\nthree", cursor: 13 }))
    expect(surface.inputBox.height).toBe(5)
    expect(inputText()).toBe("one\ntwo\nthree ")
    expect(surface.inputBox.bottomTitle).toBe("")

    surface.update(model({ input: "one\ntwo\nthree\nfour", cursor: 18 }))
    expect(surface.inputBox.height).toBe(6)
    expect(inputText()).toBe("one\ntwo\nthree\nfour ")

    surface.update(
      model({
        input: `a${String.fromCharCode(0xe000)}b`,
        cursor: 2,
        pastedText: [
          {
            type: "text",
            token: String.fromCharCode(0xe000),
            value: "many\nlines",
            label: "[Pasted text #1 +2 lines]",
          },
        ],
      }),
    )
    expect(inputText()).toBe("a[Pasted text #1 +2 lines]b")

    const modeColors: ReadonlyArray<readonly [Mode, string]> = [
      ["low", "#d2a25c"],
      ["medium", "#58a6ff"],
      ["high", "#3fb950"],
      ["ultra", "#ae77ff"],
    ]
    for (const [mode] of modeColors) {
      surface.update(model({ mode, busy: true, reasoningEffort: defaultReasoningEffort(mode) }))
      expect(surface.inputBox.title).toBe("")
      expect(modeLabelText()).toBe(` $···· ─ ${mode} `)
      expect(surface.inputBox.borderColor).toEqual(opentui.RGBA.defaultForeground())
      expect(surface.statusLabel.content).toEqual(
        expect.objectContaining({
          chunks: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(" Waiting ") })]),
        }),
      )
    }
    surface.update(model({ mode: "medium", busy: false, costUsd: 0.0074 }))
    expect(modeLabelText()).toBe(" $0.007 ─ medium ")
    surface.update(model({ mode: "medium", busy: false, costUsd: 5.4449 }))
    expect(modeLabelText()).toBe(" $5.44 ─ medium ")
    surface.update(model({ mode: "medium", busy: false, costUsd: 5.4449, fastMode: true }))
    expect(modeLabelText()).toBe(" $5.44 ─ ↯medium ")

    surface.update(
      model({
        entries: [
          { role: "user", text: "question" },
          { role: "assistant", text: "answer" },
          { role: "notice", text: "problem" },
        ],
        paletteOpen: true,
      }),
    )
    expect(surface.transcriptContent).toBeInstanceOf(Object)
    expect(
      renderTranscriptStyled(
        model({
          entries: [
            { role: "user", text: "question" },
            { role: "assistant", text: "answer" },
            { role: "notice", text: "problem" },
          ],
        }),
      )
        .chunks.map(({ text }) => text)
        .join("")
        .replace(/^\n+/, ""),
    ).toBe("┃ question\n\nanswer\n\n! problem")
    expect(surface.palette.visible).toBe(true)
    expect(surface.paletteBox.visible).toBe(true)
    expect(surface.paletteBox.title).toBe(" Command Palette ")
    const paletteText = (surface.palette.content as { chunks: ReadonlyArray<{ text: string }> }).chunks
      .map(({ text }) => text)
      .join("")
    expect(paletteText).toContain("thread")
    expect(paletteText).toContain("run prompt")
    expect(opentui.requestRender.mock.calls.length).toBeGreaterThanOrEqual(7)
  })

  test("removes its listeners on destroy", async () => {
    const callbacks = handlers()
    const { surface } = await create(callbacks)
    const keyCount = opentui.keyHandlers.size
    const pasteCount = opentui.pasteHandlers.size
    const resizeCount = opentui.resizeHandlers.size
    const selectionCount = opentui.selectionHandlers.size

    surface.destroy()

    expect(opentui.keyHandlers.size).toBe(keyCount - 1)
    expect(opentui.pasteHandlers.size).toBe(pasteCount - 1)
    expect(opentui.resizeHandlers.size).toBe(resizeCount - 1)
    expect(opentui.selectionHandlers.size).toBe(selectionCount - 1)
  })

  test("renders mode picker, filtered palette, sidebar visibility, and notice transitions", async () => {
    const { surface } = await create(handlers())
    const paletteText = () =>
      (surface.palette.content as { chunks: ReadonlyArray<{ text: string }> }).chunks.map(({ text }) => text).join("")
    surface.update(model({ modePicker: { open: true, selected: 2 } }))
    expect(paletteText()).toContain("high")
    expect(paletteText()).toContain("Deep reasoning for hard tasks")
    expect(surface.paletteBox.bottomTitle).toBe(" ←→ turn · esc")
    surface.update(model({ palette: { open: true, query: "quit", selected: 0 } }))
    expect(paletteText()).toContain("quit")
    surface.update(model({ threads: [{ id: "a", title: "A", active: true, unread: false }], sidebarOpen: false }))
    expect(surface.sidebar.visible).toBe(false)
    surface.update(model({ entries: [{ role: "assistant", text: "ok" }] }))
    expect(surface.transcriptContent).toBeInstanceOf(Object)
  })
})

test("create configures the CLI renderer", async () => {
  const callbacks = handlers()
  const result = await create(callbacks)

  expect(opentui.createCliRenderer).toHaveBeenLastCalledWith({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    useMouse: true,
    enableMouseMovement: true,
  })
  expect(result.renderer).toBe(opentui.renderer)
  expect(result.surface).toBeInstanceOf(Surface)
})
