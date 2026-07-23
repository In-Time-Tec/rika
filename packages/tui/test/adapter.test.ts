import { describe, expect, test, vi } from "vitest"
import { it } from "@effect/vitest"
import * as Transcript from "@rika/transcript"
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

import stringWidth from "string-width"
import {
  Surface,
  buildTranscript,
  boundedTranscriptModel,
  clipStyledLine,
  create,
  maxMountedTranscriptEntries,
  previewBoxRows,
  renderBlock,
  renderChangedFiles,
  renderSidebar,
  renderTranscript,
  renderTranscriptStyled,
} from "../src/adapter"
import { initial, ready, update, type Mode, type Model, type ThreadItem } from "../src/view-state"
import { colors } from "../src/theme"

const handlers = () => ({ key: vi.fn(), resize: vi.fn() })
const nonEmptyLines = (text: string) => text.split("\n").filter((line) => line.length > 0)

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
          events: [],
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
      turns: [{ prompt: "previous preview", events: [] }],
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
          events: [
            {
              cursor: "answer",
              sequence: 1,
              type: "model.output.completed",
              createdAt: 1,
              text: "transcript tail loaded",
            },
          ],
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

describe("Surface", () => {
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
        transcript.transcriptChildren
          .map((child) => child.content.chunks.map((chunk) => chunk.text).join(""))
          .join("\n")
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
      const source = Array.from({ length: 4_000 }, (_, index) => `LONG_CHUNK_${String(index).padStart(4, "0")};`).join(
        "",
      )
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
    const state = model({
      entries: Array.from({ length: 1_000 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      })),
      items: Array.from({ length: 1_000 }, (_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      })),
    })

    const bounded = boundedTranscriptModel(state)

    expect(bounded.entries).toHaveLength(200)
    expect(bounded.items).toHaveLength(200)
    expect(bounded.entries[0]?.text).toBe("answer 800")
    expect(bounded.items[0]).toEqual({ _tag: "Entry", index: 0, id: "answer-800", turnId: "turn-800" })
    const older = boundedTranscriptModel(state, 400)
    expect(older.entries).toHaveLength(200)
    expect(older.entries[0]?.text).toBe("answer 200")
    expect(older.entries.at(-1)?.text).toBe("answer 399")
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
    const children = Array.from({ length: 205 }, (_, index) => ({
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

    expect(bounded.items).toHaveLength(206)
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
      ...Array.from({ length: 250 }, (_, index) => ({
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
      (bounded.blocks as ReadonlyArray<Transcript.Block>).flatMap((block) =>
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
          entries: Array.from({ length: 1_000 }, (_, index) => ({
            role: "assistant" as const,
            text: `answer ${index}`,
            turnId: `turn-${index}`,
          })),
        }),
      )

      expect(
        (surface as unknown as { transcriptChildren: ReadonlyArray<object> }).transcriptChildren.length,
      ).toBeLessThanOrEqual(400)
    }),
  )

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
      { _tag: "ChildAgent", id: "child", name: "child", summary: "work", status: "running", activity: [] },
      { _tag: "Workflow", name: "flow", step: "wait", status: "waiting" },
      { _tag: "ImageAttachment", name: "a.png", mediaType: "image/png" },
      { _tag: "ImageAttachment", name: "partial.png", mediaType: "image/png", width: 2 },
      { _tag: "ImageAttachment", name: "b.png", mediaType: "image/png", width: 2, height: 3, bytes: 4 },
    ] as const
    const renderedBlocks = blocks.map((block) => renderBlock(block)).join("\n")
    expect(renderedBlocks).toContain("✕ Result")
    expect(renderedBlocks).toContain(
      "✖ ERROR: Execution failed · Turn turn-4\n  Model unavailable\n  Next: Press Enter to retry.",
    )
    expect(renderedBlocks).toContain("2×3 · 4 bytes")
    const state = model({
      blocks: [...blocks],
      currentThreadId: "a",
      threads: [thread({ id: "a", title: "One", unread: true }), thread({ id: "b", title: "Two" })],
    })
    expect(renderTranscript(state)).toContain("Reasoning")
    const styledTranscript = renderTranscriptStyled(state)
      .chunks.map((chunk) => chunk.text)
      .join("")
    expect(styledTranscript).toContain("Allow once")
    expect(styledTranscript).toContain("Always")
    expect(styledTranscript).toContain("Deny")
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

    expect(renderBlock(block)).toBe("✓ Web Search Find current documentation")
    expect(renderTranscript(state)).toContain("✓ Web Search Find current documentation")
    expect(renderTranscript(state)).not.toContain("HIDDEN SEARCH RESULT")
    expect(renderTranscript(state)).not.toContain("▸")
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

    expect(rendered).toBe("⠿ Plugin-defined tool [running] ▸")
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
    expect(expanded.styled.chunks.map((chunk) => chunk.text).join("")).toContain("passed")
    expect(expanded.styled.chunks.map((chunk) => chunk.text).join("")).not.toContain("clean")
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
    const infoChunk = built.styled.chunks.find((current) =>
      current.text.includes("finished without a final message"),
    ) as { readonly text: string; readonly fg?: string } | undefined
    expect(infoChunk).toBeDefined()
    expect(infoChunk?.fg).toBe(colors.text)
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

  const editToolBlock = {
    _tag: "ToolCall",
    id: "patch",
    name: "edit",
    input: "{}",
    status: "complete",
    presentation: {
      family: "edit",
      action: "edit",
      activeLabel: "Editing",
      completeLabel: "Edited",
    },
    detail: "",
    files: [
      {
        key: "patch:0",
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
  const subagentToolBlock = {
    _tag: "ToolCall",
    id: "agent",
    name: "task",
    input: "{}",
    status: "complete",
    presentation: {
      family: "agent",
      action: "task",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    },
    detail: "Inspect\nthe projection",
    files: [],
  } as const
  const renderedText = (changes: Partial<Model>) =>
    buildTranscript(model(changes))
      .styled.chunks.map((chunk) => chunk.text)
      .join("")

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
      expandedRowKeys: ["tool:agent"],
    })
    const lines = nonEmptyLines(
      buildTranscript(state)
        .styled.chunks.map((chunk) => chunk.text)
        .join(""),
    )
    expect(lines.some((line) => line.trimStart().startsWith("├"))).toBe(true)
    expect(lines.some((line) => line.trimStart().startsWith("└"))).toBe(true)
    expect(lines.every((line) => !line.startsWith("│"))).toBe(true)
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

  test("wraps a nested agent label beneath its text while preserving the connector", () => {
    const state = model({
      width: 48,
      blocks: [
        { ...subagentToolBlock, id: "parent", detail: "Explore the project" },
        {
          ...subagentToolBlock,
          id: "child",
          detail: "Read-only explore packages/config, extensions, and tools with concise source-file evidence.",
        },
        shell("following", "git status", "clean"),
      ],
      items: [
        { _tag: "Block", index: 0, id: "tool:parent", turnId: "turn" },
        { _tag: "Block", index: 1, id: "tool:child", turnId: "child:parent", parentId: "parent" },
        { _tag: "Block", index: 2, id: "tool:following", turnId: "child:parent", parentId: "parent" },
      ],
      expandedRowKeys: ["tool:parent"],
    })
    const lines = buildTranscript(state)
      .styled.chunks.map((chunk) => chunk.text)
      .join("")
      .split("\n")

    expect(lines.some((line) => line.startsWith("  ├ ✓ Subagent finished Read-only explore"))).toBe(true)
    expect(lines.some((line) => line.startsWith("  │   packages/config"))).toBe(true)
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

    expect(headers.length).toBeGreaterThan(blocks.length)
    expect(headers.some((line) => line.includes("界"))).toBe(true)
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

  it.effect("renders welcome, entries, modes, activity, cursor, and palette", () =>
    Effect.gen(function* () {
      const callbacks = handlers()
      const { surface } = yield* createScoped(callbacks)

      const inputText = () => surface.composerEditor.plainText

      const modeLabelText = () =>
        (surface.modeLabel.content as { chunks: ReadonlyArray<{ text: string }> }).chunks
          .map(({ text }) => text)
          .join("")

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
      surface.update(model({ mode: "medium", busy: false, costUsd: 5.4449 }))
      expect(modeLabelText()).toBe(" $5.44 ─ medium ")
      surface.update(model({ mode: "medium", busy: false, costUsd: 5.4449, fastMode: true }))
      expect(modeLabelText()).toBe(" $5.44 ─ ↯medium ")
      const globalTotalUsd = 12.34
      surface.update(model({ mode: "medium", busy: false, costUsd: globalTotalUsd }))
      expect(modeLabelText()).toBe(" $12.34 ─ medium ")

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
})

it.effect("create configures the CLI renderer", () =>
  Effect.gen(function* () {
    const callbacks = handlers()
    const result = yield* createScoped(callbacks)

    expect(opentui.createCliRenderer).toHaveBeenLastCalledWith({
      screenMode: "alternate-screen",
      exitOnCtrlC: false,
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
