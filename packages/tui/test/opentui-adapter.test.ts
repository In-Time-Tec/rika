import { CliRenderEvents, Renderable, RendererControlState } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Data, Effect } from "effect"
import stringWidth from "string-width"
import {
  Surface,
  boundedTranscriptModel,
  maxBoundedTranscriptItems,
  maxMountedTranscriptEntries,
  maxMountedTranscriptRows,
} from "../src/adapter"
import { colors } from "../src/theme"
import {
  applyQueueDelta,
  initial,
  loading,
  ready,
  replaceQueue,
  resetQueue,
  update,
  type Model,
  type ThreadItem,
} from "../src/view-state"

class OpenTuiError extends Data.TaggedError("OpenTuiError")<{ readonly cause: unknown }> {}

const openTui = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new OpenTuiError({ cause }) })

const insertText = (model: Model, text: string) => update(model, { _tag: "Pasted", text })

const styledTextValue = (value: { readonly chunks: ReadonlyArray<{ readonly text: string }> } | string) =>
  typeof value === "string" ? value : value.chunks.map((chunk) => chunk.text).join("")

const streamingShell = (id: string, output?: string) => ({
  _tag: "ToolCall" as const,
  id,
  name: "bash",
  input: `{"command":"printf ${id}"}`,
  status: "running" as const,
  presentation: {
    family: "shell" as const,
    action: "shell",
    activeLabel: "Running",
    completeLabel: "Ran",
  },
  detail: `printf ${id}`,
  ...(output === undefined ? {} : { output }),
  files: [],
})

const thread = (input: Partial<ThreadItem> & Pick<ThreadItem, "id" | "title">): ThreadItem => ({
  workspace: "/work",
  pinned: false,
  archived: false,
  status: "idle",
  unread: false,
  lastActivityAt: 0,
  ...input,
})

test("renders input and resize updates while the renderer remains event-driven", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model: Model = {
        ...initial("/work", "high"),
        entries: [{ role: "assistant", text: "settled response" }],
      }
      const surface = new Surface(setup.renderer, {
        key: (key) => {
          model = update(model, { _tag: "KeyPressed", key })
          surface.update(model)
        },
        resize: (width, height) => {
          model = update(model, { _tag: "Resized", width, height })
          surface.update(model)
        },
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("settled response")
        expect(setup.renderer.controlState).toBe(RendererControlState.IDLE)
        expect(setup.renderer.isRunning).toBe(false)
        yield* openTui(() => setup.mockInput.typeText("next"))
        yield* openTui(() => setup.flush())
        expect(setup.captureCharFrame()).toContain("next")
        expect(setup.renderer.isRunning).toBe(false)
        setup.renderer.resize(60, 18)
        yield* openTui(() => setup.flush())
        expect(model.width).toBe(60)
        expect(model.height).toBe(18)
        expect(setup.renderer.isRunning).toBe(false)
        setup.renderer.suspend()
        setup.renderer.resume()
        yield* openTui(() => setup.flush())
        expect(setup.captureCharFrame()).toContain("next")
        expect(setup.renderer.controlState).toBe(RendererControlState.IDLE)
        expect(setup.renderer.isRunning).toBe(false)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps the submitted transcript echo stable when typing resumes before TurnStarted", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model: Model = { ...initial("/work", "high"), width: 80, height: 24 }
      let submittedPrompt: string | undefined
      const surface = new Surface(setup.renderer, {
        key: (key) => {
          const submitting = key.name === "return" && !key.shift && model.input.length > 0
          if (submitting) submittedPrompt = model.input
          model = update(model, { _tag: "KeyPressed", key })
          if (submitting) model = update(model, { _tag: "Submitted" })
          surface.update(model)
        },
        resize: () => undefined,
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.mockInput.typeText("Explore in depth"))
        setup.mockInput.pressEnter()
        yield* openTui(() => setup.mockInput.typeText("ExE"))
        expect(submittedPrompt).toBe("Explore in depth")
        expect(model.input).toBe("ExE")
        model = update(model, { _tag: "TurnStarted", turnId: "turn-explore", prompt: submittedPrompt! })
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        expect(model.entries.at(-1)).toEqual({
          role: "user",
          text: "Explore in depth",
          turnId: "turn-explore",
        })
        const frame = setup.captureCharFrame()
        expect(frame).toContain("┃ Explore in depth")
        expect(frame).not.toContain("ExEExplore")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("coalesces a resize storm into one transcript reflow at the final width", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 200, height: 66, clock }))
      const resizeCalls: Array<readonly [number, number]> = []
      let model: Model = {
        ...initial("/work", "high"),
        width: 200,
        height: 66,
        entries: [{ role: "assistant", text: "alpha ".repeat(25).trimEnd(), turnId: "turn-1" }],
      }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: (width, height) => {
          resizeCalls.push([width, height])
          model = update(model, { _tag: "Resized", width, height })
          surface.update(model)
        },
      })
      try {
        surface.update(model)
        const transcript = surface as unknown as {
          readonly transcriptChildren: ReadonlyArray<{
            readonly content: { readonly chunks: ReadonlyArray<{ text: string }> }
          }>
        }
        const mounted = transcript.transcriptChildren[0]!
        const content = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(mounted), "content")!
        let contentWrites = 0
        Object.defineProperty(mounted, "content", {
          configurable: true,
          get: () => content.get!.call(mounted),
          set: (value: unknown) => {
            contentWrites += 1
            content.set!.call(mounted, value)
          },
        })
        const renderer = setup.renderer as unknown as { handleResize: (width: number, height: number) => void }
        const resizes = [
          [180, 60],
          [160, 50],
          [140, 42],
          [120, 36],
          [100, 30],
        ] as const
        for (const [index, [width, height]] of resizes.entries()) {
          renderer.handleResize(width, height)
          if (index < resizes.length - 1) clock.advance(50)
        }
        expect(resizeCalls.length).toBe(0)
        expect(contentWrites).toBe(0)
        clock.advance(99)
        expect(resizeCalls.length).toBe(0)
        clock.advance(1)
        expect(resizeCalls).toEqual([[100, 30]])
        expect(contentWrites).toBe(1)
        expect(setup.renderer.terminalWidth).toBe(100)
        expect(setup.renderer.terminalHeight).toBe(30)
        const narrowed = transcript.transcriptChildren
          .map((child) => child.content.chunks.map((chunk) => chunk.text).join(""))
          .join("\n")
        expect(narrowed.split("\n").every((line) => stringWidth(line) <= 100)).toBe(true)
        expect(narrowed.match(/alpha/g)?.length).toBe(25)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("converges the model to the physical terminal size when a resize event reports a stale size", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model: Model = { ...initial("/work", "high"), width: 80, height: 24 }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: (width, height) => {
          model = update(model, { _tag: "Resized", width, height })
          surface.update(model)
        },
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        const renderer = setup.renderer as unknown as {
          _usesProcessStdout: boolean
          stdout: { columns: number; rows: number }
          resize: (width: number, height: number) => void
          emit: (event: string, ...args: ReadonlyArray<unknown>) => boolean
        }
        renderer._usesProcessStdout = true
        renderer.stdout = { columns: 132, rows: 43 }
        let corrected: readonly [number, number] | undefined
        renderer.resize = (width, height) => {
          corrected = [width, height]
        }
        renderer.emit(CliRenderEvents.RESIZE, 80, 24)
        expect(corrected).toEqual([132, 43])
        expect([model.width, model.height]).toEqual([132, 43])
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("uses OpenTUI's native cursor position with a blinking block style", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { animate: false })
      const base = { ...initial("/work", "high"), width: 100, height: 30, input: "draft", cursor: 5 }
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        const composerCursor = setup.renderer.getCursorState()
        expect(composerCursor).toMatchObject({ visible: true, style: "block", blinking: true })

        surface.update({
          ...base,
          paletteOpen: true,
          palette: { open: true, query: "mode", selected: 0 },
        })
        yield* openTui(() => setup.flush())
        const paletteCursor = setup.renderer.getCursorState()
        expect(paletteCursor).toMatchObject({ visible: true, style: "block", blinking: true })
        expect(paletteCursor.y).not.toBe(composerCursor.y)

        surface.update({
          ...base,
          threadSwitcher: { ...base.threadSwitcher, open: true, query: "cursor" },
        })
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState()).toMatchObject({ visible: true, style: "block", blinking: true })

        surface.update({
          ...base,
          filePicker: { ...base.filePicker, open: true, query: "src", items: ready(["src/main.ts"]) },
        })
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState()).toMatchObject({ visible: true, style: "block", blinking: true })

        surface.update({ ...base, modePicker: { open: true, selected: 0 } })
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState().visible).toBe(false)

        surface.update({
          ...base,
          threadSidebar: { open: true, focused: true, selected: 0, scrollTop: 0 },
        })
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState().visible).toBe(false)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps the application-controlled cursor visible when animation is disabled", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { animate: false })
      const base = { ...initial("/work", "high"), width: 100, height: 30, input: "draft", cursor: 5 }
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState().visible).toBe(true)

        surface.update({ ...base, input: "drafts", cursor: 6 })
        expect(setup.renderer.getCursorState().visible).toBe(true)

        const palette = {
          ...base,
          paletteOpen: true,
          palette: { open: true, query: "mode", selected: 0 },
        }
        surface.update(palette)
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState().visible).toBe(true)

        surface.update({ ...palette, palette: { ...palette.palette, query: "modes" } })
        expect(setup.renderer.getCursorState().visible).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

for (const historySize of [1, maxMountedTranscriptEntries + 1] as const) {
  test(`keeps composer updates bounded with ${historySize} transcript entries`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
        const entries = Array.from({ length: historySize }, (_, index) => ({
          role: "assistant" as const,
          text: `settled answer ${index}`,
          turnId: `turn-${index}`,
        }))
        const base: Model = { ...initial("/work", "high"), entries }
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        try {
          surface.update(base)
          yield* openTui(() => setup.flush())
          const state = surface as unknown as { readonly transcriptChildren: ReadonlyArray<Renderable> }
          const mounted = [...state.transcriptChildren]
          for (let index = 0; index < 2; index += 1)
            surface.update({ ...base, input: `next ${index}`, cursor: `next ${index}`.length })

          expect(state.transcriptChildren.length).toBeLessThanOrEqual(maxMountedTranscriptEntries * 2)
          expect(state.transcriptChildren.every((child, index) => child === mounted[index])).toBe(true)
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

test("moves the bounded transcript window to older mounted entries and keeps it while typing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 500 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      const base: Model = { ...initial("/work", "high"), entries, items, scrollFollow: false }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptScroll.scrollTop - 1)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(0)
        setup.renderer.requestRender()
        yield* openTui(() => setup.flush())
        const firstBefore = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        const firstAfter = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        const state = surface as unknown as {
          readonly transcriptWindowEnd: number
          readonly transcriptChildren: ReadonlyArray<Renderable>
        }
        expect(state.transcriptWindowEnd).toBe(400)
        expect(firstBefore).toBe(300)
        expect(firstAfter).toBeLessThan(300)
        expect(firstAfter).toBeGreaterThan(200)
        expect(state.transcriptChildren.length).toBeLessThanOrEqual(maxMountedTranscriptEntries * 2)
        surface.update({ ...base, input: "next", cursor: 4 })
        expect(state.transcriptWindowEnd).toBe(400)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

const giantSubagentModel = (childCount: number): Model => {
  const rootBlock = {
    _tag: "ToolCall" as const,
    id: "root-tool",
    name: "task",
    input: "{}",
    status: "complete" as const,
    presentation: {
      family: "agent" as const,
      action: "task",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    },
    detail: "delegated task",
    files: [],
  }
  const childBlocks = Array.from({ length: childCount }, (_, index) => ({
    _tag: "ToolCall" as const,
    id: `child-${index}`,
    name: "bash",
    input: "{}",
    status: "complete" as const,
    presentation: {
      family: "shell" as const,
      action: "shell",
      activeLabel: "Running",
      completeLabel: "Ran",
    },
    detail: `cmd-${index}`,
    files: [],
  }))
  const blocks = [rootBlock, ...childBlocks]
  const items = blocks.map((block, index) => ({
    _tag: "Block" as const,
    index,
    id: `block-${block.id}`,
    turnId: "turn-1",
    ...(index === 0 ? {} : { parentId: "root-tool" }),
  }))
  return {
    ...initial("/work", "high"),
    blocks,
    items,
    expandedRowKeys: ["tool:root-tool"],
    scrollFollow: false,
  }
}

const collapsedSubagentModel = (answerCount: number, childCount: number): Model => {
  const entries = Array.from({ length: answerCount }, (_, index) => ({
    role: "assistant" as const,
    text: `answer ${index}`,
    turnId: "turn-1",
  }))
  const rootBlock = {
    _tag: "ToolCall" as const,
    id: "root-tool",
    name: "task",
    input: "{}",
    status: "running" as const,
    presentation: {
      family: "agent" as const,
      action: "task",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    },
    detail: "delegated task",
    files: [],
  }
  const childBlocks = Array.from({ length: childCount }, (_, index) => ({
    _tag: "ToolCall" as const,
    id: `child-${index}`,
    name: "bash",
    input: "{}",
    status: "complete" as const,
    presentation: {
      family: "shell" as const,
      action: "shell",
      activeLabel: "Running",
      completeLabel: "Ran",
    },
    detail: `cmd-${index}`,
    files: [],
  }))
  const blocks = [rootBlock, ...childBlocks]
  const items = [
    ...entries.map((_, index) => ({
      _tag: "Entry" as const,
      index,
      id: `answer-${index}`,
      turnId: "turn-1",
    })),
    ...blocks.map((block, index) => ({
      _tag: "Block" as const,
      index,
      id: `block-${block.id}`,
      turnId: "turn-1",
      ...(index === 0 ? {} : { parentId: "root-tool" }),
    })),
  ]
  return {
    ...initial("/work", "high"),
    entries,
    blocks,
    items,
    expandedRowKeys: [],
    scrollFollow: true,
  }
}

test("bounded transcript keeps visible entries when a collapsed subagent overflows the entry budget", () => {
  const model = collapsedSubagentModel(30, maxMountedTranscriptEntries + 60)
  const bounded = boundedTranscriptModel(model)
  expect(bounded.items.length).toBeLessThanOrEqual(maxBoundedTranscriptItems)
  expect(bounded.items.some((item) => item._tag === "Entry")).toBe(true)
})

test("keeps the older transcript visible while a collapsed subagent streams children", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(collapsedSubagentModel(30, 150))
        yield* openTui(() => setup.flush())
        expect(setup.captureCharFrame()).toContain("answer 29")

        surface.update(collapsedSubagentModel(30, 260))
        yield* openTui(() => setup.flush())
        const frame = setup.captureCharFrame()
        expect(frame).toContain("Subagent working")
        expect(frame).toContain("answer 29")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps mounted renderables bounded inside one giant expanded subagent tree", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const model = giantSubagentModel(300)
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptScroll.scrollTop - 1)
        yield* openTui(() => setup.flush())
        const state = surface as unknown as { readonly transcriptChildren: ReadonlyArray<Renderable> }
        expect(state.transcriptChildren.length).toBeLessThanOrEqual(maxMountedTranscriptRows * 2)
        expect(state.transcriptChildren.length).toBeGreaterThan(0)
        const frame = setup.captureCharFrame()
        expect(frame).toContain("├ ✓ $ cmd-299")
        expect(frame).not.toContain("cmd-100 ")
        expect(boundedTranscriptModel(model).items.length).toBeLessThanOrEqual(maxMountedTranscriptEntries)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps the bounded suffix of an oversized tool tree when a trailing message arrives", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const giant = { ...giantSubagentModel(300), scrollFollow: true }
      const tail = { role: "assistant" as const, text: "TRAILING_MESSAGE", turnId: "turn-tail" }
      const grown: Model = {
        ...giant,
        entries: [...giant.entries, tail],
        items: [...giant.items, { _tag: "Entry", index: giant.entries.length, id: "tail-answer", turnId: "turn-tail" }],
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(giant)
        yield* openTui(() => setup.flush())
        expect(setup.captureCharFrame()).toContain("cmd-299")

        surface.update(grown)
        yield* openTui(() => setup.flush())
        const frame = setup.captureCharFrame()

        expect(frame).toContain("TRAILING_MESSAGE")
        expect(frame).toContain("cmd-299")
        expect(boundedTranscriptModel(grown).items.some((item) => item._tag === "Block")).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("grows the row window backward inside a giant tree and keeps the reading position", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const model = giantSubagentModel(300)
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptScroll.scrollTop - 1)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(0)
        yield* openTui(() => setup.flush())
        const firstBefore = Number(/cmd-(\d+)/.exec(setup.captureCharFrame())?.[1])
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        const state = surface as unknown as {
          readonly transcriptWindowEnd: number
          readonly transcriptChildren: ReadonlyArray<Renderable>
        }
        const firstAfter = Number(/cmd-(\d+)/.exec(setup.captureCharFrame())?.[1])
        expect(state.transcriptWindowEnd).toBeGreaterThan(0)
        expect(state.transcriptWindowEnd).toBeLessThan(301)
        expect(firstAfter).toBeLessThan(firstBefore)
        expect(state.transcriptChildren.length).toBeLessThanOrEqual(maxMountedTranscriptRows * 2)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps the scrollbar geometry consistent across backward row-window growth", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const model = giantSubagentModel(300)
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(0)
        yield* openTui(() => setup.flush())
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        expect(surface.transcriptScrollbar.scrollSize).toBe(surface.transcriptScroll.scrollHeight)
        expect(surface.transcriptScrollbar.viewportSize).toBeGreaterThanOrEqual(1)
        expect(surface.transcriptScrollbar.scrollPosition).toBe(surface.transcriptScroll.scrollTop)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("detaches on the first upward wheel event and stays detached through streaming updates", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 80 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      let model: Model = { ...initial("/work", "high"), busy: true, entries, items }
      const surface = new Surface(
        setup.renderer,
        {
          key: () => undefined,
          resize: () => undefined,
          scroll: (offset) => {
            model = update(model, { _tag: "ScrollMoved", offset })
            surface.update(model)
          },
          scrollFollow: () => {
            model = update(model, { _tag: "ScrollFollowed" })
            surface.update(model)
          },
        },
        { clock },
      )
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        yield* openTui(() => setup.mockMouse.scroll(10, 5, "up", { delayMs: 0 }))
        expect(model.scrollFollow).toBe(false)
        const detachedTop = surface.transcriptScroll.scrollTop

        for (let index = 80; index < 90; index += 1) {
          model = {
            ...model,
            entries: [...model.entries, { role: "assistant", text: `answer ${index}`, turnId: `turn-${index}` }],
            items: [...model.items, { _tag: "Entry", index, id: `answer-${index}`, turnId: `turn-${index}` }],
          }
          surface.update(model)
          yield* openTui(() => setup.renderOnce())
          expect(model.scrollFollow).toBe(false)
          expect(surface.transcriptScroll.scrollTop).toBe(detachedTop)
        }

        surface.transcriptScroll.scrollTo(
          surface.transcriptScroll.scrollHeight - surface.transcriptScroll.viewport.height - 2,
        )
        yield* openTui(() => setup.mockMouse.scroll(10, 5, "down", { delayMs: 0 }))
        clock.advance(16)
        yield* openTui(() => setup.flush())
        expect(model.scrollFollow).toBe(false)

        surface.transcriptScroll.scrollTo(surface.transcriptScroll.scrollHeight)
        for (let index = 0; index < 20; index += 1)
          yield* openTui(() => setup.mockMouse.scroll(10, 5, "down", { delayMs: 0 }))
        clock.advance(16)
        yield* openTui(() => setup.flush())
        expect(model.scrollFollow).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps every frame stable when wheel-down repeats at the followed transcript bottom", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 80 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      let model: Model = { ...initial("/work", "high"), entries, items }
      let scrollCalls = 0
      let followCalls = 0
      const frames: string[] = []
      const surface = new Surface(
        setup.renderer,
        {
          key: () => undefined,
          resize: () => undefined,
          scroll: (offset) => {
            scrollCalls += 1
            model = update(model, { _tag: "ScrollMoved", offset })
            surface.update(model)
          },
          scrollFollow: () => {
            followCalls += 1
            model = update(model, { _tag: "ScrollFollowed" })
            surface.update(model)
          },
        },
        { animate: false, clock },
      )
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(surface.transcriptScroll.scrollHeight)
        yield* openTui(() => setup.flush())
        const maxScrollTop = () => surface.transcriptScroll.scrollHeight - surface.transcriptScroll.viewport.height
        expect(surface.transcriptScroll.scrollTop).toBe(maxScrollTop())
        const baseline = setup.captureCharFrame()

        for (let index = 0; index < 8; index += 1) {
          yield* openTui(() => setup.mockMouse.scroll(10, 5, "down", { delayMs: 0 }))
          clock.advance(16)
          yield* openTui(() => setup.flush())
          expect(surface.transcriptScroll.scrollTop).toBe(maxScrollTop())
          frames.push(setup.captureCharFrame())
        }

        expect(frames).toHaveLength(8)
        for (const frame of frames) {
          expect(frame).toContain("answer 79")
          expect(frame).toBe(baseline)
        }
        expect(scrollCalls).toBe(0)
        expect(followCalls).toBe(0)
        expect(model.scrollFollow).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("does not report follow when a pending down-wheel timer settles at the followed bottom", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 80 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      let model: Model = { ...initial("/work", "high"), entries, items }
      let scrollCalls = 0
      let followCalls = 0
      const surface = new Surface(
        setup.renderer,
        {
          key: () => undefined,
          resize: () => undefined,
          scroll: (offset) => {
            scrollCalls += 1
            model = update(model, { _tag: "ScrollMoved", offset })
            surface.update(model)
          },
          scrollFollow: () => {
            followCalls += 1
            model = update(model, { _tag: "ScrollFollowed" })
            surface.update(model)
          },
        },
        { animate: false, clock },
      )
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(
          surface.transcriptScroll.scrollHeight - surface.transcriptScroll.viewport.height - 2,
        )
        yield* openTui(() => setup.mockMouse.scroll(10, 5, "down", { delayMs: 0 }))
        // Simulate native wheel movement reaching the tail before Rika's
        // coalesced timer observes settled geometry.
        surface.transcriptScroll.scrollTo(surface.transcriptScroll.scrollHeight)
        clock.advance(16)
        yield* openTui(() => setup.flush())

        expect(surface.transcriptScroll.scrollTop).toBe(
          surface.transcriptScroll.scrollHeight - surface.transcriptScroll.viewport.height,
        )
        expect(scrollCalls).toBe(0)
        expect(followCalls).toBe(0)
        expect(model.scrollFollow).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("does not follow the tail while a forward transcript-window anchor is pending", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 500 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      let model: Model = { ...initial("/work", "high"), entries, items }
      const surface = new Surface(
        setup.renderer,
        {
          key: () => undefined,
          resize: () => undefined,
          scroll: (offset) => {
            model = update(model, { _tag: "ScrollMoved", offset })
            surface.update(model)
          },
          scrollFollow: () => {
            model = update(model, { _tag: "ScrollFollowed" })
            surface.update(model)
          },
        },
        { clock },
      )
      const state = surface as unknown as {
        readonly transcriptWindowEnd: number
        readonly pendingTranscriptPosition:
          | {
              readonly _tag: "Anchor"
              readonly scrollBy: number
            }
          | undefined
      }
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptScroll.scrollTop - 1)
        yield* openTui(() => setup.flush())

        surface.transcriptScroll.scrollTo(0)
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        expect(state.transcriptWindowEnd).toBe(400)

        surface.transcriptScroll.scrollTo(surface.transcriptScroll.scrollHeight)
        setup.renderer.requestRender()
        yield* openTui(() => setup.flush())
        expect(model.scrollFollow).toBe(false)
        const firstBefore = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])

        yield* openTui(() => setup.mockMouse.scroll(10, 5, "down", { delayMs: 0 }))
        clock.advance(16)
        expect(state.transcriptWindowEnd).toBe(500)
        expect(state.pendingTranscriptPosition?._tag).toBe("Anchor")

        yield* openTui(() => setup.mockMouse.scroll(10, 5, "down", { delayMs: 0 }))
        const queuedDown = state.pendingTranscriptPosition?.scrollBy ?? 0
        yield* openTui(() => setup.mockMouse.scroll(10, 5, "up", { delayMs: 0 }))
        expect(model.scrollFollow).toBe(false)
        expect(state.pendingTranscriptPosition?.scrollBy).toBeLessThan(queuedDown)

        yield* openTui(() => setup.flush())
        const firstAfter = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        expect(model.scrollFollow).toBe(false)
        expect(firstAfter).toBeGreaterThan(firstBefore)
        expect(firstAfter).toBeLessThan(firstBefore + 10)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("does not turn an upward wheel correction into a forward window page", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 500 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      let model: Model = { ...initial("/work", "high"), entries, items }
      const surface = new Surface(
        setup.renderer,
        {
          key: () => undefined,
          resize: () => undefined,
          scroll: (offset) => {
            model = update(model, { _tag: "ScrollMoved", offset })
            surface.update(model)
          },
          scrollFollow: () => {
            model = update(model, { _tag: "ScrollFollowed" })
            surface.update(model)
          },
        },
        { clock },
      )
      const state = surface as unknown as { readonly transcriptWindowEnd: number }
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptScroll.scrollTop - 1)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(0)
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        expect(state.transcriptWindowEnd).toBe(400)

        surface.transcriptScroll.scrollTo(surface.transcriptScroll.scrollHeight)
        setup.renderer.requestRender()
        yield* openTui(() => setup.flush())
        const marker = /answer (\d+)/.exec(setup.captureCharFrame())?.[1]
        yield* openTui(() => setup.mockMouse.scroll(10, 5, "up", { delayMs: 0 }))
        yield* openTui(() => setup.mockMouse.scroll(10, 5, "down", { delayMs: 0 }))
        clock.advance(16)
        yield* openTui(() => setup.flush())

        expect(model.scrollFollow).toBe(false)
        expect(state.transcriptWindowEnd).toBe(400)
        expect(/answer (\d+)/.exec(setup.captureCharFrame())?.[1]).toBe(marker)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("coalesces rapid wheel offsets into one report per frame", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 400 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      let model: Model = { ...initial("/work", "high"), entries, items }
      const offsets = new Array<number>()
      const surface = new Surface(
        setup.renderer,
        {
          key: () => undefined,
          resize: () => undefined,
          scroll: (offset) => {
            offsets.push(offset)
            model = update(model, { _tag: "ScrollMoved", offset })
            surface.update(model)
          },
        },
        { clock },
      )
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        for (let index = 0; index < 20; index += 1)
          yield* openTui(() => setup.mockMouse.scroll(10, 5, "up", { delayMs: 0 }))

        expect(offsets).toHaveLength(1)
        clock.advance(15)
        expect(offsets).toHaveLength(1)
        clock.advance(1)
        expect(offsets).toHaveLength(2)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("moves the bounded transcript window forward by one measured page", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 500 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      const base: Model = { ...initial("/work", "high"), entries, items, scrollFollow: false }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(0)
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(surface.transcriptScroll.scrollHeight)
        setup.renderer.requestRender()
        yield* openTui(() => setup.flush())
        const firstBefore = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        setup.mockInput.pressKey("\x1b[6~")
        yield* openTui(() => setup.flush())
        const firstAfter = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        const state = surface as unknown as {
          readonly transcriptWindowEnd: number
          readonly transcriptAnchorScrollBy: number
        }
        expect(state.transcriptWindowEnd).toBe(500)
        expect(firstAfter).toBeGreaterThan(firstBefore)
        expect(firstAfter).toBeLessThan(firstBefore + 50)
        expect(state.transcriptAnchorScrollBy).toBe(0)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("coalesces repeated page keys until the transcript anchor frame", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 600 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      const state = surface as unknown as { readonly transcriptWindowEnd: number }
      try {
        surface.update({ ...initial("/work", "high"), entries, items, scrollFollow: false })
        yield* openTui(() => setup.flush())
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptScroll.scrollTop - 1)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(0)
        setup.renderer.requestRender()
        yield* openTui(() => setup.flush())
        setup.mockInput.pressKey("\x1b[5~")
        setup.mockInput.pressKey("\x1b[5~")
        expect(state.transcriptWindowEnd).toBe(500)
        yield* openTui(() => setup.flush())
        const firstAfterRepeatedUp = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        expect(firstAfterRepeatedUp).toBeGreaterThan(300)
        expect(firstAfterRepeatedUp).toBeLessThan(400)

        surface.transcriptScroll.scrollTo(0)
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        expect(state.transcriptWindowEnd).toBe(400)
        surface.transcriptScroll.scrollTo(surface.transcriptScroll.scrollHeight)
        setup.renderer.requestRender()
        yield* openTui(() => setup.flush())
        const firstBeforeRepeatedDown = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        setup.mockInput.pressKey("\x1b[6~")
        setup.mockInput.pressKey("\x1b[6~")
        expect(state.transcriptWindowEnd).toBe(500)
        yield* openTui(() => setup.flush())
        const firstAfterRepeatedDown = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        expect(firstAfterRepeatedDown).toBeGreaterThan(firstBeforeRepeatedDown)
        expect(firstAfterRepeatedDown).toBeLessThan(firstBeforeRepeatedDown + 50)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("preserves a pending prepend anchor through an intervening composer update", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 100 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      const base: Model = { ...initial("/work", "high"), entries, items, scrollFollow: false }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptScroll.scrollTop - 1)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(40)
        const firstBefore = /answer (\d+)/.exec(setup.captureCharFrame())?.[1]
        const older = Array.from({ length: 50 }, (_, index) => ({
          role: "assistant" as const,
          text: `older ${index}`,
          turnId: `older-${index}`,
        }))
        const prepended: Model = {
          ...base,
          entries: [...older, ...entries],
          items: [
            ...older.map((_, index) => ({
              _tag: "Entry" as const,
              index,
              id: `older-${index}`,
              turnId: `older-${index}`,
            })),
            ...items.map((item) => Object.assign({}, item, { index: item.index + older.length })),
          ],
        }
        surface.update(prepended, true)
        surface.update({ ...prepended, input: "x", cursor: 1 })
        yield* openTui(() => setup.flush())
        expect(/answer (\d+)/.exec(setup.captureCharFrame())?.[1]).toBe(firstBefore)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps the nearest transcript content in view when markdown reflows", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 200, height: 30 }))
      const entries = Array.from({ length: 80 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index} ${"word ".repeat(40)}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      let model: Model = {
        ...initial("/work", "high"),
        width: 200,
        height: 30,
        entries,
        items,
        scrollFollow: false,
      }
      const geometry = new Array<number>()
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
        scrollGeometry: (offset) => geometry.push(offset),
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptScroll.scrollTop - 1)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(80)
        setup.renderer.requestRender()
        yield* openTui(() => setup.flush())
        model = { ...model, scrollOffset: surface.transcriptScroll.scrollTop }
        const before = /answer (\d+)/.exec(setup.captureCharFrame())?.[1]

        surface.update(update(model, { _tag: "Resized", width: 100, height: 30 }))
        yield* openTui(() => setup.flush())

        expect(/answer (\d+)/.exec(setup.captureCharFrame())?.[1]).toBe(before)
        expect(geometry.at(-1)).toBe(surface.transcriptScroll.scrollTop)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps a followed transcript pinned to the bottom after markdown reflows", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 200, height: 30 }))
      const entries = Array.from({ length: 80 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index} ${"word ".repeat(40)}`,
        turnId: `turn-${index}`,
      }))
      const model: Model = {
        ...initial("/work", "high"),
        width: 200,
        height: 30,
        entries,
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.update(update(model, { _tag: "Resized", width: 100, height: 30 }))
        yield* openTui(() => setup.flush())

        expect(surface.transcriptScroll.scrollTop).toBeGreaterThanOrEqual(
          surface.transcriptScroll.scrollHeight - surface.transcriptScroll.viewport.height - 1,
        )
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("suppresses programmatic scrollbar feedback and queued work after teardown", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const offsets = new Array<number>()
      const entries = Array.from({ length: 300 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
        scroll: (offset) => offsets.push(offset),
      })
      try {
        surface.update({ ...initial("/work", "high"), entries, items, scrollFollow: false })
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(20)
        surface.transcriptScrollbar.scrollPosition = 10
        surface.destroy()
        yield* Effect.yieldNow
        expect(offsets).toEqual([])
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps a detached transcript window stable when live entries arrive", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 500 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      const base: Model = { ...initial("/work", "high"), entries, items, scrollFollow: false }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptScroll.scrollTop - 1)
        yield* openTui(() => setup.flush())
        const firstBefore = /answer (\d+)/.exec(setup.captureCharFrame())?.[1]
        surface.update({
          ...base,
          entries: [...entries, { role: "assistant", text: "answer 500", turnId: "turn-500" }],
          items: [...items, { _tag: "Entry", index: 500, id: "answer-500", turnId: "turn-500" }],
        })
        yield* openTui(() => setup.flush())
        expect(/answer (\d+)/.exec(setup.captureCharFrame())?.[1]).toBe(firstBefore)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("preserves a detached window when prepended history and live appends share one update", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 500 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      const base: Model = { ...initial("/work", "high"), entries, items }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      const state = surface as unknown as { readonly transcriptWindowEnd: number }
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptScroll.scrollTop - 1)
        yield* openTui(() => setup.flush())
        const marker = /answer (\d+)/.exec(setup.captureCharFrame())?.[1]
        const older = Array.from({ length: 50 }, (_, index) => ({
          role: "assistant" as const,
          text: `older ${index}`,
          turnId: `older-${index}`,
        }))
        const live = Array.from({ length: 220 }, (_, index) => ({
          role: "assistant" as const,
          text: `live ${index}`,
          turnId: `live-${index}`,
        }))
        const combinedEntries = [...older, ...entries, ...live]
        const combinedItems = [
          ...older.map((entry, index) => ({
            _tag: "Entry" as const,
            index,
            id: entry.turnId,
            turnId: entry.turnId,
          })),
          ...items.map((item) => ({
            _tag: item._tag,
            index: item.index + older.length,
            id: item.id,
            turnId: item.turnId,
          })),
          ...live.map((entry, index) => ({
            _tag: "Entry" as const,
            index: older.length + entries.length + index,
            id: entry.turnId,
            turnId: entry.turnId,
          })),
        ]

        surface.update({ ...base, entries: combinedEntries, items: combinedItems }, true)
        yield* openTui(() => setup.flush())

        expect(state.transcriptWindowEnd).toBe(550)
        expect(/answer (\d+)/.exec(setup.captureCharFrame())?.[1]).toBe(marker)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("End re-engages physical following and invalidates a queued scrollbar report", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 100 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      const offsets = new Array<number>()
      let followed = 0
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
        scroll: (offset) => offsets.push(offset),
        scrollFollow: () => {
          followed += 1
        },
      })
      try {
        surface.update({ ...initial("/work", "high"), entries, items })
        yield* openTui(() => setup.flush())
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptScroll.scrollTop - 20)
        setup.mockInput.pressKey("\x1b[F")
        yield* openTui(() => setup.flush())

        expect(followed).toBe(1)
        expect(offsets).toEqual([])
        expect(surface.transcriptScroll.scrollTop).toBeGreaterThanOrEqual(
          surface.transcriptScroll.scrollHeight - surface.transcriptScroll.viewport.height - 1,
        )
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("defers the scrollbar detach report instead of reporting inside onChange", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const scrolls = new Array<number>()
      const entries = Array.from({ length: 300 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      let model: Model = { ...initial("/work", "high"), entries, items }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
        scroll: (offset) => {
          scrolls.push(offset)
          model = update(model, { _tag: "ScrollMoved", offset })
          surface.update(model)
        },
        scrollFollow: () => {
          model = update(model, { _tag: "ScrollFollowed" })
          surface.update(model)
        },
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        // A user drag away from the bottom fires the scrollbar onChange. The report
        // must be queued, not run synchronously inside onChange (no re-entrant update).
        surface.transcriptScrollbar.scrollPosition = 3
        expect(scrolls).toEqual([])
        yield* openTui(() => setup.flush())
        expect(scrolls.length).toBeGreaterThan(0)
        expect(model.scrollFollow).toBe(false)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("mounts entries appended below a detached transcript that fits the mount budget", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 40 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      const base: Model = { ...initial("/work", "high"), entries, items, scrollFollow: false }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      const state = surface as unknown as { readonly transcriptWindowEnd: number }
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(0)
        setup.renderer.requestRender()
        yield* openTui(() => setup.flush())
        const firstBefore = /answer (\d+)/.exec(setup.captureCharFrame())?.[1]
        const heightBefore = surface.transcriptScroll.scrollHeight

        const grownEntries = [
          ...entries,
          ...Array.from({ length: 20 }, (_, index) => ({
            role: "assistant" as const,
            text: `answer ${40 + index}`,
            turnId: `turn-${40 + index}`,
          })),
        ]
        const grownItems = grownEntries.map((_, index) => ({
          _tag: "Entry" as const,
          index,
          id: `answer-${index}`,
          turnId: `turn-${index}`,
        }))
        surface.update({ ...base, entries: grownEntries, items: grownItems })
        yield* openTui(() => setup.flush())

        // The appended entries mount below the viewport: the window tracks the tail
        // and the content grows, while the detached reading position stays put.
        expect(state.transcriptWindowEnd).toBe(60)
        expect(surface.transcriptScroll.scrollHeight).toBeGreaterThan(heightBefore)
        expect(/answer (\d+)/.exec(setup.captureCharFrame())?.[1]).toBe(firstBefore)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("reports prepend anchor geometry without requesting another page", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const requested = new Array<number>()
      const geometry = new Array<number>()
      const entries = Array.from({ length: 200 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      const base: Model = { ...initial("/work", "high"), entries, items, scrollFollow: false }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
        scroll: (offset) => requested.push(offset),
        scrollGeometry: (offset) => geometry.push(offset),
      })
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptScroll.scrollTop - 1)
        yield* openTui(() => setup.flush())
        yield* Effect.yieldNow
        requested.length = 0
        const older = Array.from({ length: 50 }, (_, index) => ({
          role: "assistant" as const,
          text: `older ${index}`,
          turnId: `older-${index}`,
        }))
        surface.update(
          {
            ...base,
            entries: [...older, ...entries],
            items: [
              ...older.map((_, index) => ({
                _tag: "Entry" as const,
                index,
                id: `older-${index}`,
                turnId: `older-${index}`,
              })),
              ...items.map((item) => Object.assign({}, item, { index: item.index + older.length })),
            ],
          },
          true,
        )
        yield* openTui(() => setup.flush())
        expect(requested).toEqual([])
        expect(geometry).toHaveLength(1)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

for (const panel of ["changed", "workspace"] as const) {
  test(`keeps composer updates bounded with a large ${panel} files sidebar`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 40 }))
        const paths = Array.from(
          { length: 10_000 },
          (_, index) => `src/feature-${Math.floor(index / 20)}/file-${index}.ts`,
        )
        const initialModel = initial("/work", "high")
        const base: Model = {
          ...initialModel,
          width: 120,
          height: 40,
          entries: [{ role: "assistant", text: "settled response" }],
          ...(panel === "changed"
            ? {
                changedFilesOpen: true,
                changedFiles: ready(paths.map((path) => ({ path, status: "M", added: 1, removed: 0 }))),
              }
            : {
                workspaceFilesOpen: true,
                filePicker: { ...initialModel.filePicker, items: ready(paths) },
              }),
        }
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        try {
          surface.update(base)
          yield* openTui(() => setup.flush())
          const state = surface as unknown as {
            readonly changedRows: ReadonlyArray<unknown>
            readonly transcriptChildren: ReadonlyArray<Renderable>
          }
          const sidebarRows = state.changedRows
          expect(surface.changedFilesBox.scrollHeight).toBe(sidebarRows.length)
          expect(surface.changedFilesBox.content.height).toBeLessThanOrEqual(
            surface.changedFilesBox.viewport.height + 1,
          )
          const transcriptChildren = [...state.transcriptChildren]
          for (let index = 0; index < 20; index += 1)
            surface.update({ ...base, input: `next ${index}`, cursor: `next ${index}`.length })

          expect(state.changedRows).toBe(sidebarRows)
          expect(state.transcriptChildren.every((child, index) => child === transcriptChildren[index])).toBe(true)
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

test(
  "rebuilds the large changed-files sidebar per set change, not per streaming frame",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 40 }))
        const paths = Array.from(
          { length: 10_000 },
          (_, index) => `src/feature-${Math.floor(index / 20)}/file-${index}.ts`,
        )
        const files = (revision: number) =>
          ready(paths.map((path) => ({ path, status: "M", added: revision, removed: 0 })))
        const base: Model = {
          ...initial("/work", "high"),
          width: 120,
          height: 40,
          changedFilesOpen: true,
          changedFiles: files(1),
        }
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        try {
          surface.update(base)
          yield* openTui(() => setup.flush())
          const state = surface as unknown as { readonly changedRows: ReadonlyArray<unknown> }
          const boundedWindow = () =>
            expect(surface.changedFilesBox.content.height).toBeLessThanOrEqual(
              surface.changedFilesBox.viewport.height + 1,
            )
          boundedWindow()
          let rebuilds = 0
          let previousRows = state.changedRows
          let model = base
          for (let tick = 0; tick < 4; tick += 1) {
            for (let frame = 0; frame < 5; frame += 1) {
              model = Object.assign({}, model, {
                entries: [{ role: "assistant", text: `streaming ${tick}:${frame}` }],
              })
              surface.update(model)
              if (state.changedRows !== previousRows) {
                rebuilds += 1
                previousRows = state.changedRows
              }
            }
            model = { ...model, changedFiles: files(tick + 2) }
            surface.update(model)
            if (state.changedRows !== previousRows) {
              rebuilds += 1
              previousRows = state.changedRows
            }
            boundedWindow()
          }
          expect(rebuilds).toBe(4)
          expect(surface.changedFilesBox.scrollHeight).toBe(state.changedRows.length)
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ),
  30_000,
)

test("expands the queue box to fit a wrapped single-line queued prompt joined to the composer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 40, height: 24 }))
      let model: Model = { ...initial("/work", "high"), width: 40, height: 24 }
      model = replaceQueue(model, [{ id: "q1", prompt: "x".repeat(120) }])
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        expect(surface.queueBox.visible).toBe(true)
        expect(surface.queueBox.height).toBeGreaterThanOrEqual(6)
        expect(surface.queueRightJoint.top).toBe(model.height - surface.inputBox.height)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("renders autonomous welcome animation frames while otherwise event-driven", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24, clock }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { clock })
      try {
        surface.update({ ...initial("/work", "high"), width: 80, height: 24 })
        yield* openTui(() => setup.renderOnce())
        const first = setup.captureCharFrame()
        clock.advance(100)
        yield* openTui(() => setup.renderOnce())
        const second = setup.captureCharFrame()
        expect(first).toContain("Welcome to Rika")
        expect(second).toContain("Welcome to Rika")
        expect(second).not.toBe(first)
        expect(setup.renderer.isRunning).toBe(false)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("ticks Amp status and running-tool spinners every 200ms without rebuilding transcript bodies", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30, clock }))
      const running = {
        _tag: "ToolCall" as const,
        id: "long-running",
        name: "bash",
        input: '{"command":"sleep 5"}',
        status: "running" as const,
        presentation: {
          family: "shell" as const,
          action: "command",
          activeLabel: "Running",
          completeLabel: "Ran",
        },
        detail: "sleep 5",
        output: "still running",
        files: [],
      }
      const model: Model = {
        ...initial("/work", "high"),
        width: 100,
        height: 30,
        busy: true,
        activity: { _tag: "Thinking", bytes: 20 },
        blocks: [running],
        items: [{ _tag: "Block", index: 0, id: "tool:long-running", turnId: "turn" }],
        expandedRowKeys: ["tool:long-running"],
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { clock })
      const records = () =>
        (
          surface as unknown as {
            readonly transcriptRecords: ReadonlyMap<
              string,
              { readonly renderable: { readonly content: { readonly chunks: ReadonlyArray<{ text: string }> } } }
            >
          }
        ).transcriptRecords
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const body = records().get("tool:long-running:body")!.renderable
        const firstBodyContent = body.content
        expect(styledTextValue(surface.statusLabel.content)).toContain("∼ Thinking 5 tok")
        expect(styledTextValue(records().get("tool:long-running:header")!.renderable.content)).toContain("⠭")

        clock.advance(199)
        expect(styledTextValue(surface.statusLabel.content)).toContain("∼ Thinking 5 tok")
        expect(styledTextValue(records().get("tool:long-running:header")!.renderable.content)).toContain("⠭")
        clock.advance(1)
        expect(styledTextValue(surface.statusLabel.content)).toContain("≈ Thinking 5 tok")
        expect(styledTextValue(records().get("tool:long-running:header")!.renderable.content)).toMatch(/[⠀-⣿] sleep 5/u)
        expect(body.content).toBe(firstBodyContent)

        clock.advance(200)
        expect(styledTextValue(surface.statusLabel.content)).toContain("≋ Thinking 5 tok")
        clock.advance(200)
        expect(styledTextValue(surface.statusLabel.content)).toContain("≈ Thinking 5 tok")
        clock.advance(200)
        expect(styledTextValue(surface.statusLabel.content)).toContain("∼ Thinking 5 tok")
        clock.advance(200)
        expect(styledTextValue(surface.statusLabel.content)).toContain("∼ Thinking 5 tok")
        expect(body.content).toBe(firstBodyContent)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("does not animate a cancelled subagent again when a new turn starts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30, clock }))
      const parent = {
        _tag: "ToolCall" as const,
        id: "cancelled-parent",
        name: "task",
        input: "{}",
        status: "cancelled" as const,
        presentation: {
          family: "agent" as const,
          action: "task",
          activeLabel: "Subagent working",
          completeLabel: "Subagent finished",
        },
        detail: "Run the checks",
        files: [],
      }
      const cancelled: Model = {
        ...initial("/work", "high"),
        width: 100,
        height: 30,
        blocks: [parent],
        items: [{ _tag: "Block", index: 0, id: "tool:cancelled-parent", turnId: "old-turn" }],
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { clock })
      const header = () =>
        styledTextValue(
          (
            surface as unknown as {
              readonly transcriptRecords: ReadonlyMap<
                string,
                { readonly renderable: { readonly content: { readonly chunks: ReadonlyArray<{ text: string }> } } }
              >
            }
          ).transcriptRecords.get("tool:cancelled-parent:header")!.renderable.content,
        )
      try {
        surface.update(cancelled)
        yield* openTui(() => setup.renderOnce())
        expect(header()).toContain("⊘ Subagent cancelled ▸")

        surface.update({
          ...cancelled,
          busy: true,
          activeTurnId: "new-turn",
          activity: { _tag: "Waiting" },
          entries: [{ role: "user", text: "continue", turnId: "new-turn" }],
          items: [...cancelled.items, { _tag: "Entry", index: 0, id: "turn:new-turn:user", turnId: "new-turn" }],
        })
        yield* openTui(() => setup.renderOnce())
        const before = header()
        clock.advance(600)
        const after = header()

        expect(after).toBe(before)
        expect(after).toContain("⊘ Subagent cancelled ▸")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps the status spinner moving across a tool-result lull without feed events", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30, clock }))
      let model: Model = { ...initial("/work", "high"), width: 100, height: 30, busy: true }
      model = update(model, {
        _tag: "EventReplayed",
        event: {
          id: "tool-call",
          cursor: "1",
          turnId: "turn",
          block: streamingShell("tool-lull"),
        },
      })
      model = update(model, {
        _tag: "EventReplayed",
        event: {
          id: "tool-result",
          cursor: "2",
          turnId: "turn",
          block: { _tag: "ToolResult", id: "tool-lull", output: "done", failed: false },
        },
      })
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { clock })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        expect(styledTextValue(surface.statusLabel.content)).toContain("∼ Waiting")
        clock.advance(200)
        expect(styledTextValue(surface.statusLabel.content)).toContain("≈ Waiting")
        clock.advance(200)
        expect(styledTextValue(surface.statusLabel.content)).toContain("≋ Waiting")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("toggles expandable transcript headers without selecting them and keeps bodies selectable", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model: Model = {
        ...initial("/work", "high"),
        input: "draft remains editable",
        cursor: "draft remains editable".length,
        blocks: [
          {
            _tag: "ToolCall",
            id: "shell-selection",
            name: "bash",
            input: '{"command":"printf transcript-output"}',
            status: "complete",
            presentation: {
              family: "shell",
              action: "shell",
              activeLabel: "Running",
              completeLabel: "Ran",
            },
            detail: "printf transcript-output",
            output: "transcript-output",
            files: [],
          },
        ],
        items: [{ _tag: "Block", index: 0, id: "shell-selection", turnId: "turn-selection" }],
      }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        clickToggle: (unit) => {
          model = update(model, { _tag: "DetailToggled", id: unit })
          surface.update(model)
        },
        resize: () => undefined,
      })
      const records = () =>
        (
          surface as unknown as {
            readonly transcriptRecords: ReadonlyMap<
              string,
              {
                readonly renderable: {
                  readonly screenX: number
                  readonly screenY: number
                  readonly selectable: boolean
                  readonly content: {
                    readonly chunks: ReadonlyArray<{
                      readonly text: string
                      readonly fg?: { readonly equals: (color: unknown) => boolean }
                    }>
                  }
                }
              }
            >
          }
        ).transcriptRecords
      const commandIsBlue = () =>
        records()
          .get("tool:shell-selection:header")!
          .renderable.content.chunks.some(
            (chunk) => chunk.text.includes("printf transcript-output") && chunk.fg?.equals(colors.blue) === true,
          )
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState()).toMatchObject({ visible: true, blinking: true })
        expect(commandIsBlue()).toBe(false)
        const header = records().get("tool:shell-selection:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(header.screenX + 2, header.screenY))
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState()).toMatchObject({ visible: true, blinking: true })
        expect(model.expandedRowKeys).toContain("tool:shell-selection")
        expect(model.detailSelection).toBeUndefined()
        expect(commandIsBlue()).toBe(false)
        expect(setup.renderer.getSelection()).toBeNull()

        const body = records().get("tool:shell-selection:body")!.renderable
        yield* openTui(() => setup.mockMouse.drag(body.screenX, body.screenY, body.screenX + 20, body.screenY))
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState()).toMatchObject({ visible: true, blinking: true })
        expect(setup.renderer.getSelection()?.getSelectedText()).toContain("transcript-output")
        setup.renderer.clearSelection()

        const expandedHeader = records().get("tool:shell-selection:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(expandedHeader.screenX + 2, expandedHeader.screenY))
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState()).toMatchObject({ visible: true, blinking: true })
        expect(model.expandedRowKeys).not.toContain("tool:shell-selection")
        expect(commandIsBlue()).toBe(false)
        expect(setup.renderer.getSelection()).toBeNull()

        model = update(model, {
          _tag: "KeyPressed",
          key: {
            name: "tab",
            ctrl: false,
            alt: false,
            meta: false,
            shift: false,
            sequence: "",
            eventType: "press",
          },
        })
        surface.update(model)
        yield* openTui(() => setup.flush())
        expect(model.detailSelection).toBe("tool:shell-selection")
        expect(commandIsBlue()).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("updates an existing streaming transcript header when it becomes expandable", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model: Model = {
        ...initial("/work", "high"),
        blocks: [streamingShell("first", "first-output"), streamingShell("streaming")],
        items: [
          { _tag: "Block", index: 0, id: "first", turnId: "turn-streaming" },
          { _tag: "Block", index: 1, id: "streaming", turnId: "turn-streaming" },
        ],
        expandedRowKeys: ["tool:first"],
      }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        clickToggle: (unit) => {
          model = update(model, { _tag: "DetailToggled", id: unit })
          surface.update(model)
        },
        resize: () => undefined,
      })
      const records = () =>
        (
          surface as unknown as {
            readonly transcriptRecords: ReadonlyMap<
              string,
              {
                readonly renderable: {
                  readonly screenX: number
                  readonly screenY: number
                  readonly selectable: boolean
                }
              }
            >
          }
        ).transcriptRecords
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        const before = records().get("tool-child:streaming:header")!.renderable
        expect(before.selectable).toBe(true)

        model = { ...model, blocks: [model.blocks[0]!, streamingShell("streaming", "late-output")] }
        surface.update(model)
        yield* openTui(() => setup.flush())
        const after = records().get("tool-child:streaming:header")!.renderable
        expect(after).toBe(before)
        expect(after.selectable).toBe(false)
        yield* openTui(() => setup.mockMouse.click(after.screenX + 4, after.screenY))
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).toContain("tool-child:streaming")
        expect(setup.renderer.getSelection()).toBeNull()
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("renders a subagent tool tree and expands each child independently", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 32 }))
      const presentation = {
        agent: {
          family: "agent" as const,
          action: "oracle",
          activeLabel: "Oracle exploring",
          completeLabel: "Oracle has spoken",
        },
        explore: {
          family: "explore" as const,
          action: "read",
          activeLabel: "Exploring",
          completeLabel: "Explored",
          counter: "file" as const,
        },
        shell: {
          family: "shell" as const,
          action: "command",
          activeLabel: "Running",
          completeLabel: "Ran",
        },
      }
      let model: Model = {
        ...initial("/work", "high"),
        width: 80,
        height: 32,
        entries: [
          {
            role: "assistant",
            text: "## Review complete\n\n**No defects found.**",
            turnId: "child:oracle",
          },
        ],
        blocks: [
          {
            _tag: "ToolCall",
            id: "oracle-parent",
            name: "oracle",
            input: '{"prompt":"Review the code"}',
            status: "complete",
            presentation: presentation.agent,
            detail: "Review the code",
            childId: "child:oracle",
            files: [],
          },
          {
            _tag: "ToolCall",
            id: "child-read",
            name: "read",
            input: '{"path":"src/a.ts","offset":2,"limit":3}',
            output: "read child output",
            status: "complete",
            presentation: presentation.explore,
            detail: "src/a.ts L2-4",
            files: [],
          },
          {
            _tag: "ToolCall",
            id: "child-agent",
            name: "task",
            input: '{"prompt":"Explore packages"}',
            status: "complete",
            presentation: {
              family: "agent",
              action: "task",
              activeLabel: "Subagent working",
              completeLabel: "Subagent finished",
            },
            detail:
              "Read-only explore packages/config, extensions, and tools. Report concise public responsibilities with source-file evidence.",
            files: [],
          },
          {
            _tag: "ToolCall",
            id: "child-shell",
            name: "bash",
            input: '{"command":"bun test"}',
            output: "shell child output",
            status: "complete",
            presentation: presentation.shell,
            detail: "bun test",
            files: [],
          },
        ],
        items: [
          { _tag: "Block", index: 0, id: "tool:oracle-parent", turnId: "turn" },
          { _tag: "Block", index: 1, id: "tool:child-read", turnId: "child:oracle", parentId: "oracle-parent" },
          { _tag: "Block", index: 2, id: "tool:child-agent", turnId: "child:oracle", parentId: "oracle-parent" },
          { _tag: "Block", index: 3, id: "tool:child-shell", turnId: "child:oracle", parentId: "oracle-parent" },
          {
            _tag: "Entry",
            index: 0,
            id: "assistant:child:oracle:0",
            turnId: "child:oracle",
            parentId: "oracle-parent",
          },
        ],
        expandedRowKeys: ["tool:oracle-parent"],
      }
      const opened: Array<{ readonly path: string; readonly line?: number; readonly column?: number }> = []
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        openPath: (target) => opened.push(target),
        clickToggle: (unit) => {
          model = update(model, { _tag: "DetailToggled", id: unit })
          surface.update(model)
        },
        resize: () => undefined,
      })
      const records = () =>
        (
          surface as unknown as {
            readonly transcriptRecords: ReadonlyMap<
              string,
              {
                readonly renderable: {
                  readonly content: {
                    readonly chunks: ReadonlyArray<{
                      readonly text: string
                      readonly fg?: { readonly equals: (other: unknown) => boolean }
                    }>
                  }
                  readonly screenX: number
                  readonly screenY: number
                }
              }
            >
          }
        ).transcriptRecords
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        const collapsed = setup.captureCharFrame()
        expect(collapsed).toContain("Oracle has spoken ▾")
        expect(collapsed).toContain("Review the code")
        expect(collapsed).toContain("├ ✓ Read src/a.ts L2-4 ▸")
        expect(collapsed).toContain("├ ✓ Subagent finished ▸")
        expect(collapsed).toContain("├ ✓ $ bun test ▸")
        expect(collapsed).toContain("Review complete")
        expect(collapsed).toContain("No defects found.")
        expect(collapsed).not.toContain("##")
        expect(collapsed).not.toContain("**")
        expect(collapsed).not.toContain("read child output")
        expect(collapsed).not.toContain("shell child output")
        const oracleChunks = records().get("tool:oracle-parent:header")!.renderable.content.chunks
        expect(oracleChunks.find((chunk) => chunk.text.includes("Oracle"))!.fg?.equals(colors.text)).toBe(true)
        expect(oracleChunks.find((chunk) => chunk.text === " has spoken")!.fg?.equals(colors.muted)).toBe(true)
        const readChunks = records().get("tool:child-read:header")!.renderable.content.chunks
        expect(readChunks.find((chunk) => chunk.text.includes("Read"))!.fg?.equals(colors.text)).toBe(true)
        expect(readChunks.find((chunk) => chunk.text === " src/a.ts L2-4")!.fg?.equals(colors.muted)).toBe(true)
        const collapsedLines = collapsed.split("\n")
        const shellRow = collapsedLines.findIndex((line) => line.includes("$ bun test"))
        const responseRow = collapsedLines.findIndex((line) => line.includes("Review complete"))
        expect(responseRow).toBe(shellRow + 3)
        expect(collapsedLines[shellRow + 1]!.trim()).toBe("│")
        expect(collapsedLines[shellRow + 2]!.trim()).toBe("│")
        expect(collapsedLines[responseRow]!.indexOf("Review complete")).toBe(
          collapsedLines[shellRow]!.indexOf("$ bun test"),
        )

        const agent = records().get("tool:child-agent:header")!.renderable
        const agentLines = styledTextValue(agent.content).split("\n")
        expect(agentLines).toHaveLength(1)
        const markerLine = agentLines[0]!
        yield* openTui(() =>
          setup.mockMouse.click(agent.screenX + markerLine.indexOf("▸"), agent.screenY + agentLines.length - 1),
        )
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).toContain("tool:child-agent")

        const read = records().get("tool:child-read:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(read.screenX + 4, read.screenY))
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).toContain("tool:child-read")
        expect(setup.captureCharFrame()).toContain("read child output")
        expect(setup.captureCharFrame()).not.toContain("shell child output")

        yield* openTui(() => setup.mockMouse.click(read.screenX + 12, read.screenY))
        expect(opened).toEqual([{ path: "src/a.ts", line: 3, column: 1 }])
        expect(model.expandedRowKeys).toContain("tool:child-read")

        const shell = records().get("tool:child-shell:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(shell.screenX + 4, shell.screenY))
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).toContain("tool:child-shell")
        expect(setup.captureCharFrame()).toContain("shell child output")

        const expandedRead = records().get("tool:child-read:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(expandedRead.screenX + 4, expandedRead.screenY))
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).not.toContain("tool:child-read")
        expect(setup.captureCharFrame()).not.toContain("read child output")
        expect(setup.captureCharFrame()).toContain("shell child output")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("drags the composer top border through OpenTUI mouse routing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const pointers: Array<string> = []
      ;(setup.renderer as unknown as { realStdoutWrite?: undefined }).realStdoutWrite = undefined
      setup.renderer.setMousePointer = (style) => pointers.push(style)
      let model = initial("/work", "high")
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        composerResize: (height) => {
          model = update(model, { _tag: "ComposerHeightChanged", height })
          surface.update(model)
        },
        resize: () => undefined,
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        expect(surface.inputBox.height).toBe(5)
        expect(model.input).toBe("")
        yield* openTui(() => setup.mockMouse.moveTo(20, surface.inputBox.y))
        expect(pointers.at(-1)).toBe("move")
        yield* openTui(() => setup.mockMouse.drag(20, surface.inputBox.y, 20, surface.inputBox.y - 4))
        yield* openTui(() => setup.renderOnce())
        expect(model.composerHeight).toBe(9)
        expect(surface.inputBox.height).toBe(9)
        yield* openTui(() => setup.mockMouse.moveTo(20, surface.inputBox.y + 1))
        expect(pointers.at(-1)).toBe("default")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps the welcome mark renderable stable while typing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      let model: Model = { ...initial("/work", "high"), width: 100, height: 30 }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const transcriptChildren = () =>
          (surface as unknown as { readonly transcriptChildren: ReadonlyArray<{ readonly content: unknown }> })
            .transcriptChildren
        const before = transcriptChildren()[0]
        const beforeContent = before?.content
        expect(before).toBeDefined()
        for (const character of "hello world") {
          model = update(model, {
            _tag: "KeyPressed",
            key: {
              name: character,
              ctrl: false,
              alt: false,
              meta: false,
              shift: false,
              sequence: character,
              eventType: "press",
            },
          })
          surface.update(model)
        }
        yield* openTui(() => setup.renderOnce())
        expect(transcriptChildren()[0]).toBe(before)
        expect(transcriptChildren()[0]?.content).toBe(beforeContent)
        expect(setup.captureCharFrame()).toContain("Welcome to Rika")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("drags the sidebar left border to resize it through OpenTUI mouse routing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 30 }))
      const pointers: Array<string> = []
      ;(setup.renderer as unknown as { realStdoutWrite?: undefined }).realStdoutWrite = undefined
      setup.renderer.setMousePointer = (style) => pointers.push(style)
      let model: Model = {
        ...initial("/work", "high"),
        width: 120,
        height: 30,
        changedFilesOpen: true,
        changedFiles: ready([
          { path: "src/a-really-long-file-name-that-truncates.ts", status: "M", added: 1, removed: 0 },
        ]),
      }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        sidebarResize: (width) => {
          model = update(model, { _tag: "SidebarWidthChanged", width })
          surface.update(model)
        },
        resize: () => undefined,
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        expect(surface.changedFilesBox.visible).toBe(true)
        const borderX = surface.changedFilesBox.x
        yield* openTui(() => setup.mockMouse.moveTo(borderX, 10))
        expect(pointers.at(-1)).toBe("move")
        const narrowFrame = setup.captureCharFrame()
        expect(narrowFrame).not.toContain("a-really-long-file-name-that-truncates.ts")
        yield* openTui(() => setup.mockMouse.drag(borderX, 10, borderX - 24, 10))
        yield* openTui(() => setup.renderOnce())
        expect(model.sidebarWidth).toBe(60)
        expect(surface.changedFilesBox.width).toBe(58)
        const frame = setup.captureCharFrame()
        expect(frame).toContain("Changed files (1)")
        expect(frame).toContain("a-really-long-file-name-that-truncates.ts")
        surface.changedFilesBox.focus()
        yield* openTui(() => setup.renderOnce())
        const focusBlue = setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .some((span) => span.text.includes("│") && span.fg.toInts().join(",") === "0,170,255,255")
        expect(focusBlue).toBe(false)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("routes bracketed multiline paste through the adapter as collapsed text", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model = initial("/work", "high")
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        paste: (text) => {
          model = insertText(model, text)
          surface.update(model)
        },
        resize: () => undefined,
      })
      try {
        const pasted = "first line\nsecond [literal] line\nthird line"
        surface.update(model)
        yield* openTui(() => setup.mockInput.pasteBracketedText(pasted))
        expect(model.input).toHaveLength(1)
        expect(model.pastedText[0]?.type === "text" ? model.pastedText[0].value : undefined).toBe(pasted)
        expect(model.pastedText[0]?.label).toBe("[Pasted text #1 +3 lines]")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("copies trimmed selected transcript text through OSC52", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const copied: Array<string> = []
      setup.renderer.copyToClipboardOSC52 = (text: string) => {
        copied.push(text)
        return true
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        setup.renderer.emit(CliRenderEvents.SELECTION, { getSelectedText: () => "selected transcript  \n" })
        expect(copied).toEqual(["selected transcript"])
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("loads the workspace file tree with Opt+T and keeps it separate from changed files", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 24 }))
      let model = update(initial("/work", "high"), {
        _tag: "FilesReplaced",
        files: ["apps/rika/src/main.ts", "packages/tui/src/adapter.ts", "README.md"],
      })
      model = update(model, {
        _tag: "ChangedFilesReplaced",
        files: [{ path: "packages/tui/src/adapter.ts", status: "M", added: 4, removed: 1 }],
      })
      const surface = new Surface(setup.renderer, {
        key: (key) => {
          model = update(model, { _tag: "KeyPressed", key })
          surface.update(model)
        },
        resize: () => undefined,
      })
      try {
        surface.update(model)
        setup.mockInput.pressKey("t", { meta: true })
        yield* openTui(() => setup.flush())
        expect((model as Model & { readonly workspaceFilesOpen: boolean }).workspaceFilesOpen).toBe(true)
        expect(model.changedFilesOpen).toBe(false)
        const workspaceFrame = setup.captureCharFrame()
        expect(workspaceFrame).toContain("Files (3)")
        expect(workspaceFrame).toContain("apps/")
        expect(workspaceFrame).toContain("README.md")

        setup.mockInput.pressKey("s", { meta: true })
        yield* openTui(() => setup.flush())
        expect((model as Model & { readonly workspaceFilesOpen: boolean }).workspaceFilesOpen).toBe(false)
        expect(model.changedFilesOpen).toBe(true)
        const changedFrame = setup.captureCharFrame()
        expect(changedFrame).toContain("Changed files (1)")
        expect(changedFrame).toContain("adapter.ts +4 -1")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("renders and scrolls nested changed files within the bordered sidebar", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 24 }))
      const opened: Array<string> = []
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        openPath: ({ path }) => opened.push(path),
        resize: () => undefined,
      })
      const changedFiles = Array.from({ length: 30 }, (_, index) => ({
        path: `apps/rika/src/features/feature-${String(index).padStart(2, "0")}.ts`,
        status: "M",
        added: index + 1,
        removed: index,
      }))
      try {
        surface.update({
          ...initial("/work", "high"),
          width: 100,
          height: 24,
          entries: [{ role: "assistant", text: "answer" }],
          changedFilesOpen: true,
          changedFiles: ready(changedFiles),
        })
        yield* openTui(() => setup.renderOnce())
        yield* Effect.sleep("0 millis")
        yield* openTui(() => setup.renderOnce())
        const initialFrame = setup.captureCharFrame()
        expect(initialFrame).toContain("Changed files (30)")
        expect(initialFrame).toContain("apps/")
        expect(initialFrame).toContain("  rika/")
        expect(initialFrame).toContain("feature-00.ts")
        expect(initialFrame).not.toContain("feature-29.ts")
        yield* openTui(() => setup.mockMouse.click(72, 5))
        expect(opened).toEqual(["apps/rika/src/features/feature-00.ts"])
        surface.changedFilesBox.scrollTo(surface.changedFilesBox.scrollHeight - surface.changedFilesBox.viewport.height)
        yield* openTui(() => setup.renderOnce())
        const scrolledFrame = setup.captureCharFrame()
        expect(scrolledFrame).toContain("feature-29.t +30 -29")
        expect(scrolledFrame.split("\n")[0]?.slice(66).startsWith("╭")).toBe(true)
        expect(scrolledFrame.split("\n")[23]?.slice(66).startsWith("╰")).toBe(true)
        expect(scrolledFrame.split("\n")[23]?.slice(0, 66).startsWith("╰")).toBe(true)
        yield* openTui(() => setup.mockMouse.click(72, 22))
        expect(opened).toEqual(["apps/rika/src/features/feature-00.ts", "apps/rika/src/features/feature-29.ts"])
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("refreshes the changed-files virtual window after resize layout completes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 35 }))
      let model: Model = {
        ...initial("/work", "high"),
        width: 120,
        height: 35,
        entries: [{ role: "assistant", text: "answer" }],
        changedFilesOpen: true,
        changedFiles: ready(
          Array.from({ length: 50 }, (_, index) => ({
            path: `file-${String(index).padStart(3, "0")}.ts`,
            status: "M",
            added: 1,
            removed: 0,
          })),
        ),
      }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: (width, height) => {
          model = { ...model, width, height }
          surface.update(model)
        },
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        expect(setup.captureCharFrame()).not.toContain("file-041.ts")

        setup.renderer.resize(140, 45)
        yield* openTui(() => setup.flush())

        const frame = setup.captureCharFrame()
        expect(frame).toContain("file-041.ts")
        expect(frame.split("\n").slice(0, -1)).toHaveLength(45)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps click rows stable after a clipped wide-character filename", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 24 }))
      const opened: Array<string> = []
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        openPath: ({ path }) => opened.push(path),
        resize: () => undefined,
      })
      try {
        surface.update({
          ...initial("/work", "high"),
          width: 100,
          height: 24,
          changedFilesOpen: true,
          changedFiles: ready([
            { path: "a/非常非常非常非常非常非常长的文件名.ts", status: "M", added: 1, removed: 1 },
            { path: "b/after.ts", status: "M", added: 2, removed: 0 },
          ]),
        })
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        expect(frame).toContain("+1 -1")
        expect(frame).toContain("after.ts +2 -0")
        yield* openTui(() => setup.mockMouse.moveTo(72, 4))
        yield* openTui(() => setup.renderOnce())
        expect(
          setup
            .captureSpans()
            .lines.flatMap((line) => line.spans)
            .some((span) => span.text.includes("after.ts") && (span.attributes & 8) === 8),
        ).toBe(true)
        yield* openTui(() => setup.mockMouse.click(72, 4))
        expect(opened).toEqual(["b/after.ts"])
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("escapes control characters without shifting changed-file click rows", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 24 }))
      const opened: Array<string> = []
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        openPath: ({ path }) => opened.push(path),
        resize: () => undefined,
      })
      try {
        surface.update({
          ...initial("/work", "high"),
          width: 100,
          height: 24,
          changedFilesOpen: true,
          changedFiles: ready([
            { path: "a-bad\n\tname.ts", status: "M", added: 1, removed: 1 },
            { path: "z-after.ts", status: "M", added: 2, removed: 0 },
          ]),
        })
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        expect(frame).toContain("a-bad\\n\\tname.ts +1 -1")
        expect(frame).toContain("z-after.ts +2 -0")
        yield* openTui(() => setup.mockMouse.click(72, 2))
        expect(opened).toEqual(["z-after.ts"])
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps the mode label and picker grouped with the narrowed composer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 24 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update({
          ...initial("/work", "high"),
          width: 100,
          height: 24,
          costUsd: 0.004,
          changedFilesOpen: true,
          changedFiles: ready([{ path: "src/main.ts", status: "M", added: 2, removed: 1 }]),
          modePicker: { open: true, selected: 2 },
        })
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain(" $0.004 ─ high ")
        const composerRight = surface.inputBox.x + surface.inputBox.width
        expect(surface.modeLabel.x + surface.modeLabel.width).toBeLessThanOrEqual(composerRight)
        expect(surface.paletteBox.x + surface.paletteBox.width).toBeLessThanOrEqual(composerRight)
        expect(surface.paletteBox.x + surface.paletteBox.width).toBeLessThanOrEqual(surface.changedFilesBox.x)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

for (const width of [80, 50] as const) {
  test(`renders a visible error action and leaves the composer usable at width ${width}`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width, height: 20 }))
        let model: Model = { ...initial("/work", "high"), width, height: 20 }
        model = update(model, { _tag: "ExecutionFailed", message: "The model is unavailable." })
        const surface = new Surface(setup.renderer, {
          key: (key) => {
            model = update(model, { _tag: "KeyPressed", key })
            if (key.name === "return" && !key.shift) model = update(model, { _tag: "Submitted" })
            surface.update(model)
          },
          resize: () => undefined,
        })
        try {
          surface.update(model)
          yield* openTui(() => setup.renderOnce())
          const failed = setup.captureCharFrame()
          expect(failed).toContain("ERROR: Message failed")
          expect(failed.replaceAll(/\s+/g, " ")).toContain("Next: Press Enter to try again.")
          expect(
            setup
              .captureSpans()
              .lines.flatMap((line) => line.spans)
              .some(
                (span) => span.text.includes("ERROR: Message failed") && span.fg.toInts().join(",") === "128,0,0,255",
              ),
          ).toBe(true)
          yield* openTui(() => setup.mockInput.typeText("retry"))
          setup.mockInput.pressEnter()
          expect(model.busy).toBe(true)
          model = update(model, { _tag: "TurnStarted", turnId: "turn-retry", prompt: "retry" })
          surface.update(model)
          yield* openTui(() => setup.renderOnce())
          expect(model.entries.at(-1)).toEqual({ role: "user", text: "retry", turnId: "turn-retry" })
          expect(setup.captureCharFrame()).toContain("┃ retry")
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

test("routes ctrl+v to injected image paste and inserts its attachment path", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model = initial("/work", "high")
      let calls = 0
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        pasteImage: () => {
          calls += 1
          model = insertText(model, "[.rika/pasted/paste-1.png]")
          surface.update(model)
        },
        resize: () => undefined,
      })
      try {
        surface.update(model)
        setup.mockInput.pressKey("v", { ctrl: true })
        expect(calls).toBe(1)
        expect(model.input).toBe("[.rika/pasted/paste-1.png]")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

const nonSpaceBounds = (frame: string, height: number) => {
  const points = frame
    .split("\n")
    .slice(0, height - 5)
    .flatMap((row, y) => Array.from(row, (cell, x) => ({ cell, x, y })))
    .filter(({ cell }) => cell !== " ")
  return {
    left: Math.min(...points.map(({ x }) => x)),
    right: Math.max(...points.map(({ x }) => x)),
    top: Math.min(...points.map(({ y }) => y)),
    bottom: Math.max(...points.map(({ y }) => y)),
  }
}

for (const [width, height] of [
  [100, 30],
  [80, 24],
  [60, 20],
] as const) {
  test(`keeps the animated welcome centered above the bottom composer at ${width}x${height}`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width, height }))
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        try {
          const state = { ...initial("/workspace", "high"), width, height }
          const capturePhases = Effect.fn("capturePhases")(function* (
            remaining: number,
          ): Effect.fn.Return<ReadonlyArray<ReturnType<typeof nonSpaceBounds>>, OpenTuiError> {
            if (remaining === 0) return []
            surface.update(state)
            yield* openTui(() => setup.renderOnce())
            const frame = setup.captureCharFrame()
            expect(frame).toContain("Welcome to Rika")
            expect(frame).not.toMatch(/Threads|Local durable coding agent|▏/)
            expect(frame.split("\n")[height - 5]?.startsWith("╭")).toBe(true)
            expect(frame.split("\n")[height - 1]?.startsWith("╰")).toBe(true)
            return [nonSpaceBounds(frame, height), ...(yield* capturePhases(remaining - 1))]
          })
          const phases = yield* capturePhases(10)
          expect(phases.every(({ left, right }) => left >= 0 && right < width)).toBe(true)
          expect(new Set(phases.map(({ top, bottom }) => `${top}:${bottom}`)).size).toBeLessThanOrEqual(2)
          const coloredMark = setup
            .captureSpans()
            .lines.flatMap((line) => line.spans)
            .some((span) => /[•●·]/u.test(span.text) && span.fg.toInts().join(",") === "61,212,255,255")
          expect(coloredMark).toBe(true)
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

for (const height of [13, 16, 19] as const) {
  test(`keeps essential compact welcome copy visible at 60x${height}`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width: 60, height }))
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        try {
          surface.update({ ...initial("/workspace", "high"), width: 60, height })
          yield* openTui(() => setup.renderOnce())
          const frame = setup.captureCharFrame()
          expect(frame).toContain("Welcome to Rika")
          expect(frame).toContain("ctrl+o commands")
          expect(frame).toContain("? help")
          expect(frame.split("\n")[height - 5]?.startsWith("╭")).toBe(true)
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

test("drives keyboard, palette, resize, frame capture, and teardown", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model: Model = initial("/work", "high")
      const surface = new Surface(setup.renderer, {
        key: (key) => {
          model = update(model, { _tag: "KeyPressed", key })
          if (key.name === "return" && !key.shift) model = update(model, { _tag: "Submitted" })
          surface.update(model)
        },
        resize: (width, height) => {
          model = update(model, { _tag: "Resized", width, height })
          surface.update(model)
        },
      })
      try {
        setup.resize(80, 24)
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const welcome = setup.captureCharFrame()
        expect(welcome).toContain("Welcome to Rika")
        expect(welcome).toContain("ctrl+o for commands")
        expect(welcome).toContain("? for shortcuts")
        expect(welcome).not.toContain("Threads")
        expect(welcome).not.toContain("Local durable coding agent")
        expect(welcome).not.toContain("▏")
        model = update(model, { _tag: "FilesReplaced", files: ["src/main.ts", "docs/SPEC.md"] })
        surface.update(model)
        yield* openTui(() => setup.mockInput.typeText("@main"))
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("src/main.ts")
        model = { ...model, input: "", cursor: 0 }
        surface.update(model)
        setup.mockInput.pressKey("s", { ctrl: true })
        yield* openTui(() => setup.renderOnce())
        const modeFrame = setup.captureCharFrame()
        expect(modeFrame).toContain("GPT-5.6 Sol")
        expect(modeFrame).toContain("Deep reasoning for hard tasks")
        model = update(model, {
          _tag: "KeyPressed",
          key: {
            name: "escape",
            ctrl: false,
            alt: false,
            meta: false,
            shift: false,
            sequence: "\u001b",
            eventType: "press",
          },
        })
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        expect(model.modePicker.open).toBe(false)
        yield* openTui(() => setup.mockInput.typeText("?"))
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("toggle this help")
        expect(model.input).toBe("?")
        yield* openTui(() => setup.mockInput.typeText("?"))
        yield* openTui(() => setup.mockInput.typeText("hello"))
        setup.mockInput.pressEnter()
        model = update(model, { _tag: "TurnStarted", turnId: "turn-hello", prompt: "?hello" })
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("┃ ?hello")
        model = update(model, { _tag: "AssistantStreamed", text: "stream" })
        model = update(model, { _tag: "AssistantStreamed", text: "ing" })
        model = update(model, { _tag: "ReasoningStreamed", text: "checking" })
        model = replaceQueue(model, [{ id: "next-task", prompt: "next task" }])
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const streamingFrame = setup.captureCharFrame()
        expect(streamingFrame).toContain("streaming")
        expect(streamingFrame).toContain("next task")
        setup.mockInput.pressKey("o", { ctrl: true })
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("Command Palette")
        setup.mockInput.pressKey("o", { ctrl: true })
        model = update(model, {
          _tag: "BlockAdded",
          block: {
            _tag: "ToolCall",
            id: "1",
            name: "read",
            input: "src/main.ts",
            status: "running",
            presentation: {
              family: "explore",
              action: "read",
              activeLabel: "Exploring",
              completeLabel: "Explored",
              counter: "file",
            },
            detail: "src/main.ts",
            files: [],
          },
        })
        model = update(model, { _tag: "BlockAdded", block: { _tag: "Diff", path: "src/main.ts", patch: "-old\n+new" } })
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const activityFrame = setup.captureCharFrame()
        expect(activityFrame).toMatch(/[⠀-⣿] Exploring 1 file ▸/u)
        expect(activityFrame).toContain("Edited src/main.ts +1 -1")
        model = update(model, {
          _tag: "BlockAdded",
          block: { _tag: "Workflow", name: "release", step: "verify", status: "running" },
        })
        model = update(model, {
          _tag: "BlockAdded",
          block: {
            _tag: "ImageAttachment",
            name: "screen.png",
            mediaType: "image/png",
            width: 800,
            height: 600,
            bytes: 1200,
          },
        })
        setup.resize(80, 40)
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const metadataFrame = setup.captureCharFrame()
        expect(metadataFrame).toContain("Workflow release")
        expect(metadataFrame).toContain("screen.png · image/png · 800×600 · 1200 bytes")
        setup.resize(50, 12)
        yield* openTui(() => setup.renderOnce())
        expect([model.width, model.height]).toEqual([50, 12])
        const retained = Renderable.renderablesByNumber.size
        for (let index = 0; index < 25; index += 1) surface.update(model)
        expect(Renderable.renderablesByNumber.size).toBe(retained)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps every overlay above the composer at 50x12", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 50, height: 12 }))
      let model: Model = { ...initial("/work", "high"), width: 50, height: 12 }
      model = update(model, { _tag: "FilesReplaced", files: ["src/main.ts"] })
      model = update(model, {
        _tag: "ThreadsReplaced",
        threads: [thread({ id: "thread-2", title: "Release notes", workspace: "/two" })],
      })
      const base = model
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      const capture = Effect.fn("capture")(function* (next: Model, title: string, content: string, composerRow = 7) {
        model = next
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        const rows = frame.split("\n")
        expect(frame).toContain(title)
        expect(frame).toContain(content)
        expect(rows[composerRow]?.startsWith("╭")).toBe(true)
        expect(rows[11]?.startsWith("╰")).toBe(true)
      })
      try {
        yield* capture(
          { ...base, paletteOpen: true, palette: { ...base.palette, open: true } },
          "Command Palette",
          "toggle fast mode",
        )
        yield* capture({ ...base, modePicker: { ...base.modePicker, open: true } }, "←→ turn · esc", "GPT-5.6")
        yield* capture({ ...base, shortcutsOpen: true }, "command palette", "Ctrl+O", 4)
        yield* capture({ ...base, filePicker: { ...base.filePicker, open: true } }, "@src", "@src")
        yield* capture(
          { ...base, threadSwitcher: { ...base.threadSwitcher, open: true, kind: "mention" } },
          "Mention Thread",
          "Release notes",
        )
        yield* capture(
          { ...base, threadSwitcher: { ...base.threadSwitcher, open: true } },
          "Switch Thread",
          "Release notes",
        )
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

for (const [width, height] of [
  [140, 40],
  [100, 24],
  [60, 16],
  [59, 14],
  [40, 12],
  [24, 8],
  [20, 8],
  [12, 6],
] as const) {
  test(`bounds responsive surfaces inside a ${width}x${height} terminal`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width, height }))
        const queued = replaceQueue(
          {
            ...initial("/work", "high"),
            width,
            height,
            input: "界🙂e\u0301".repeat(12),
            cursor: 60,
            changedFilesOpen: true,
            changedFiles: ready([{ path: "src/界🙂e\u0301.ts", status: "M", added: 2, removed: 1 }]),
            filePicker: {
              open: false,
              query: "",
              selected: 0,
              items: ready(["src/界🙂e\u0301.ts"]),
            },
            threadSidebar: { open: true, focused: true, selected: 0, scrollTop: 0 },
            threads: [thread({ id: "unicode-thread", title: "界🙂e\u0301 thread" })],
          },
          [{ id: "tiny-queue", prompt: "queued 界🙂e\u0301".repeat(10) }],
        )
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        const bounded = (name: string, renderable: { x: number; y: number; width: number; height: number }) => {
          const bounds = { x: renderable.x, y: renderable.y, width: renderable.width, height: renderable.height }
          expect(renderable.x).toBeGreaterThanOrEqual(0)
          expect(renderable.y).toBeGreaterThanOrEqual(0)
          expect(renderable.x + renderable.width, `${name} horizontal ${JSON.stringify(bounds)}`).toBeLessThanOrEqual(
            width,
          )
          expect(renderable.y + renderable.height, `${name} vertical ${JSON.stringify(bounds)}`).toBeLessThanOrEqual(
            height,
          )
        }
        try {
          for (const model of [
            { ...queued, paletteOpen: true, palette: { ...queued.palette, open: true } },
            { ...queued, modePicker: { ...queued.modePicker, open: true } },
            { ...queued, filePicker: { ...queued.filePicker, open: true } },
            { ...queued, filePicker: { ...queued.filePicker, open: true, items: ready([]) } },
            { ...queued, filePicker: { ...queued.filePicker, open: true, items: loading } },
            { ...queued, threadSwitcher: { ...queued.threadSwitcher, open: true } },
          ]) {
            surface.update(model)
            yield* openTui(() => setup.renderOnce())
            bounded("composer", surface.inputBox)
            bounded("queue", surface.queueBox)
            bounded("overlay", surface.paletteBox)
            bounded("content", surface.contentColumn)
            if (model.modePicker.open || model.filePicker.open) {
              expect(surface.paletteBox.x).toBeGreaterThanOrEqual(surface.contentColumn.x)
              expect(surface.paletteBox.x + surface.paletteBox.width).toBeLessThanOrEqual(
                surface.contentColumn.x + surface.contentColumn.width,
              )
            }
            if (surface.sidebar.visible) bounded("thread sidebar", surface.sidebar)
            if (surface.changedFilesBox.visible) {
              bounded("file sidebar", surface.changedFilesBox)
              const state = surface as unknown as {
                readonly changedRows: ReadonlyArray<{ readonly chunks: ReadonlyArray<{ readonly text: string }> }>
              }
              const innerWidth = Math.max(1, surface.changedFilesBox.width - 6)
              expect(
                state.changedRows.every(
                  (row) => row.chunks.reduce((total, chunk) => total + stringWidth(chunk.text), 0) <= innerWidth,
                ),
              ).toBe(true)
            }
            if (surface.overlayEditor.visible) {
              bounded("overlay editor", surface.overlayEditor)
              expect(surface.overlayEditor.x).toBeGreaterThanOrEqual(surface.paletteBox.x)
              expect(surface.overlayEditor.x + surface.overlayEditor.width).toBeLessThanOrEqual(
                surface.paletteBox.x + surface.paletteBox.width,
              )
            }
            const overlayText = styledTextValue(surface.palette.content)
            const overlayInnerWidth = Math.max(1, surface.paletteBox.width - 4)
            expect(
              overlayText.split("\n").every((line) => stringWidth(line) <= overlayInnerWidth),
              `${width} columns with ${overlayInnerWidth} overlay cells:\n${overlayText}`,
            ).toBe(true)
          }
          surface.showToast("Selection 界👩‍💻e\u0301 copied to clipboard")
          yield* openTui(() => setup.renderOnce())
          bounded("toast", surface.toastBox)
          expect(stringWidth(styledTextValue(surface.toast.content))).toBeLessThanOrEqual(
            Math.max(1, surface.toastBox.width - 4),
          )
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

test("joins the durable queue to the composer like Amp", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model = replaceQueue(
        { ...initial("/work", "medium"), busy: true, activity: { _tag: "Streaming", bytes: 40 } },
        [
          { id: "queued-1", prompt: "First queued prompt" },
          { id: "queued-2", prompt: "Selected queued prompt" },
        ],
      )
      model = { ...model, queueSelection: "queued-2" }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update({ ...model, queueSelection: undefined })
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).not.toContain("Enter to steer")
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        const rows = frame.split("\n")
        expect(frame).toContain("First queued prompt")
        expect(frame).toContain("Selected queued p…")
        expect(frame).not.toContain("queued 1/2")
        expect(frame).not.toContain("queued 2/2")
        expect(frame).toContain("Enter to steer")
        expect(frame).toContain("Backspace to dequeue")
        expect(frame).toContain("Ctrl+E to edit")
        expect(rows.findIndex((row) => row.includes("Enter to steer"))).toBe(
          rows.findIndex((row) => row.includes("Selected queued p…")),
        )
        expect(rows.find((row) => row.includes("Enter to steer"))).toMatch(/Ctrl\+E to edit  │ $/)
        expect(surface.queueBox.height).toBe(4)
        expect(surface.inputBox.y).toBe(surface.queueBox.y + surface.queueBox.height - 1)
        expect(rows[surface.queueBox.y]?.startsWith(" ╭")).toBe(true)
        expect(rows[surface.inputBox.y]?.startsWith("╭┴")).toBe(true)
        expect(rows[surface.inputBox.y]?.endsWith("╮")).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("renders an inline hint on the selected queued row as the queue window moves", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 60, height: 14 }))
      const items = Array.from({ length: 8 }, (_, index) => ({ id: `q${index}`, prompt: `prompt number ${index}` }))
      const base = replaceQueue({ ...initial("/work", "medium"), busy: true, width: 60, height: 14 }, items)
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update({ ...base, queueSelection: "q0" })
        yield* openTui(() => setup.renderOnce())
        const top = setup.captureCharFrame()
        const topRows = top.split("\n")
        expect(top).not.toContain("queued 1/8")
        expect(topRows.findIndex((row) => row.includes("Enter to steer"))).toBe(
          topRows.findIndex((row) => row.includes("prompt number 0")),
        )
        surface.update({ ...base, queueSelection: "q7" })
        yield* openTui(() => setup.renderOnce())
        const bottom = setup.captureCharFrame()
        const bottomRows = bottom.split("\n")
        expect(bottom).not.toContain("queued 8/8")
        expect(bottomRows.findIndex((row) => row.includes("Enter to steer"))).toBe(
          bottomRows.findIndex((row) => row.includes("prompt number 7")),
        )
        expect(bottom).not.toContain("prompt number 0")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("shows the editing hint inline on the queued row being edited", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const model = {
        ...replaceQueue({ ...initial("/work", "medium"), busy: true, width: 80, height: 24 }, [
          { id: "a", prompt: "alpha" },
          { id: "b", prompt: "beta" },
        ]),
        queueSelection: "b",
        editingTurnId: "b",
        input: "beta edited",
        cursor: "beta edited".length,
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        const rows = frame.split("\n")
        expect(frame).toContain("Editing queued")
        expect(frame).not.toContain("2/2")
        expect(frame).toContain("Enter save")
        expect(frame).toContain("Esc cancel")
        expect(rows.findIndex((row) => row.includes("Editing queued"))).toBe(
          rows.findIndex((row) => row.includes("beta")),
        )
        expect(surface.queueBox.height).toBe(4)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("removes a promoted prompt from the queue when it starts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const base = resetQueue(
        { ...initial("/work", "medium"), busy: true, width: 80, height: 24, currentThreadId: "t" },
        "t",
        1,
        [
          { id: "a", prompt: "alpha" },
          { id: "b", prompt: "beta" },
        ],
      )
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(base)
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("beta")
        const started = update(applyQueueDelta(base, "t", 2, { _tag: "Removed", turnId: "a" }).model, {
          _tag: "TurnStarted",
          turnId: "a",
          prompt: "alpha",
        })
        surface.update(started)
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        expect(frame).toContain("beta")
        expect(frame).not.toContain("queued 1/1")
        expect(frame).not.toContain("queued 2/2")
        expect(frame).toContain("alpha")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("clamps an oversized focused queued prompt to the queue box with an indicator", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 40, height: 12 }))
      const model = {
        ...replaceQueue({ ...initial("/work", "medium"), busy: true, width: 40, height: 12 }, [
          { id: "big", prompt: "x".repeat(400) },
        ]),
        queueSelection: "big",
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const text = (surface.queueText.content as unknown as { chunks: ReadonlyArray<{ text: string }> }).chunks
          .map((chunk) => chunk.text)
          .join("")
        expect(text).toContain("…")
        expect(text.length).toBeLessThan(40)
        const frame = setup.captureCharFrame()
        const row = frame.split("\n").find((candidate) => candidate.includes("Enter to steer"))
        expect(row).toContain("x")
        expect(row).not.toContain("Backspace to dequeue")
        expect(row).not.toContain("Ctrl+E to edit")
        expect(surface.queueBox.height).toBe(3)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("drops the inline queue hint before hiding message text in a very narrow terminal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 24, height: 12 }))
      const model = {
        ...replaceQueue({ ...initial("/work", "medium"), busy: true, width: 24, height: 12 }, [
          { id: "narrow", prompt: "message survives" },
        ]),
        queueSelection: "narrow",
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        expect(frame).toContain("message survives")
        expect(frame).not.toContain("Enter to steer")
        expect(frame).not.toContain("Backspace to dequeue")
        expect(frame).not.toContain("Ctrl+E to edit")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
