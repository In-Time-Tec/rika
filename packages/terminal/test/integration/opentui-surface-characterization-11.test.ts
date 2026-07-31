import { CliRenderEvents, Renderable } from "@opentui/core"

import { createTestRenderer } from "@opentui/core/testing"

import { expect, test } from "vitest"

import { Data, Effect } from "effect"

import stringWidth from "string-width"

import { Surface, maxMountedTranscriptEntries } from "../../src/adapter"

import { initial, loading, ready, replaceQueue, update } from "../../src/view-state"

class OpenTuiError extends Data.TaggedError("OpenTuiError")<{ readonly cause: unknown }> {}

const openTui = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new OpenTuiError({ cause }) })

const insertText = (model: Model, text: string) => update(model, { _tag: "Pasted", text })

const styledTextValue = (value: { readonly chunks: ReadonlyArray<{ readonly text: string }> } | string) =>
  typeof value === "string" ? value : value.chunks.map((chunk) => chunk.text).join("")

const _streamingShell = (id: string, output?: string) => ({
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

const _giantSubagentModel = (childCount: number): Model => {
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

const _collapsedSubagentModel = (answerCount: number, childCount: number): Model => {
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
        files: ["apps/rika/src/main.ts", "packages/terminal/src/adapter.ts", "README.md"],
      })
      model = update(model, {
        _tag: "ChangedFilesReplaced",
        files: [{ path: "packages/terminal/src/adapter.ts", status: "M", added: 4, removed: 1 }],
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
