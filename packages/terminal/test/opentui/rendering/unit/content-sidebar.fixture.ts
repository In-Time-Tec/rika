import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../../../src/opentui/surface/service"
import { initial, type Model } from "../../../../src/state/model"
import { ready } from "../../../../src/state/loadable"
import { replaceQueue } from "../../../../src/state/queue/model"
import { openTui, _insertText, _streamingShell, _giantSubagentModel, _collapsedSubagentModel } from "./bodies.fixture"
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
        const surface = new Surface(setup.renderer, {
          key: () => undefined,
          resize: () => undefined,
        })
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
        const surface = new Surface(setup.renderer, {
          key: () => undefined,
          resize: () => undefined,
        })
        try {
          surface.update(base)
          yield* openTui(() => setup.flush())
          const state = {
            get changedRows() {
              return surface.sidebarRows()
            },
          }
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
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
      })
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
test("keeps the welcome orb moving without dispatching global ViewState ticks", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24, clock }))
      let globalTicks = 0
      const surface = new Surface(
        setup.renderer,
        { key: () => undefined, resize: () => undefined, animationTick: () => (globalTicks += 1) },
        { clock },
      )
      try {
        surface.update({ ...initial("/work", "high"), width: 80, height: 24 })
        yield* openTui(() => setup.renderOnce())
        const firstPhase = surface.animationDiagnostics().welcomePhase
        clock.advance(100)
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("Welcome to Rika")
        expect(surface.animationDiagnostics().welcomePhase).toBeGreaterThan(firstPhase)
        expect(globalTicks).toBe(0)
        expect(setup.renderer.isRunning).toBe(false)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
