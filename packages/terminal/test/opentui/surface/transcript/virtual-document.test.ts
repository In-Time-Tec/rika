import { nonSpaceBounds } from "../../../support/surface/transcript/virtual-document.fixture"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import stringWidth from "string-width"
import { Surface } from "../../../../src/opentui/surface/service"
import { maxMountedTranscriptEntries } from "../../../../src/opentui/rendering/transcript/window"
import * as transcriptVirtualIndexModule from "../../../../src/presentation/transcript/viewport/virtual-index"
import { initial, type Model } from "../../../../src/state/model"
import { loading, ready } from "../../../../src/state/loadable"
import { replaceQueue } from "../../../../src/state/queue/model"
import { update } from "../../../../src/state/reducer/model"
import {
  OpenTuiError,
  openTui,
  _insertText,
  styledTextValue,
  _streamingShell,
  thread,
  _giantSubagentModel,
  _collapsedSubagentModel,
} from "../../../support/surface/transcript/lifecycle.fixture"
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
          const state = {
            get transcriptChildren() {
              return surface.transcriptDiagnostics().rows
            },
          }
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
          const state = {
            get changedRows() {
              return surface.sidebarRows()
            },
            get transcriptChildren() {
              return surface.transcriptDiagnostics().rows
            },
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
        model = update(model, {
          _tag: "ExecutionFailed",
          failure: {
            tag: "TestFailure",
            message: "The model is unavailable.",
            category: "operation",
            retryable: false,
            retry: "none",
            actor: "environment",
          },
        })
        const surface = new Surface(setup.renderer, {
          key: (key) => {
            model = update(model, { _tag: "KeyPressed", key })
            if (key.name === "return" && !key.shift)
              model = update(model, { _tag: "Submitted", submissionId: "retry-submission" })
            surface.update(model)
          },
          resize: () => undefined,
        })
        try {
          surface.update(model)
          yield* openTui(() => setup.renderOnce())
          const failed = setup.captureCharFrame()
          expect(failed).toContain("TestFailure")
          expect(
            setup
              .captureSpans()
              .lines.flatMap((line) => line.spans)
              .some((span) => span.text.includes("TestFailure") && span.fg.toInts().join(",") === "128,0,0,255"),
          ).toBe(true)
          yield* openTui(() => setup.mockInput.typeText("retry"))
          setup.mockInput.pressEnter()
          expect(model).toMatchObject({ input: "", busy: true, activity: { _tag: "Sending" } })
          expect(model.entries).toEqual([{ role: "user", text: "retry" }])
          model = update(model, {
            _tag: "SubmissionAdmitted",
            turnId: "turn-retry",
            status: "active",
            submissionId: "retry-submission",
          })
          expect(model).toMatchObject({ input: "", busy: true, activity: { _tag: "Sending" } })
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
            .some((span) => /[•●·]/u.test(span.text) && span.fg.toInts()[2] > span.fg.toInts()[0])
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
            if (model.modePicker.open === true || model.filePicker.open === true) {
              expect(surface.paletteBox.x).toBeGreaterThanOrEqual(surface.contentColumn.x)
              expect(surface.paletteBox.x + surface.paletteBox.width).toBeLessThanOrEqual(
                surface.contentColumn.x + surface.contentColumn.width,
              )
            }
            if (surface.sidebar.visible === true) bounded("thread sidebar", surface.sidebar)
            if (surface.changedFilesBox.visible === true) {
              bounded("file sidebar", surface.changedFilesBox)
              const state = {
                get changedRows() {
                  return surface.sidebarRows()
                },
              }
              const innerWidth = Math.max(1, surface.changedFilesBox.width - 6)
              expect(
                state.changedRows.every(
                  (row) => row.chunks.reduce((total, chunk) => total + stringWidth(chunk.text), 0) <= innerWidth,
                ),
              ).toBe(true)
            }
            if (surface.overlayEditor.visible === true) {
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

// Defect #361 characterization: terminal-cell virtual row index.
// Row zero maps to the first item and the maximum row maps to the final item;
// one changed item recalculates one estimate; a width change rebuilds all;
// row math uses terminal cells (not UTF-16 length) and counts hard newlines.
const textEntryModel = (texts: ReadonlyArray<string>): Model => ({
  ...initial("/work", "medium"),
  entries: texts.map((text, index) => ({ role: "assistant" as const, text, turnId: `turn-${index}` })),
  items: texts.map((_, index) => ({ _tag: "Entry" as const, index, id: `entry-${index}`, turnId: `turn-${index}` })),
})

type VirtualIndexUpdater = (
  previous: transcriptVirtualIndexModule.TranscriptVirtualIndex,
  previousModel: Model,
  nextModel: Model,
  width: number,
  changedPositions: ReadonlyArray<number>,
) => transcriptVirtualIndexModule.TranscriptVirtualIndex

// The v2 incremental API; missing until the viewport rewrite lands.
const virtualIndexExports: Record<string, unknown> =
  transcriptVirtualIndexModule as unknown as Record<string, unknown>

test("maps virtual row zero to the first item", () => {
  const model = textEntryModel(Array.from({ length: 200 }, (_, index) => `answer ${index}`))
  const index = transcriptVirtualIndexModule.transcriptVirtualIndex(model, 80)
  expect(transcriptVirtualIndexModule.itemPositionAtVirtualRow(index, 0)).toBe(0)
})

test("maps the maximum virtual row to the final item", () => {
  const model = textEntryModel(Array.from({ length: 200 }, (_, index) => `answer ${index}`))
  const index = transcriptVirtualIndexModule.transcriptVirtualIndex(model, 80)
  expect(transcriptVirtualIndexModule.itemPositionAtVirtualRow(index, index.totalRows - 1)).toBe(199)
})

test("updates one row estimate when one item revision changes", () => {
  const width = 64
  const changedPosition = 10
  const previousModel = textEntryModel(Array.from({ length: 50 }, (_, index) => `answer ${index}`))
  const previous = transcriptVirtualIndexModule.transcriptVirtualIndex(previousModel, width)
  expect(typeof virtualIndexExports["updateTranscriptVirtualIndex"]).toBe("function")
  const updater = virtualIndexExports["updateTranscriptVirtualIndex"] as VirtualIndexUpdater
  const nextModel: Model = {
    ...previousModel,
    entries: previousModel.entries.map((entry, index) =>
      index === changedPosition ? { ...entry, text: "revised streaming line ".repeat(20) } : entry,
    ),
  }
  const next = updater(previous, previousModel, nextModel, width, [changedPosition])
  expect(next.rowsPerItem[changedPosition]).toBeGreaterThan(previous.rowsPerItem[changedPosition] ?? 0)
  for (let position = 0; position < 50; position += 1) {
    if (position === changedPosition) continue
    expect(next.rowsPerItem[position]).toBe(previous.rowsPerItem[position])
  }
  expect(next.totalRows).toBeGreaterThan(previous.totalRows)
})

test("rebuilds every row estimate only after terminal width changes", () => {
  const width = 64
  const narrowWidth = 24
  const model = textEntryModel(Array.from({ length: 50 }, (_, index) => `answer ${index} `.padEnd(100, ".")))
  const previous = transcriptVirtualIndexModule.transcriptVirtualIndex(model, width)
  expect(typeof virtualIndexExports["updateTranscriptVirtualIndex"]).toBe("function")
  const updater = virtualIndexExports["updateTranscriptVirtualIndex"] as VirtualIndexUpdater
  const untouched = updater(previous, model, model, width, [])
  expect(Array.from(untouched.rowsPerItem)).toEqual(Array.from(previous.rowsPerItem))
  expect(untouched.totalRows).toBe(previous.totalRows)
  const rebuilt = updater(previous, model, model, narrowWidth, [])
  const expected = transcriptVirtualIndexModule.transcriptVirtualIndex(model, narrowWidth)
  expect(Array.from(rebuilt.rowsPerItem)).toEqual(Array.from(expected.rowsPerItem))
  expect(rebuilt.totalRows).toBe(expected.totalRows)
  expect(rebuilt.totalRows).toBeGreaterThan(previous.totalRows)
})

test("counts emoji combining marks and full-width characters in terminal cells", () => {
  const width = 64
  const combiningAcute = String.fromCharCode(769)
  const womanTechnologist = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb)
  const model = textEntryModel([
    "🙂".repeat(40),
    "界".repeat(50),
    Array.from({ length: 50 }, () => `e${combiningAcute}`).join(""),
    Array.from({ length: 10 }, () => womanTechnologist).join(""),
    `${"x".repeat(60)}\n${"y".repeat(60)}`,
  ])
  const index = transcriptVirtualIndexModule.transcriptVirtualIndex(model, width)
  expect(index.rowsPerItem[0]).toBe(2)
  expect(index.rowsPerItem[1]).toBe(2)
  expect(index.rowsPerItem[2]).toBe(1)
  expect(index.rowsPerItem[3]).toBe(1)
  expect(index.rowsPerItem[4]).toBe(2)
})
