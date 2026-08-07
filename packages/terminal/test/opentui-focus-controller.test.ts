import { describe, expect, test } from "vitest"
import { FocusController, type FocusableEditor } from "../src/opentui/surface/opentui-focus-controller"

const editor = () => {
  const state = { focused: false, blurred: 0, showCursor: false }
  return {
    state,
    editor: {
      focus: () => {
        state.focused = true
      },
      blur: () => {
        state.focused = false
        state.blurred += 1
      },
      set showCursor(value: boolean) {
        state.showCursor = value
      },
      get showCursor() {
        return state.showCursor
      },
    } as unknown as FocusableEditor,
  }
}

const host = () => {
  const calls = { render: 0, frames: [] as Array<() => void>, off: 0 }
  return {
    calls,
    host: {
      renderer: {
        requestRender: () => {
          calls.render += 1
        },
        once: (_event: unknown, handler: () => void) => calls.frames.push(handler),
        off: () => {
          calls.off += 1
        },
      } as never,
      destroyed: () => false,
    },
  }
}

describe("focus controller", () => {
  test("focuses an editor and shows its cursor", () => {
    const { host: h } = host()
    const { state, editor: e } = editor()
    const controller = new FocusController(h)
    controller.focus(e)
    expect(state.focused).toBe(true)
    expect(state.showCursor).toBe(true)
    expect(controller.focused).toBe(e)
  })

  test("blurs the previous editor when focus moves", () => {
    const { host: h } = host()
    const first = editor()
    const second = editor()
    const controller = new FocusController(h)
    controller.focus(first.editor)
    controller.focus(second.editor)
    expect(first.state.blurred).toBe(1)
    expect(second.state.focused).toBe(true)
  })

  test("refocusing the same editor is a no-op", () => {
    const { host: h } = host()
    const { state, editor: e } = editor()
    const controller = new FocusController(h)
    controller.focus(e)
    controller.focus(e)
    expect(state.blurred).toBe(0)
  })

  test("does not schedule a cursor restore without a focused editor", () => {
    const { calls, host: h } = host()
    new FocusController(h).restoreCursor()
    expect(calls.frames.length).toBe(0)
  })

  test("schedules exactly one cursor restore at a time", () => {
    const { calls, host: h } = host()
    const controller = new FocusController(h)
    controller.focus(editor().editor)
    controller.restoreCursor()
    controller.restoreCursor()
    expect(calls.frames.length).toBe(1)
  })

  test("releasing removes a pending restore frame", () => {
    const { calls, host: h } = host()
    const controller = new FocusController(h)
    controller.focus(editor().editor)
    controller.restoreCursor()
    controller.release()
    expect(calls.off).toBe(1)
    controller.release()
    expect(calls.off).toBe(1)
  })
})
