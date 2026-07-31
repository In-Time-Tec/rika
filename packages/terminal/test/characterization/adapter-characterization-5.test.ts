import { expect, vi } from "vitest"

import { it } from "@effect/vitest"

import { Effect } from "effect"

const _shell = (id: string, command: string, output: string) => ({
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

import { Surface, create, renderTranscriptStyled } from "../../src/opentui/surface/opentui-surface"

import { initial, type Mode, type Model, type ThreadItem, update } from "../../src/state/model/terminal-state"

const handlers = () => ({ key: vi.fn(), resize: vi.fn() })

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

const createScoped = (callbacks: Parameters<typeof create>[0]) =>
  Effect.acquireRelease(create(callbacks), (created) => Effect.sync(created.releaseTerminal))

it.effect("renders welcome, entries, modes, activity, cursor, and palette", () =>
  Effect.gen(function* () {
    const callbacks = handlers()
    const { surface } = yield* createScoped(callbacks)

    const inputText = () => surface.composerEditor.plainText

    const modeLabelText = () =>
      (surface.modeLabel.content as { chunks: ReadonlyArray<{ text: string }> }).chunks.map(({ text }) => text).join("")

    surface.update(model({ input: "abcd", cursor: 2 }))
    expect(surface.transcriptScroll.content).toBeInstanceOf(Object)
    expect(inputText()).toBe("abcd")
    expect(surface.inputBox.title).toBe("")
    expect(modeLabelText()).toBe(" medium ")
    expect(surface.inputBox.borderColor).toEqual(opentui.RGBA.fromIndex(7))
    expect(surface.inputBox.bottomTitle).toBe("")
    expect(surface.workspaceLabel.content).toEqual(
      expect.objectContaining({ chunks: [expect.objectContaining({ text: " /workspace " })] }),
    )
    expect(surface.palette.visible).toBe(false)

    surface.update(model({ width: 40, input: "one\ntwo\nthree", cursor: 13 }))
    expect(surface.inputBox.height).toBe(5)
    expect(inputText()).toBe("one\ntwo\nthree")
    expect(surface.inputBox.bottomTitle).toBe("")

    surface.update(model({ input: "one\ntwo\nthree\nfour", cursor: 18 }))
    expect(surface.inputBox.height).toBe(6)
    expect(inputText()).toBe("one\ntwo\nthree\nfour")

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
      surface.update(model({ mode, busy: true, activity: { _tag: "Sending" } }))
      expect(surface.inputBox.title).toBe("")
      expect(modeLabelText()).toBe(` $···· ─ ${mode} `)
      expect(surface.inputBox.borderColor).toEqual(opentui.RGBA.fromIndex(7))
      expect(surface.statusLabel.content).toEqual(
        expect.objectContaining({
          chunks: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(" Sending ") })]),
        }),
      )
    }
    surface.update(model({ mode: "medium", busy: false, costUsd: 0.0074 }))
    expect(modeLabelText()).toBe(" $0.007 ─ medium ")
    surface.update(
      model({
        mode: "medium",
        busy: false,
        costUsd: 5.4449,
        usageCost: { _tag: "Available", usd: 1.25, unpricedAttempts: 2 },
      }),
    )
    expect(modeLabelText()).toBe(" $1.25 ─ medium ")
    surface.update(
      model({
        mode: "medium",
        busy: false,
        costUsd: 0.0074,
        usageCost: { _tag: "Available", usd: 0.0074, unpricedAttempts: 1 },
      }),
    )
    expect(modeLabelText()).toBe(" $0.007 ─ medium ")
    surface.update(
      model({
        mode: "medium",
        busy: false,
        usageCost: { _tag: "Available", usd: 1.25, unpricedAttempts: 2 },
      }),
    )
    expect(modeLabelText()).toBe(" $1.25 ─ medium ")
    surface.update(model({ mode: "medium", busy: false, costUsd: 5.4449, fastMode: true }))
    expect(modeLabelText()).toBe(" $5.44 ─ ↯medium ")
    const globalTotalUsd = 12.34
    surface.update(model({ mode: "medium", busy: false, costUsd: globalTotalUsd }))
    expect(modeLabelText()).toBe(" $12.34 ─ medium ")
    surface.update(model({ mode: "medium", usageCost: { _tag: "Loading" } }))
    expect(modeLabelText()).toBe(" $···· ─ medium ")
    surface.update(model({ mode: "medium", usageCost: { _tag: "Unavailable" } }))
    expect(modeLabelText()).toBe(" $— ─ medium ")
    surface.update(
      model({
        mode: "medium",
        usageDisplay: "tokens",
        usageTokens: { _tag: "Available", total: 40_100_000, uncountedAttempts: 0 },
      }),
    )
    expect(modeLabelText()).toBe(" 40.1M tok ─ medium ")
    surface.update(
      model({
        mode: "medium",
        usageDisplay: "time",
        usageTime: { _tag: "Available", accumulatedMillis: 103_000 },
      }),
    )
    expect(modeLabelText()).toBe(" ◷ 1m 43s ─ medium ")
    surface.update(model({ mode: "medium", usageDisplay: "time", usageTime: { _tag: "Loading" } }))
    expect(modeLabelText()).toBe(" ◷ ···· ─ medium ")
    surface.update(model({ mode: "medium", usageDisplay: "time", usageTime: { _tag: "Unavailable" } }))
    expect(modeLabelText()).toBe(" ◷ — ─ medium ")

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
    expect(surface.transcriptScroll.content).toBeInstanceOf(Object)
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
    expect(paletteText).toContain("change mode")
    expect(paletteText).toContain("toggle fast mode")
    expect(paletteText).toContain("quit")
    expect(paletteText).not.toContain("run prompt")
    expect(paletteText).not.toContain("show context and cost")
    expect(paletteText).not.toContain("review workspace changes")
    expect(paletteText).not.toContain("changed files")
    expect(opentui.requestRender.mock.calls.length).toBeGreaterThanOrEqual(7)
  }),
)

it.effect("routes usage-label clicks to the local display toggle", () =>
  Effect.gen(function* () {
    const usageToggle = vi.fn()
    const { surface } = yield* createScoped({ ...handlers(), usageToggle })
    surface.update(model({ usageCost: { _tag: "Available", usd: 1.25, unpricedAttempts: 0 } }))
    Object.assign(surface.modeLabel, { screenX: 20 })
    surface.modeLabel.onMouseDown?.({ x: 20 } as never)
    expect(usageToggle).toHaveBeenCalledOnce()
    surface.modeLabel.onMouseDown?.({ x: 27 } as never)
    expect(usageToggle).toHaveBeenCalledOnce()
  }),
)

it.effect("uses native clock width and pointer hover for the usage label", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    surface.update(
      model({
        mode: "medium",
        usageDisplay: "time",
        usageTime: { _tag: "Available", accumulatedMillis: 103_000 },
      }),
    )
    expect(surface.modeLabel.width).toBe(19)
    Object.assign(surface.modeLabel, { screenX: 20 })
    expect(
      (surface.modeLabel.content as { chunks: ReadonlyArray<{ attributes?: number }> }).chunks[0]?.attributes,
    ).toBe(2)

    surface.modeLabel.onMouseOver?.({ x: 20 } as never)
    expect(opentui.renderer.setMousePointer).toHaveBeenLastCalledWith("pointer")
    expect(
      (surface.modeLabel.content as { chunks: ReadonlyArray<{ attributes?: number }> }).chunks[0]?.attributes,
    ).toBeUndefined()
    surface.modeLabel.onMouseMove?.({ x: 31 } as never)
    expect(opentui.renderer.setMousePointer).toHaveBeenLastCalledWith("pointer")
    surface.modeLabel.onMouseOver?.({ x: 20 } as never)
    surface.modeLabel.onMouseOut?.({} as never)
    expect(opentui.renderer.setMousePointer).toHaveBeenLastCalledWith("default")
  }),
)

it.effect("routes clicks on the usage and mode segments to their own handlers", () =>
  Effect.gen(function* () {
    const usageToggle = vi.fn()
    const modeToggle = vi.fn()
    const { surface } = yield* createScoped({ ...handlers(), usageToggle, modeToggle })
    surface.update(
      model({
        mode: "medium",
        usageDisplay: "time",
        usageTime: { _tag: "Available", accumulatedMillis: 103_000 },
      }),
    )
    Object.assign(surface.modeLabel, { screenX: 20 })

    surface.modeLabel.onMouseDown?.({ x: 20 } as never)
    expect(usageToggle).toHaveBeenCalledTimes(1)
    expect(modeToggle).toHaveBeenCalledTimes(0)

    surface.modeLabel.onMouseDown?.({ x: 31 } as never)
    expect(modeToggle).toHaveBeenCalledTimes(1)
    expect(usageToggle).toHaveBeenCalledTimes(1)
  }),
)

it.effect("clears usage hover when a narrower selector moves away from the pointer", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    surface.update(
      model({ usageDisplay: "tokens", usageTokens: { _tag: "Available", total: 123_456, uncountedAttempts: 0 } }),
    )
    Object.assign(surface.modeLabel, { screenX: 20 })
    surface.modeLabel.onMouseOver?.({ x: 20 } as never)
    expect(opentui.renderer.setMousePointer).toHaveBeenLastCalledWith("pointer")

    surface.update(model({ usageCost: { _tag: "Available", usd: 0, unpricedAttempts: 0 } }))
    expect(opentui.renderer.setMousePointer).toHaveBeenLastCalledWith("default")
    expect(
      (surface.modeLabel.content as { chunks: ReadonlyArray<{ attributes?: number }> }).chunks[0]?.attributes,
    ).toBe(2)
  }),
)

it.effect("clears usage hover after layout moves a right-anchored label under a stationary pointer", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    surface.update(
      model({ usageDisplay: "tokens", usageTokens: { _tag: "Available", total: 123_456, uncountedAttempts: 0 } }),
    )
    Object.assign(surface.modeLabel, { screenX: 20 })
    surface.modeLabel.onMouseOver?.({ x: 21 } as never)
    expect(opentui.renderer.setMousePointer).toHaveBeenLastCalledWith("pointer")

    Object.assign(surface.modeLabel, { screenX: 5 })
    for (const frame of opentui.frameHandlers) frame()

    expect(opentui.renderer.setMousePointer).toHaveBeenLastCalledWith("default")
    expect(
      (surface.modeLabel.content as { chunks: ReadonlyArray<{ attributes?: number }> }).chunks[0]?.attributes,
    ).toBe(2)
  }),
)

it.effect("removes its listeners on destroy", () =>
  Effect.gen(function* () {
    const callbacks = handlers()
    const { surface } = yield* createScoped(callbacks)
    const keyCount = opentui.keyHandlers.size
    const pasteCount = opentui.pasteHandlers.size
    const resizeCount = opentui.resizeHandlers.size
    const selectionCount = opentui.selectionHandlers.size

    surface.destroy()

    expect(opentui.keyHandlers.size).toBe(keyCount - 1)
    expect(opentui.pasteHandlers.size).toBe(pasteCount - 1)
    expect(opentui.resizeHandlers.size).toBe(resizeCount - 1)
    expect(opentui.selectionHandlers.size).toBe(selectionCount - 1)
  }),
)

it.effect("ignores a queued loader tick after destroy", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    const loader = surface as unknown as { loaderPhase: number; tickLoader: () => void }
    const phase = loader.loaderPhase

    surface.destroy()
    loader.tickLoader()

    expect(loader.loaderPhase).toBe(phase)
  }),
)

it.effect("renders mode picker, filtered palette, sidebar visibility, and notice transitions", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    const paletteText = () =>
      (surface.palette.content as { chunks: ReadonlyArray<{ text: string }> }).chunks.map(({ text }) => text).join("")
    surface.update(model({ modePicker: { open: true, selected: 2 } }))
    expect(paletteText()).toContain("high")
    expect(paletteText()).toContain("Deep reasoning for hard tasks")
    expect(surface.paletteBox.bottomTitle).toBe(" ←→ turn · esc")
    surface.update(model({ palette: { open: true, query: "quit", selected: 0 } }))
    expect(paletteText()).toContain("quit")
    surface.update(
      model({
        threads: [thread({ id: "a", title: "A" })],
        threadSidebar: { open: false, focused: false, selected: 0, scrollTop: 0 },
      }),
    )
    expect(surface.sidebar.visible).toBe(false)
    surface.update(model({ entries: [{ role: "assistant", text: "ok" }] }))
    expect(surface.transcriptScroll.content).toBeInstanceOf(Object)
  }),
)

it.effect("create configures the CLI renderer", () =>
  Effect.gen(function* () {
    const callbacks = handlers()
    const result = yield* createScoped(callbacks)

    expect(opentui.createCliRenderer).toHaveBeenLastCalledWith({
      screenMode: "alternate-screen",
      exitOnCtrlC: false,
      exitSignals: [],
      useMouse: true,
      enableMouseMovement: true,
    })
    expect("renderer" in result).toBe(false)
    expect(result.surface).toBeInstanceOf(Surface)
  }),
)

it.effect("makes the renderer background transparent before constructing the surface", () =>
  Effect.gen(function* () {
    opentui.renderer.setBackgroundColor.mockClear()
    opentui.renderer.root.add.mockClear()
    yield* createScoped(handlers())
    expect(opentui.renderer.setBackgroundColor).toHaveBeenCalledWith("transparent")
    const backgroundOrder = opentui.renderer.setBackgroundColor.mock.invocationCallOrder[0]!
    const rootAddOrder = opentui.renderer.root.add.mock.invocationCallOrder[0]!
    expect(backgroundOrder).toBeLessThan(rootAddOrder)
  }),
)

it.effect("releases renderer terminal modes once when initialization fails after acquisition", () =>
  Effect.gen(function* () {
    opentui.renderer.destroy.mockClear()

    const error = yield* Effect.flip(
      create({
        key: vi.fn(),
        resize: () => {
          throw new Error("resize failed")
        },
      }),
    )

    expect(String(error)).toContain("resize failed")
    expect(opentui.renderer.destroy).toHaveBeenCalledTimes(1)
  }),
)

it.effect("releases terminal modes once before other cleanup and prevents editor resume while closing", () =>
  Effect.gen(function* () {
    opentui.renderer.destroy.mockClear()
    opentui.renderer.suspend.mockClear()
    opentui.renderer.resume.mockClear()
    const created = yield* createScoped(handlers())
    const events: Array<string> = []
    opentui.renderer.destroy.mockImplementation(() => events.push("terminal-released"))

    created.suspendTerminal()
    created.releaseTerminal()
    events.push("slow-client-cleanup")
    created.resumeTerminal()
    created.releaseTerminal()

    expect(events).toEqual(["terminal-released", "slow-client-cleanup"])
    expect(opentui.renderer.suspend).toHaveBeenCalledTimes(1)
    expect(opentui.renderer.resume).not.toHaveBeenCalled()
    expect(opentui.renderer.destroy).toHaveBeenCalledTimes(1)
  }),
)

it.effect("releases terminal modes when renderer suspension fails", () =>
  Effect.gen(function* () {
    opentui.renderer.destroy.mockReset()
    opentui.renderer.suspend.mockImplementationOnce(() => {
      throw new Error("suspend failed")
    })
    const created = yield* createScoped(handlers())

    expect(() => created.suspendTerminal()).toThrow("suspend failed")
    expect(opentui.renderer.destroy).toHaveBeenCalledTimes(1)
    expect(() => created.releaseTerminal()).not.toThrow()
    expect(opentui.renderer.destroy).toHaveBeenCalledTimes(1)
  }),
)

it.effect("releases terminal modes when renderer resume fails", () =>
  Effect.gen(function* () {
    opentui.renderer.destroy.mockReset()
    opentui.renderer.resume.mockImplementationOnce(() => {
      throw new Error("resume failed")
    })
    const created = yield* createScoped(handlers())

    created.suspendTerminal()
    expect(() => created.resumeTerminal()).toThrow("resume failed")
    expect(opentui.renderer.destroy).toHaveBeenCalledTimes(1)
    expect(() => created.releaseTerminal()).not.toThrow()
    expect(opentui.renderer.destroy).toHaveBeenCalledTimes(1)
  }),
)

it.effect("destroys the renderer when surface cleanup fails", () =>
  Effect.gen(function* () {
    opentui.renderer.destroy.mockClear()
    const created = yield* createScoped(handlers())
    created.surface.destroy = () => {
      throw new Error("surface cleanup failed")
    }

    expect(() => created.releaseTerminal()).not.toThrow()
    expect(opentui.renderer.destroy).toHaveBeenCalledTimes(1)
    expect(() => created.releaseTerminal()).not.toThrow()
    expect(opentui.renderer.destroy).toHaveBeenCalledTimes(1)
  }),
)
