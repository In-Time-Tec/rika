import { describe, expect, test } from "bun:test"
import { Keymap, Keys } from "../src/index"

const inputCtx = (overrides: Partial<Keymap.Context> = {}): Keymap.Context => ({
  surface: "input",
  busy: false,
  inputEmpty: false,
  trailingBackslash: false,
  queueSelected: false,
  navigating: false,
  ...overrides,
})

const expectAction = (resolution: Keymap.Resolution): Keymap.Action => {
  expect(resolution._tag).toBe("Action")
  if (resolution._tag !== "Action") throw new Error("expected action")
  return resolution.action
}

describe("keymap.resolve", () => {
  test("inserts printable characters", () => {
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.make({ name: "a", sequence: "a" })))).toEqual({
      _tag: "Insert",
      text: "a",
    })
  })

  test("Enter submits", () => {
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.enter))._tag).toBe("Submit")
  })

  test("Shift+Enter and Ctrl+J insert a newline", () => {
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.make({ name: "return", shift: true })))._tag).toBe(
      "Newline",
    )
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.ctrl("j")))._tag).toBe("Newline")
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.make({ name: "linefeed" })))._tag).toBe("Newline")
  })

  test("with a queued message selected, Enter steers and Backspace dequeues", () => {
    const ctx = inputCtx({ queueSelected: true })
    expect(expectAction(Keymap.resolve(ctx, undefined, Keys.enter))._tag).toBe("Steer")
    expect(expectAction(Keymap.resolve(ctx, undefined, Keys.backspace))._tag).toBe("DequeueSelected")
  })

  test("backslash + Enter inserts a newline", () => {
    expect(expectAction(Keymap.resolve(inputCtx({ trailingBackslash: true }), undefined, Keys.enter))._tag).toBe(
      "Newline",
    )
  })

  test("Ctrl+O opens the palette, Ctrl+S opens the mode picker", () => {
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.ctrl("o")))._tag).toBe("OpenPalette")
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.ctrl("s")))._tag).toBe("OpenModePicker")
  })

  test("Ctrl+S cycles the mode picker once it is open", () => {
    const ctx = inputCtx({ surface: "modepicker" })
    expect(expectAction(Keymap.resolve(ctx, undefined, Keys.ctrl("s")))._tag).toBe("ModePickerNext")
    expect(expectAction(Keymap.resolve(ctx, undefined, Keys.make({ name: "down" })))._tag).toBe("ModePickerNext")
    expect(expectAction(Keymap.resolve(ctx, undefined, Keys.make({ name: "up" })))._tag).toBe("ModePickerPrev")
    expect(expectAction(Keymap.resolve(ctx, undefined, Keys.make({ name: "escape" })))._tag).toBe("ModePickerClose")
  })

  test("Ctrl+R recalls prompt history", () => {
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.ctrl("r")))._tag).toBe("HistoryPrev")
  })

  test("Tab navigates prior messages; e edits while navigating", () => {
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.make({ name: "tab" })))._tag).toBe("NavPrevMessage")
    expect(
      expectAction(Keymap.resolve(inputCtx({ navigating: true }), undefined, Keys.make({ name: "e", sequence: "e" })))
        ._tag,
    ).toBe("EditMessage")
  })

  test("Alt chords map to details / reasoning / fast-mode", () => {
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.alt("t")))._tag).toBe("ToggleDetails")
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.alt("d")))._tag).toBe("CycleReasoning")
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.alt("r")))._tag).toBe("ToggleFastMode")
  })

  test("? opens shortcuts only when input is empty", () => {
    expect(
      expectAction(Keymap.resolve(inputCtx({ inputEmpty: true }), undefined, Keys.make({ name: "?", sequence: "?" })))
        ._tag,
    ).toBe("OpenShortcuts")
    expect(
      expectAction(Keymap.resolve(inputCtx({ inputEmpty: false }), undefined, Keys.make({ name: "?", sequence: "?" }))),
    ).toEqual({ _tag: "Insert", text: "?" })
  })

  test("paste inserts text literally instead of triggering prompt shortcuts", () => {
    expect(expectAction(Keymap.resolve(inputCtx({ inputEmpty: true }), undefined, Keys.paste("?")))).toEqual({
      _tag: "Paste",
      text: "?",
    })
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.paste("@file\nnext")))).toEqual({
      _tag: "Paste",
      text: "@file\nnext",
    })
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.paste("\nleading")))).toEqual({
      _tag: "Paste",
      text: "\nleading",
    })
  })

  test("@ begins a file mention", () => {
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.make({ name: "@", sequence: "@" })))._tag).toBe(
      "FileMention",
    )
  })

  test("arrows move focus, home/end/left/right move the cursor", () => {
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.make({ name: "up" })))._tag).toBe("FocusPrev")
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.make({ name: "down" })))._tag).toBe("FocusNext")
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.make({ name: "left" })))._tag).toBe("CursorLeft")
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.make({ name: "right" })))._tag).toBe("CursorRight")
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.make({ name: "home" })))._tag).toBe("CursorHome")
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.make({ name: "end" })))._tag).toBe("CursorEnd")
  })

  test("prompt word and line editing chords resolve before printable input", () => {
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.ctrl("w")))._tag).toBe("DeleteWordBackward")
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.make({ name: "backspace", ctrl: true })))._tag).toBe(
      "DeleteWordBackward",
    )
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.make({ name: "backspace", alt: true })))._tag).toBe(
      "DeleteWordBackward",
    )
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.make({ name: "delete", ctrl: true })))._tag).toBe(
      "DeleteWordForward",
    )
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.ctrl("u")))._tag).toBe("DeleteToLineStart")
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.ctrl("k")))._tag).toBe("DeleteToLineEnd")
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.make({ name: "left", ctrl: true })))._tag).toBe(
      "WordLeft",
    )
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.make({ name: "right", ctrl: true })))._tag).toBe(
      "WordRight",
    )
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.alt("b")))._tag).toBe("WordLeft")
    expect(expectAction(Keymap.resolve(inputCtx(), undefined, Keys.alt("f")))._tag).toBe("WordRight")
  })

  test("Ctrl+C starts a chord; second key resolves quit / archive variants", () => {
    expect(Keymap.resolve(inputCtx(), undefined, Keys.ctrl("c"))).toEqual({ _tag: "Pending", chord: "ctrl-c" })
    expect(expectAction(Keymap.resolve(inputCtx(), "ctrl-c", Keys.ctrl("c")))._tag).toBe("Quit")
    expect(expectAction(Keymap.resolve(inputCtx(), "ctrl-c", Keys.ctrl("n")))._tag).toBe("ArchiveNew")
    expect(expectAction(Keymap.resolve(inputCtx(), "ctrl-c", Keys.ctrl("e")))._tag).toBe("ArchiveQuit")
  })

  test("an abandoned Ctrl+C chord falls through to the fresh key", () => {
    expect(expectAction(Keymap.resolve(inputCtx(), "ctrl-c", Keys.make({ name: "a", sequence: "a" })))).toEqual({
      _tag: "Insert",
      text: "a",
    })
  })

  test("Esc starts a chord; Esc Esc force-interrupts", () => {
    expect(Keymap.resolve(inputCtx(), undefined, Keys.escape)).toEqual({ _tag: "Pending", chord: "esc" })
    expect(expectAction(Keymap.resolve(inputCtx(), "esc", Keys.escape))._tag).toBe("ForceInterrupt")
  })

  test("Enter Enter steers via the pending window", () => {
    expect(expectAction(Keymap.resolve(inputCtx(), "enter", Keys.enter))._tag).toBe("Steer")
  })

  test("palette surface: typing filters, arrows select, Enter runs, Esc closes", () => {
    const palette = inputCtx({ surface: "palette" })
    expect(expectAction(Keymap.resolve(palette, undefined, Keys.make({ name: "m", sequence: "m" })))).toEqual({
      _tag: "PaletteInsert",
      text: "m",
    })
    expect(expectAction(Keymap.resolve(palette, undefined, Keys.make({ name: "up" })))._tag).toBe("PaletteUp")
    expect(expectAction(Keymap.resolve(palette, undefined, Keys.make({ name: "down" })))._tag).toBe("PaletteDown")
    expect(expectAction(Keymap.resolve(palette, undefined, Keys.enter))._tag).toBe("PaletteRun")
    expect(expectAction(Keymap.resolve(palette, undefined, Keys.escape))._tag).toBe("ClosePalette")
    expect(expectAction(Keymap.resolve(palette, undefined, Keys.ctrl("o")))._tag).toBe("ClosePalette")
  })

  test("overlay surface closes on any key", () => {
    expect(expectAction(Keymap.resolve(inputCtx({ surface: "overlay" }), undefined, Keys.escape))._tag).toBe(
      "CloseOverlay",
    )
  })
})
