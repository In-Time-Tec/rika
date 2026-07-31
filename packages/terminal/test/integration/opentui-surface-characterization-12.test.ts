import { Renderable } from "@opentui/core"

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
