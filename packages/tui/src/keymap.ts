import * as Keys from "./keys"

export type Surface = "input" | "palette" | "modepicker" | "overlay" | "inspect"

export interface Context {
  readonly surface: Surface
  readonly busy: boolean
  readonly inputEmpty: boolean
  readonly trailingBackslash: boolean
  readonly queueSelected: boolean
  readonly navigating: boolean
}

export type Action =
  | { readonly _tag: "Insert"; readonly text: string }
  | { readonly _tag: "Paste"; readonly text: string }
  | { readonly _tag: "Backspace" }
  | { readonly _tag: "DeleteForward" }
  | { readonly _tag: "DeleteWordBackward" }
  | { readonly _tag: "DeleteWordForward" }
  | { readonly _tag: "DeleteToLineStart" }
  | { readonly _tag: "DeleteToLineEnd" }
  | { readonly _tag: "Submit" }
  | { readonly _tag: "Newline" }
  | { readonly _tag: "CursorLeft" }
  | { readonly _tag: "CursorRight" }
  | { readonly _tag: "CursorHome" }
  | { readonly _tag: "CursorEnd" }
  | { readonly _tag: "WordLeft" }
  | { readonly _tag: "WordRight" }
  | { readonly _tag: "FocusPrev" }
  | { readonly _tag: "FocusNext" }
  | { readonly _tag: "OpenPalette" }
  | { readonly _tag: "ClosePalette" }
  | { readonly _tag: "PaletteUp" }
  | { readonly _tag: "PaletteDown" }
  | { readonly _tag: "PaletteRun" }
  | { readonly _tag: "PaletteInsert"; readonly text: string }
  | { readonly _tag: "PaletteBackspace" }
  | { readonly _tag: "OpenShortcuts" }
  | { readonly _tag: "CloseOverlay" }
  | { readonly _tag: "OpenModePicker" }
  | { readonly _tag: "ModePickerNext" }
  | { readonly _tag: "ModePickerPrev" }
  | { readonly _tag: "ModePickerClose" }
  | { readonly _tag: "ToggleDetails" }
  | { readonly _tag: "CycleReasoning" }
  | { readonly _tag: "ToggleFastMode" }
  | { readonly _tag: "OpenEditor" }
  | { readonly _tag: "PasteImage" }
  | { readonly _tag: "ForceInterrupt" }
  | { readonly _tag: "Steer" }
  | { readonly _tag: "Quit" }
  | { readonly _tag: "ArchiveNew" }
  | { readonly _tag: "ArchiveQuit" }
  | { readonly _tag: "FileMention" }
  | { readonly _tag: "DequeueSelected" }
  | { readonly _tag: "HistoryPrev" }
  | { readonly _tag: "NavPrevMessage" }
  | { readonly _tag: "NavNextMessage" }
  | { readonly _tag: "EditMessage" }
  | { readonly _tag: "CloseInspect" }
  | { readonly _tag: "InspectUp" }
  | { readonly _tag: "InspectDown" }
  | { readonly _tag: "InspectRefresh" }
  | { readonly _tag: "InspectToggleView" }

export type Pending = "ctrl-c" | "esc" | "enter"

export type Resolution =
  | { readonly _tag: "Action"; readonly action: Action }
  | { readonly _tag: "Pending"; readonly chord: Pending }
  | { readonly _tag: "Ignore" }

const action = (value: Action): Resolution => ({ _tag: "Action", action: value })
const pending = (chord: Pending): Resolution => ({ _tag: "Pending", chord })
const ignore: Resolution = { _tag: "Ignore" }

const isEnter = (key: Keys.Key) => key.name === "return" || key.name === "enter"
const isEscape = (key: Keys.Key) => key.name === "escape" || key.name === "esc"

export const resolve = (context: Context, current: Pending | undefined, key: Keys.Key): Resolution => {
  if (current !== undefined) {
    const completion = resolveChord(current, key)
    if (completion !== undefined) return completion
  }

  switch (context.surface) {
    case "palette":
      return resolvePalette(key)
    case "modepicker":
      return resolveModePicker(key)
    case "overlay":
      return resolveOverlay(key)
    case "inspect":
      return resolveInspect(key)
    default:
      return resolveInput(context, key)
  }
}

const resolveChord = (current: Pending, key: Keys.Key): Resolution | undefined => {
  if (current === "ctrl-c") {
    if (key.ctrl && key.name === "c") return action({ _tag: "Quit" })
    if (key.ctrl && key.name === "n") return action({ _tag: "ArchiveNew" })
    if (key.ctrl && key.name === "e") return action({ _tag: "ArchiveQuit" })
    return undefined
  }
  if (current === "esc") {
    if (isEscape(key)) return action({ _tag: "ForceInterrupt" })
    return undefined
  }
  if (isEnter(key) && !key.shift) return action({ _tag: "Steer" })
  return undefined
}

const resolvePalette = (key: Keys.Key): Resolution => {
  if (key.ctrl && key.name === "o") return action({ _tag: "ClosePalette" })
  if (isEscape(key)) return action({ _tag: "ClosePalette" })
  if (isEnter(key)) return action({ _tag: "PaletteRun" })
  if (key.name === "up") return action({ _tag: "PaletteUp" })
  if (key.name === "down") return action({ _tag: "PaletteDown" })
  if (key.name === "backspace") return action({ _tag: "PaletteBackspace" })
  if (Keys.isPrintable(key)) return action({ _tag: "PaletteInsert", text: Keys.char(key) })
  return ignore
}

const resolveModePicker = (key: Keys.Key): Resolution => {
  if (key.ctrl && key.name === "s") return action({ _tag: "ModePickerNext" })
  if (key.name === "down") return action({ _tag: "ModePickerNext" })
  if (key.name === "up") return action({ _tag: "ModePickerPrev" })
  if (isEnter(key) || isEscape(key)) return action({ _tag: "ModePickerClose" })
  return ignore
}

const resolveOverlay = (_key: Keys.Key): Resolution => action({ _tag: "CloseOverlay" })

const resolveInspect = (key: Keys.Key): Resolution => {
  if (isEscape(key)) return action({ _tag: "CloseInspect" })
  if (key.name === "q") return action({ _tag: "CloseInspect" })
  if (key.name === "up" || key.name === "k") return action({ _tag: "InspectUp" })
  if (key.name === "down" || key.name === "j") return action({ _tag: "InspectDown" })
  if (key.name === "r") return action({ _tag: "InspectRefresh" })
  if (key.name === "tab") return action({ _tag: "InspectToggleView" })
  return ignore
}

const resolveInput = (context: Context, key: Keys.Key): Resolution => {
  if (key.name === "paste" && key.sequence.length > 0) return action({ _tag: "Paste", text: key.sequence })

  if (key.ctrl && key.name === "c") return pending("ctrl-c")
  if (key.ctrl && key.name === "o") return action({ _tag: "OpenPalette" })
  if (key.ctrl && key.name === "s") return action({ _tag: "OpenModePicker" })
  if (key.ctrl && key.name === "g") return action({ _tag: "OpenEditor" })
  if (key.ctrl && key.name === "v") return action({ _tag: "PasteImage" })
  if (key.ctrl && key.name === "r") return action({ _tag: "HistoryPrev" })
  if (key.ctrl && key.name === "j") return action({ _tag: "Newline" })
  if (key.name === "linefeed") return action({ _tag: "Newline" })

  if (key.alt && key.name === "t") return action({ _tag: "ToggleDetails" })
  if (key.alt && key.name === "d") return action({ _tag: "CycleReasoning" })
  if (key.alt && key.name === "r") return action({ _tag: "ToggleFastMode" })

  if (context.queueSelected) {
    if (isEnter(key) && !key.shift) return action({ _tag: "Steer" })
    if (key.name === "backspace") return action({ _tag: "DequeueSelected" })
  }

  if (key.ctrl && key.name === "w") return action({ _tag: "DeleteWordBackward" })
  if (key.ctrl && key.name === "u") return action({ _tag: "DeleteToLineStart" })
  if (key.ctrl && key.name === "k") return action({ _tag: "DeleteToLineEnd" })
  if (key.ctrl && key.name === "d") return action({ _tag: "DeleteForward" })
  if ((key.ctrl || key.alt) && key.name === "backspace") return action({ _tag: "DeleteWordBackward" })
  if ((key.ctrl || key.alt) && key.name === "delete") return action({ _tag: "DeleteWordForward" })
  if ((key.ctrl || key.alt) && key.name === "left") return action({ _tag: "WordLeft" })
  if ((key.ctrl || key.alt) && key.name === "right") return action({ _tag: "WordRight" })
  if (key.alt && key.name === "b") return action({ _tag: "WordLeft" })
  if (key.alt && key.name === "f") return action({ _tag: "WordRight" })

  if (context.navigating && key.sequence === "e") return action({ _tag: "EditMessage" })
  if (key.name === "backtab") return action({ _tag: "NavNextMessage" })
  if (key.name === "tab") return action(key.shift ? { _tag: "NavNextMessage" } : { _tag: "NavPrevMessage" })

  if (isEscape(key)) return pending("esc")

  if (isEnter(key)) {
    if (key.shift) return action({ _tag: "Newline" })
    if (context.trailingBackslash) return action({ _tag: "Newline" })
    return action({ _tag: "Submit" })
  }

  if (key.name === "backspace") return action({ _tag: "Backspace" })
  if (key.name === "left") return action({ _tag: "CursorLeft" })
  if (key.name === "right") return action({ _tag: "CursorRight" })
  if (key.name === "home") return action({ _tag: "CursorHome" })
  if (key.name === "end") return action({ _tag: "CursorEnd" })
  if (key.name === "up") return action({ _tag: "FocusPrev" })
  if (key.name === "down") return action({ _tag: "FocusNext" })

  if (key.sequence === "?" && context.inputEmpty) return action({ _tag: "OpenShortcuts" })
  if (key.sequence === "@") return action({ _tag: "FileMention" })

  if (Keys.isPrintable(key)) return action({ _tag: "Insert", text: Keys.char(key) })
  return ignore
}
