import { CliRenderEvents, Renderable, RendererControlState } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Data, Effect } from "effect"
import stringWidth from "string-width"
import { Surface, maxMountedTranscriptEntries } from "../../src/opentui/surface/opentui-surface"
import {
  initial,
  loading,
  ready,
  replaceQueue,
  type Model,
  type ThreadItem,
  update,
} from "../../src/state/model/terminal-state"
import { OpenTuiError, openTui, _insertText, styledTextValue, _streamingShell, thread, _giantSubagentModel, _collapsedSubagentModel, nonSpaceBounds } from "./opentui-surface-characterization-1.test-support"
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
