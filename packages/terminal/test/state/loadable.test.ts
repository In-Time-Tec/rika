import { CliRenderEvents, PasteEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { expect, test, vi } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../src/opentui/surface/service"
import { ready } from "../../src/state/loadable"
import { update } from "../../src/state/reducer/model"
import { adapterFixtures4 } from "./loadable.fixture"
import { openTui } from "../support/surface/transcript/pane-geometry.fixture"

const { handlers, model } = adapterFixtures4

test("registers no SIGWINCH handler and relies on OpenTUI's debounced resize", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const before = process.listenerCount("SIGWINCH")
      const callbacks = handlers()
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const surface = new Surface(setup.renderer, callbacks)
      try {
        expect(process.listenerCount("SIGWINCH")).toBe(before)
        process.emit("SIGWINCH", "SIGWINCH")
        expect(callbacks.resize).not.toHaveBeenCalled()
        setup.resize(140, 45)
        expect(callbacks.resize).toHaveBeenLastCalledWith(140, 45)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("uses the terminal's native blinking block cursor on the composer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const surface = new Surface(setup.renderer, handlers())
      try {
        surface.update(model({ input: "draft", cursor: 5 }))
        expect(surface.composerEditor.cursorStyle).toEqual({ style: "block", blinking: true })
        expect(surface.composerEditor.showCursor).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("routes image paste, text paste, and non-empty selections through their dedicated callbacks", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const copied: Array<string> = []
      setup.renderer.copyToClipboardOSC52 = (text) => {
        copied.push(text)
        return true
      }
      const callbacks = { key: vi.fn(), paste: vi.fn(), pasteImage: vi.fn(), resize: vi.fn() }
      const surface = new Surface(setup.renderer, callbacks)
      try {
        setup.mockInput.pressKey("v", { ctrl: true })
        setup.mockInput.pressKey("x")
        setup.renderer.keyInput.emit("paste", new PasteEvent(new TextEncoder().encode("pasted text")))
        setup.renderer.keyInput.emit(
          "paste",
          new PasteEvent(Uint8Array.from([1, 2, 3]), { kind: "binary", mimeType: "image/png" }),
        )
        setup.renderer.keyInput.emit("paste", new PasteEvent(new Uint8Array()))
        setup.renderer.emit(CliRenderEvents.SELECTION, { getSelectedText: () => "selected text\n" })
        setup.renderer.emit(CliRenderEvents.SELECTION, { getSelectedText: () => "  " })

        expect(callbacks.pasteImage).toHaveBeenCalledTimes(2)
        expect(callbacks.pasteImage).toHaveBeenLastCalledWith({
          bytes: Uint8Array.from([1, 2, 3]),
          mediaType: "image/png",
        })
        expect(callbacks.key).toHaveBeenCalledOnce()
        expect(callbacks.paste).toHaveBeenCalledOnce()
        expect(callbacks.paste).toHaveBeenCalledWith("pasted text")
        expect(copied).toEqual(["selected text"])
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("never decodes binary paste as text without an image handler", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const callbacks = { key: vi.fn(), paste: vi.fn(), resize: vi.fn() }
      const surface = new Surface(setup.renderer, callbacks)
      try {
        setup.renderer.keyInput.emit(
          "paste",
          new PasteEvent(Uint8Array.from([0xff, 0xfe]), { kind: "binary" }),
        )
        expect(callbacks.paste).not.toHaveBeenCalled()
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("opens a clicked changed file through the host callback", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const callbacks = { ...handlers(), openPath: vi.fn() }
      const surface = new Surface(setup.renderer, callbacks)
      try {
        surface.update(
          model({
            changedFilesOpen: true,
            changedFiles: ready([{ path: "apps/rika/src/main.ts", status: "M", added: 2, removed: 1 }]),
          }),
        )
        yield* openTui(() => setup.renderOnce())
        yield* openTui(() => setup.mockMouse.click(surface.changedFilesText.screenX + 1, surface.changedFilesText.screenY + 3))
        expect(callbacks.openPath).toHaveBeenCalledWith({ path: "apps/rika/src/main.ts" })
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("expands an existing collapsed attachment when the same text is pasted twice quickly", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const callbacks = { ...handlers(), paste: vi.fn(), expandPaste: vi.fn() }
      const surface = new Surface(setup.renderer, callbacks)
      try {
        const token = String.fromCharCode(0xe000)
        surface.update(
          model({
            input: token,
            cursor: 1,
            pastedText: [{ type: "text", token, value: "line one\nline two", label: "[Pasted text #1 +2 lines]" }],
          }),
        )
        yield* openTui(() => setup.mockInput.pasteBracketedText("line one\nline two"))
        yield* openTui(() => setup.mockInput.pasteBracketedText("line one\nline two"))
        expect(callbacks.paste).toHaveBeenCalledOnce()
        expect(callbacks.expandPaste).toHaveBeenCalledWith(token)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("resizes the composer by dragging its top border", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let state = model()
      const callbacks = {
        ...handlers(),
        composerResize: vi.fn((height: number) => {
          state = update(state, { _tag: "ComposerHeightChanged", height })
          surface.update(state)
        }),
      }
      const surface = new Surface(setup.renderer, callbacks)
      try {
        surface.update(state)
        yield* openTui(() => setup.renderOnce())
        yield* openTui(() => setup.mockMouse.drag(20, surface.inputBox.y, 20, surface.inputBox.y - 4))
        expect(callbacks.composerResize).toHaveBeenLastCalledWith(9)
        expect(callbacks.composerResize.mock.calls).toEqual([[6], [7], [7], [8], [9]])

        surface.update(model({ shortcutsOpen: true }))
        yield* openTui(() => setup.mockMouse.drag(20, surface.inputBox.y, 20, surface.inputBox.y - 4))
        expect(callbacks.composerResize).toHaveBeenCalledTimes(5)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
