import { expect, test, vi } from "vitest"

import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Effect } from "effect"
import stringWidth from "string-width"
import {
  clipStyledLine,
  formatTokens,
  previewBoxRows,
  renderChangedFiles,
  renderTranscriptStyled,
} from "../../src/opentui/surface/opentui-surface"
import { ready, update } from "../../src/state/model/terminal-state"
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
import { _shell, _agentToolBlock, _nonEmptyLines, model, thread } from "./adapter-characterization-1.test-support"
test("formats compact token totals", () => {
  expect(formatTokens(999)).toBe("999 tok")
  expect(formatTokens(40_100_000)).toBe("40.1M tok")
})
test("clips a styled line by terminal cell width, not character count", () => {
  const clipped = clipStyledLine([{ __isChunk: true, text: "你好世界" }], 4)
  expect(clipped.reduce((total, chunk) => total + stringWidth(chunk.text), 0)).toBeLessThanOrEqual(4)
  expect(clipped.map((chunk) => chunk.text).join("")).toBe("你好")
})
test("draws every thread-preview row at the exact box width with a two-cell gutter", () => {
  const width = 44
  const height = 14
  const previewModel = model({
    threads: [thread({ id: "a", title: "Alpha" })],
    threadSwitcher: { open: true, query: "", selected: 0, kind: "switch", previewScroll: 0 },
    threadPreview: ready({
      threadId: "a",
      turns: [
        {
          prompt: "hello world this prompt is long enough that it must wrap across several preview rows",
          units: TranscriptProjection.Projection.empty(
            "preview",
            "hello world this prompt is long enough that it must wrap across several preview rows",
          ).units,
        },
      ],
    }),
  })
  const rows = previewBoxRows(previewModel, width, height)
  expect(rows.size).toBe(height)
  for (const chunks of rows.values())
    expect(chunks.reduce((total, chunk) => total + stringWidth(chunk.text), 0)).toBe(width)
  const contentRow = [...rows.values()].find((chunks) =>
    chunks
      .map((chunk) => chunk.text)
      .join("")
      .includes("hello"),
  )
  expect(contentRow).toBeDefined()
  expect(contentRow![0]!.text).toBe("│")
  expect(stringWidth(contentRow![1]!.text)).toBe(2)
  const text = [...rows.values()].flatMap((row) => row.map((chunk) => chunk.text)).join("")
  expect(text).toContain("Alpha")
  expect(text).toContain("/work")
  expect(text).toContain("idle")
})
test("reuses formatted thread-preview content while scrolling", () => {
  let unitReads = 0
  const event = {
    cursor: "answer",
    get sequence() {
      unitReads += 1
      return 1
    },
    type: "model.output.completed" as const,
    createdAt: 1,
    text: Array.from({ length: 40 }, (_, index) => `preview line ${index}`).join("\n"),
  }
  const previewModel = model({
    threads: [thread({ id: "a", title: "Alpha" })],
    threadSwitcher: { open: true, query: "", selected: 0, kind: "switch", previewScroll: 0 },
    threadPreview: ready({
      threadId: "a",
      turns: [{ prompt: "hello", units: TranscriptProjection.Projection.project("preview", "hello", [event]).units }],
    }),
  })

  previewBoxRows(previewModel, 44, 14)
  const readsAfterFormatting = unitReads
  expect(readsAfterFormatting).toBeGreaterThan(0)

  previewBoxRows(update(previewModel, { _tag: "ThreadPreviewScrolled", offset: 3 }), 44, 14)
  expect(unitReads).toBe(readsAfterFormatting)
})
test("keeps the previous thread preview visible until the next preview is ready", () => {
  const width = 64
  const height = 24
  const firstPending = update(
    model({
      mode: "high",
      threads: [thread({ id: "a", title: "Alpha" })],
      threadSwitcher: { open: true, query: "", selected: 0, kind: "switch", previewScroll: 0 },
    }),
    { _tag: "ThreadPreviewRequested" },
  )
  const firstPendingText = [...previewBoxRows(firstPending, width, height).values()]
    .flatMap((row) => row.map((chunk) => chunk.text))
    .join("")
  expect(firstPendingText).not.toContain("Loading preview")
  expect(firstPendingText).not.toContain("No preview")
  expect(firstPendingText).not.toMatch(/[•●·]/u)

  const previous = model({
    mode: "high",
    threads: [thread({ id: "a", title: "Alpha" }), thread({ id: "b", title: "Beta" })],
    threadSwitcher: { open: true, query: "", selected: 0, kind: "switch", previewScroll: 0 },
    threadPreview: ready({
      threadId: "a",
      turns: [
        {
          prompt: "previous preview",
          units: TranscriptProjection.Projection.empty("preview", "previous preview").units,
        },
      ],
    }),
  })
  const pendingModel = update(
    { ...previous, threadSwitcher: { ...previous.threadSwitcher, selected: 1 } },
    { _tag: "ThreadPreviewRequested" },
  )
  const pendingRows = previewBoxRows(pendingModel, width, height)
  const pendingText = [...pendingRows.values()].flatMap((row) => row.map((chunk) => chunk.text)).join("")
  expect(pendingText).toContain("previous preview")
  expect(pendingText).not.toMatch(/[•●·]/u)

  const loadedRows = previewBoxRows(
    update(pendingModel, {
      _tag: "ThreadPreviewLoaded",
      threadId: "b",
      turns: [
        {
          prompt: "next preview",
          units: TranscriptProjection.Projection.project("preview", "next preview", [
            {
              cursor: "answer",
              sequence: 1,
              type: "model.output.completed",
              createdAt: 1,
              text: "transcript tail loaded",
            },
          ]).units,
        },
      ],
    }),
    width,
    height,
  )
  const loadedText = [...loadedRows.values()].flatMap((row) => row.map((chunk) => chunk.text)).join("")
  expect(loadedText).toContain("transcript tail loaded")
  expect(loadedText).not.toContain("previous preview")
})
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

  expect(rendered).toBe("apps/\n  rika/\n    src/\n      main.ts +3 -1\n    test/\n      main.test.ts +8 -0\nREADME.md")
  expect(
    renderChangedFiles(model({ changedFiles: ready([{ path: "src/main.ts", status: "M", added: 3, removed: 1 }]) }), 28)
      .chunks,
  ).toEqual([
    { text: "src/", fg: opentui.RGBA.fromIndex(8) },
    { text: "\n", fg: opentui.RGBA.fromIndex(7) },
    { text: "  ", fg: opentui.RGBA.fromIndex(7) },
    { text: "main.ts", fg: opentui.RGBA.fromIndex(3) },
    { text: " +3", fg: opentui.RGBA.fromIndex(2) },
    { text: " -1", fg: opentui.RGBA.fromIndex(1) },
  ])
})
test("renders base transcript text with an explicit terminal palette color", () => {
  const chunks = renderTranscriptStyled(model({ entries: [{ role: "assistant", text: "answer" }] })).chunks
  const answer = chunks.find((chunk) => chunk.text.includes("answer"))

  expect(answer?.fg).toEqual(opentui.RGBA.fromIndex(7))
})
