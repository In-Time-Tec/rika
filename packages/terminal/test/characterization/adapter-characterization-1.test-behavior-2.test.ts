import { expect, test, vi } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import stringWidth from "string-width"
import { boundedTranscriptModel, maxMountedTranscriptEntries } from "../../src/opentui/surface/opentui-surface"
import { update } from "../../src/state/model/terminal-state"
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
  _shell,
  _agentToolBlock,
  handlers,
  _nonEmptyLines,
  model,
  createScoped,
} from "./adapter-characterization-1.test-support"
it.effect("reflows mounted assistant markdown when the terminal width shrinks", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    const markdown = [
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega repeat every paragraph word",
      "",
      "| Layer | Owner | Detail |",
      "|---|---|---|",
      "| durable execution | Relay | preserves every table word while wrapping narrow cells |",
      "",
      "```ts",
      "const blankRowRhythmMarker = preserveEveryCodeTokenAcrossTheNarrowTerminalWidth",
      "```",
    ].join("\n")
    const wide = model({
      width: 200,
      height: 66,
      entries: [{ role: "assistant", text: markdown, turnId: "turn-1" }],
    })

    surface.update(wide)
    const transcript = surface as unknown as {
      readonly transcriptChildren: ReadonlyArray<{
        readonly content: { readonly chunks: ReadonlyArray<{ text: string }> }
      }>
    }
    const text = () =>
      transcript.transcriptChildren.map((child) => child.content.chunks.map((chunk) => chunk.text).join("")).join("\n")
    const mounted = [...transcript.transcriptChildren]
    expect(
      text()
        .split("\n")
        .some((line) => stringWidth(line) > 100),
    ).toBe(true)

    surface.update(update(wide, { _tag: "Resized", width: 100, height: 30 }))
    const narrowed = text()

    expect(transcript.transcriptChildren).toEqual(mounted)
    expect(narrowed.split("\n").every((line) => stringWidth(line) <= 100)).toBe(true)
    for (const word of [
      "alpha",
      "omega",
      "durable",
      "execution",
      "Relay",
      "preserves",
      "wrapping",
      "blankRowRhythmMarker",
      "preserveEveryCodeTokenAcrossTheNarrowTerminalWidth",
    ])
      expect(narrowed).toContain(word)
  }),
)
it.effect("keeps a 4000-chunk transcript resize reflow bounded", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    const source = Array.from({ length: 4_000 }, (_, index) => `LONG_CHUNK_${String(index).padStart(4, "0")};`).join("")
    const wide = model({
      width: 200,
      height: 66,
      entries: [{ role: "assistant", text: source, turnId: "turn-1" }],
    })
    surface.update(wide)

    const startedAt = performance.now()
    surface.update(update(wide, { _tag: "Resized", width: 100, height: 30 }))
    const elapsed = performance.now() - startedAt
    const transcript = surface as unknown as {
      readonly transcriptChildren: ReadonlyArray<{
        readonly content: { readonly chunks: ReadonlyArray<{ text: string }> }
      }>
    }
    const text = transcript.transcriptChildren
      .flatMap((child) => child.content.chunks)
      .map((chunk) => chunk.text)
      .join("")

    expect(text).toContain("LONG_CHUNK_3999")
    expect(elapsed).toBeLessThan(1_000)
  }),
)
it.effect("keeps unchanged keyed transcript renderables across composer updates", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    const state = model({
      entries: [
        { role: "user", text: "question", turnId: "turn-1" },
        { role: "assistant", text: "answer", turnId: "turn-1" },
      ],
    })

    surface.update(state)
    const before = [...(surface as unknown as { transcriptChildren: ReadonlyArray<object> }).transcriptChildren]
    expect(before).toHaveLength(3)
    expect(before[0]).not.toBe(before[2])
    const gap = (before[1] as { content: { chunks: ReadonlyArray<{ text: string }> } }).content.chunks
      .map((chunk) => chunk.text)
      .join("")
    expect(gap).toBe(" ")
    const created = opentui.textRenderables.length
    surface.update({ ...state, input: "next", cursor: 4 })
    const after = (surface as unknown as { transcriptChildren: ReadonlyArray<object> }).transcriptChildren

    expect(after).toEqual(before)
    expect(after.every((child, index) => child === before[index])).toBe(true)
    expect(opentui.textRenderables).toHaveLength(created)
  }),
)
test("limits transcript formatting input before reconciliation", () => {
  const historySize = maxMountedTranscriptEntries + 800
  const state = model({
    entries: Array.from({ length: historySize }, (_, index) => ({
      role: "assistant" as const,
      text: `answer ${index}`,
      turnId: `turn-${index}`,
    })),
    items: Array.from({ length: historySize }, (_, index) => ({
      _tag: "Entry" as const,
      index,
      id: `answer-${index}`,
      turnId: `turn-${index}`,
    })),
  })

  const bounded = boundedTranscriptModel(state)

  expect(bounded.entries).toHaveLength(maxMountedTranscriptEntries)
  expect(bounded.items).toHaveLength(maxMountedTranscriptEntries)
  expect(bounded.entries[0]?.text).toBe("answer 800")
  expect(bounded.items[0]).toEqual({ _tag: "Entry", index: 0, id: "answer-800", turnId: "turn-800" })
  const older = boundedTranscriptModel(state, maxMountedTranscriptEntries + 200)
  expect(older.entries).toHaveLength(maxMountedTranscriptEntries)
  expect(older.entries[0]?.text).toBe("answer 200")
  expect(older.entries.at(-1)?.text).toBe(`answer ${maxMountedTranscriptEntries + 199}`)
})
test("keeps a subagent parent within the bounded suffix when its children exceed the limit", () => {
  const parent = {
    _tag: "ToolCall" as const,
    id: "agent",
    name: "oracle",
    input: "{}",
    status: "running" as const,
    presentation: {
      family: "agent" as const,
      action: "oracle",
      activeLabel: "Oracle exploring",
      completeLabel: "Oracle has spoken",
    },
    detail: "Review the code",
    files: [],
  }
  const children = Array.from({ length: maxMountedTranscriptEntries + 5 }, (_, index) => ({
    _tag: "ToolCall" as const,
    id: `child-${index}`,
    name: "read",
    input: `{"path":"src/${index}.ts"}`,
    status: "complete" as const,
    presentation: {
      family: "explore" as const,
      action: "read",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "file" as const,
    },
    detail: `src/${index}.ts`,
    files: [],
  }))
  const state = model({
    blocks: [parent, ...children],
    items: [
      { _tag: "Block", index: 0, id: "tool:agent", turnId: "turn" },
      ...children.map((_, index) => ({
        _tag: "Block" as const,
        index: index + 1,
        id: `tool:child-${index}`,
        turnId: "child",
        parentId: "agent",
      })),
    ],
  })

  const bounded = boundedTranscriptModel(state)

  expect(bounded.items).toHaveLength(children.length + 1)
  expect(bounded.blocks[0]).toMatchObject({ _tag: "ToolCall", id: "agent" })
  expect(bounded.items[0]).toMatchObject({ _tag: "Block", index: 0, id: "tool:agent" })
})
