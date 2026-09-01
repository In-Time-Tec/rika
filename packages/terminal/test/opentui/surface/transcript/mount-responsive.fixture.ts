import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import stringWidth from "string-width"
import { Surface } from "../../../../src/opentui/surface/service"
import { initial } from "../../../../src/state/model"
import { loading, ready } from "../../../../src/state/loadable"
import { replaceQueue } from "../../../../src/state/queue/model"
import {
  openTui,
  _insertText,
  styledTextValue,
  _streamingShell,
  thread,
  _giantSubagentModel,
  _collapsedSubagentModel,
} from "../../../support/surface/transcript/lifecycle.fixture"
for (const [width, height] of [
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
        const surface = new Surface(setup.renderer, {
          key: () => undefined,
          resize: () => undefined,
        })
        const bounded = (name: string, renderable: { x: number; y: number; width: number; height: number }) => {
          const bounds = {
            x: renderable.x,
            y: renderable.y,
            width: renderable.width,
            height: renderable.height,
          }
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
test("joins the durable queue to the composer like Amp", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model = replaceQueue(
        {
          ...initial("/work", "medium"),
          busy: true,
          activeTurnId: "active",
          activity: { _tag: "Streaming", bytes: 40 },
        },
        [
          { id: "queued-1", prompt: "First queued prompt" },
          { id: "queued-2", prompt: "Selected queued prompt" },
        ],
      )
      model = { ...model, queueSelection: "queued-2" }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
      })
      try {
        surface.update({ ...model, queueSelection: undefined })
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).not.toContain("Enter to steer")
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        const rows = frame.split("\n")
        expect(frame).toContain("First queued prompt")
        expect(frame).toContain("Queued · Select…")
        expect(frame).not.toContain("queued 1/2")
        expect(frame).not.toContain("queued 2/2")
        expect(frame).toContain("Enter to steer")
        expect(frame).toContain("Backspace to dequeue")
        expect(frame).toContain("Ctrl+E to edit")
        expect(rows.findIndex((row) => row.includes("Enter to steer"))).toBe(
          rows.findIndex((row) => row.includes("Queued · Select…")),
        )
        expect(rows.find((row) => row.includes("Enter to steer"))).toMatch(/Ctrl\+E to edit {2}│ $/)
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
