import { expect, vi } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"

import { ready } from "../../src/state/model/terminal-state"
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
import {
  _windowUnitToolCall,
  _agentToolBlock,
  handlers,
  model,
  _thread,
  createScoped,
} from "./adapter-characterization-4.test-support"
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
