import { expect, test, vi } from "vitest"

import { it } from "@effect/vitest"

import * as TranscriptPresentationModel from "@rika/transcript/transcript-presentation-model"

import * as TranscriptProjection from "@rika/transcript/transcript-projection"

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

const windowUnitToolCall = (id: string, family: "agent" | "explore") => ({
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

import {
  boundedTranscriptModel,
  clipStyledLine,
  create,
  formatTokens,
  maxMountedTranscriptEntries,
  maxMountedTranscriptRows,
  previewBoxRows,
  renderChangedFiles,
  renderTranscriptStyled,
} from "../../src/adapter"

import { initial, ready, update } from "../../src/view-state"

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

test("keeps nested ancestors and the newest child suffix within the transcript limit", () => {
  const layout: ReadonlyArray<{
    readonly id: string
    readonly family: "agent" | "explore"
    readonly parentId?: string
  }> = [
    { id: "agent", family: "agent" },
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `agent-tool-${index}`,
      family: "explore" as const,
      parentId: "agent",
    })),
    { id: "nested", family: "agent", parentId: "agent" },
    ...Array.from({ length: maxMountedTranscriptEntries + 50 }, (_, index) => ({
      id: `nested-child-${index}`,
      family: "explore" as const,
      parentId: "nested",
    })),
  ]
  const blocks = layout.map((entry) => windowUnitToolCall(entry.id, entry.family))
  const state = model({
    blocks,
    items: layout.map((entry, index) =>
      entry.parentId === undefined
        ? { _tag: "Block" as const, index, id: `tool:${entry.id}`, turnId: "turn" }
        : { _tag: "Block" as const, index, id: `tool:${entry.id}`, turnId: "child", parentId: entry.parentId },
    ),
    expandedRowKeys: ["tool:agent", "tool:nested"],
  })

  const bounded = boundedTranscriptModel(state)
  const mountedIds = new Set(
    (bounded.blocks as ReadonlyArray<TranscriptPresentationModel.Block>).flatMap((block) =>
      block._tag === "ToolCall" ? [block.id] : [],
    ),
  )

  expect([...mountedIds].some((id) => id.startsWith("nested-child-"))).toBe(true)
  expect(mountedIds.has("nested")).toBe(true)
  expect(mountedIds.has("agent")).toBe(true)
  expect(mountedIds.size).toBeLessThanOrEqual(maxMountedTranscriptEntries)
  expect(mountedIds.has("agent-tool-29")).toBe(false)
})

it.effect("mounts a bounded transcript window for large histories", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    surface.update(
      model({
        entries: Array.from({ length: maxMountedTranscriptEntries + 1_000 }, (_, index) => ({
          role: "assistant" as const,
          text: `answer ${index}`,
          turnId: `turn-${index}`,
        })),
      }),
    )

    expect(
      (surface as unknown as { transcriptChildren: ReadonlyArray<object> }).transcriptChildren.length,
    ).toBeLessThanOrEqual(maxMountedTranscriptRows * 2)
  }),
)
