import { modeIds } from "@rika/configuration/behavior-mode"
import type { Message } from "../model/terminal-message"
import type { Model } from "../model/terminal-state"
import { idle } from "../model/terminal-loadable-state"
import { filteredFiles, filteredThreads } from "../model/terminal-thread-navigation"
import { filter, type PaletteAction } from "../../presentation/terminal/command-palette"
import { isPrintable, type Key } from "../../presentation/terminal/terminal-keymap"
import { expandPastedText } from "../model/terminal-composer-paste"

export interface KeyboardPickerContext {
  readonly insert: (model: Model, value: string) => Model
  readonly erase: (model: Model, length: number) => Model
  readonly lastCharacterLength: (value: string) => number
  readonly fileMention: (path: string) => string
  readonly questionKey: (key: Key) => boolean
  readonly insertWhileShortcutsOpen: (model: Model, value: string) => Model
  readonly continueShortcutsAfterEdit: (before: Model, after: Model) => Model
}

export const reduceKeyboardPicker = (
  model: Model,
  key: Key,
  update: (model: Model, message: Message) => Model,
  context: KeyboardPickerContext,
): Model | undefined => {
  const {
    insert,
    erase,
    lastCharacterLength,
    fileMention,
    questionKey,
    insertWhileShortcutsOpen,
    continueShortcutsAfterEdit,
  } = context
  if (model.threadSwitcher.open) {
    const threads = filteredThreads(model)
    if (key.name === "escape")
      return {
        ...model,
        threadSwitcher: { open: false, query: "", selected: 0, kind: "switch", previewScroll: 0 },
        threadPreview: idle,
      }
    if (key.name === "return") {
      const thread = threads[model.threadSwitcher.selected]
      if (thread === undefined) return model
      if (model.threadSwitcher.kind === "mention") {
        return insert(
          erase(
            {
              ...model,
              threadSwitcher: {
                open: false,
                query: "",
                selected: 0,
                kind: "switch",
                previewScroll: 0,
              },
              threadPreview: idle,
            },
            Math.min(2 + model.threadSwitcher.query.length, model.cursor),
          ),
          `@${thread.id} `,
        )
      }
      return {
        ...model,
        threadSwitcher: {
          open: false,
          query: "",
          selected: 0,
          kind: "switch",
          previewScroll: 0,
        },
        threadPreview: idle,
        pendingAction: thread.id === model.currentThreadId ? undefined : { _tag: "SelectThread", id: thread.id },
      }
    }
    if (key.name === "backspace") {
      if (model.threadSwitcher.kind === "mention" && model.threadSwitcher.query.length === 0)
        return erase(
          {
            ...model,
            threadSwitcher: {
              open: false,
              query: "",
              selected: 0,
              kind: "switch",
              previewScroll: 0,
            },
            filePicker: { ...model.filePicker, open: true, query: "", selected: 0 },
          },
          1,
        )
      const next = {
        ...model,
        threadSwitcher: {
          ...model.threadSwitcher,
          query: model.threadSwitcher.query.slice(0, -lastCharacterLength(model.threadSwitcher.query)),
          selected: 0,
          previewScroll: 0,
        },
      }
      const restored =
        model.threadSwitcher.kind === "mention" ? erase(next, lastCharacterLength(model.threadSwitcher.query)) : next
      return filteredThreads(restored).length === 0 ? { ...restored, threadPreview: idle } : restored
    }
    let selected = model.threadSwitcher.selected
    if (key.name === "up") {
      selected = (model.threadSwitcher.selected + Math.max(1, threads.length) - 1) % Math.max(1, threads.length)
    } else if (key.name === "down") {
      selected = (model.threadSwitcher.selected + 1) % Math.max(1, threads.length)
    }
    if (!isPrintable(key))
      return {
        ...model,
        threadSwitcher: {
          ...model.threadSwitcher,
          selected,
          previewScroll: selected === model.threadSwitcher.selected ? model.threadSwitcher.previewScroll : 0,
        },
      }
    const next = {
      ...model,
      threadSwitcher: {
        ...model.threadSwitcher,
        query: model.threadSwitcher.query + key.sequence,
        selected: 0,
        previewScroll: 0,
      },
    }
    const filtered = model.threadSwitcher.kind === "mention" ? insert(next, key.sequence) : next
    return filteredThreads(filtered).length === 0 ? { ...filtered, threadPreview: idle } : filtered
  }
  if (key.ctrl && key.name === "o") {
    const open = !model.palette.open
    return {
      ...model,
      paletteOpen: open,
      palette: { open, query: "", selected: 0 },
      modePicker: { ...model.modePicker, open: false },
      filePicker: { ...model.filePicker, open: false },
      shortcutsOpen: false,
    }
  }
  if (!model.filePicker.open && !key.ctrl && !key.alt && !key.meta && key.sequence === "@")
    return insert(
      {
        ...model,
        paletteOpen: false,
        palette: { open: false, query: "", selected: 0 },
        modePicker: { ...model.modePicker, open: false },
        filePicker: { ...model.filePicker, open: true, query: "", selected: 0 },
        shortcutsOpen: false,
      },
      "@",
    )
  if (key.ctrl && (key.name === "s" || key.name === "m") && !model.busy) {
    if (model.modePicker.open)
      return { ...model, modePicker: { open: true, selected: (model.modePicker.selected + 1) % 4 } }
    return {
      ...model,
      paletteOpen: false,
      palette: { open: false, query: "", selected: 0 },
      modePicker: { open: true, selected: modeIds.indexOf(model.mode) },
      filePicker: { ...model.filePicker, open: false },
      shortcutsOpen: false,
    }
  }
  if (key.ctrl && key.name === "c" && !model.cancelPending && model.busy)
    return { ...model, activity: { _tag: "Waiting" }, cancelPending: model.busy, pendingAction: { _tag: "Cancel" } }
  if (key.ctrl && key.name === "s" && model.busy && !model.cancelPending && model.input.length > 0) {
    const steerText = expandPastedText(model.input, model.pastedText)
    return {
      ...model,
      pendingAction: {
        _tag: "Steer",
        prompt: steerText,
        ...(model.activeTurnId === undefined ? {} : { turnId: model.activeTurnId }),
      },
      ...(model.activeTurnId === undefined
        ? {}
        : { pendingSteering: [...model.pendingSteering, { turnId: model.activeTurnId, text: steerText }] }),
      input: "",
      cursor: 0,
    }
  }
  if (key.ctrl && key.name === "return" && model.busy && model.input.length > 0)
    return { ...model, pendingAction: { _tag: "InterruptAndSend", prompt: model.input }, input: "", cursor: 0 }
  if (key.alt && key.name === "t") {
    return update(model, { _tag: "WorkspaceFilesToggled" })
  }
  if (key.alt && key.name === "s") return update(model, { _tag: "SidebarViewToggled" })
  if (
    key.name === "escape" &&
    (model.palette.open || model.modePicker.open || model.filePicker.open || model.shortcutsOpen)
  )
    return {
      ...model,
      paletteOpen: false,
      palette: { open: false, query: "", selected: 0 },
      modePicker: { ...model.modePicker, open: false },
      filePicker: { ...model.filePicker, open: false, query: "", selected: 0 },
      shortcutsOpen: false,
      shortcutsTrigger: undefined,
    }
  if (model.shortcutsOpen) {
    if (questionKey(key)) return { ...model, shortcutsOpen: false, shortcutsTrigger: undefined }
    if (isPrintable(key)) return insertWhileShortcutsOpen(model, key.sequence)
    const next = update({ ...model, shortcutsOpen: false, shortcutsTrigger: undefined }, { _tag: "KeyPressed", key })
    return continueShortcutsAfterEdit(model, next)
  }
  if (model.modePicker.open) {
    if (key.name === "escape") return { ...model, modePicker: { ...model.modePicker, open: false } }
    let selected = model.modePicker.selected
    if (key.name === "left" || key.name === "up") selected = (model.modePicker.selected + 3) % 4
    else if (key.name === "right" || key.name === "down") selected = (model.modePicker.selected + 1) % 4
    if (key.name === "return")
      return {
        ...model,
        mode: modeIds[selected]!,
        modePicker: { open: false, selected },
      }
    return { ...model, modePicker: { open: true, selected } }
  }
  if (model.palette.open) {
    const results = filter(model.palette.query)
    let selected = model.palette.selected
    if (key.name === "up") selected = Math.max(0, model.palette.selected - 1)
    else if (key.name === "down") {
      selected = Math.max(0, Math.min(results.length - 1, model.palette.selected + 1))
    }
    if (key.name === "return") {
      const action = results[selected]?.action as PaletteAction | undefined
      if (action === undefined) return { ...model, palette: { ...model.palette, selected: 0 } }
      if (action._tag === "OpenModePicker")
        return model.busy
          ? {
              ...model,
              paletteOpen: false,
              palette: { open: false, query: "", selected: 0 },
            }
          : {
              ...model,
              paletteOpen: false,
              palette: { open: false, query: "", selected: 0 },
              modePicker: { open: true, selected: modeIds.indexOf(model.mode) },
            }
      if (action._tag === "SwitchThread")
        return {
          ...model,
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          threadSwitcher: { open: true, query: "", selected: 0, kind: "switch", previewScroll: 0 },
        }
      if (action._tag === "ToggleFastMode")
        return {
          ...model,
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          fastMode: !model.fastMode,
        }
      return {
        ...model,
        paletteOpen: false,
        palette: { open: false, query: "", selected: 0 },
        pendingAction: action,
      }
    }
    if (key.name === "backspace")
      return { ...model, palette: { ...model.palette, query: model.palette.query.slice(0, -1), selected: 0 } }
    return isPrintable(key)
      ? { ...model, palette: { ...model.palette, query: model.palette.query + key.sequence, selected: 0 } }
      : { ...model, palette: { ...model.palette, selected } }
  }
  if (model.filePicker.open) {
    const mentionLength = Math.min(1 + model.filePicker.query.length, model.cursor)
    if (isPrintable(key) && key.sequence === "@" && model.filePicker.query === "")
      return insert(
        {
          ...model,
          filePicker: { ...model.filePicker, open: false },
          threadSwitcher: { open: true, query: "", selected: 0, kind: "mention", previewScroll: 0 },
        },
        "@",
      )
    const files = filteredFiles(model)
    let selected = model.filePicker.selected
    if (key.name === "up") {
      selected = (model.filePicker.selected + Math.max(1, files.length) - 1) % Math.max(1, files.length)
    } else if (key.name === "down") {
      selected = (model.filePicker.selected + 1) % Math.max(1, files.length)
    }
    if (key.name === "return") {
      const file = files[selected]
      return file === undefined
        ? { ...model, filePicker: { ...model.filePicker, open: false } }
        : insert(
            erase(
              { ...model, filePicker: { ...model.filePicker, open: false, query: "", selected: 0 } },
              mentionLength,
            ),
            fileMention(file),
          )
    }
    if (key.name === "backspace") {
      if (model.filePicker.query.length > 0)
        return erase(
          {
            ...model,
            filePicker: {
              ...model.filePicker,
              query: model.filePicker.query.slice(0, -lastCharacterLength(model.filePicker.query)),
              selected: 0,
            },
          },
          lastCharacterLength(model.filePicker.query),
        )
      return erase({ ...model, filePicker: { ...model.filePicker, open: false, selected: 0 } }, 1)
    }
    return isPrintable(key)
      ? insert(
          {
            ...model,
            filePicker: { ...model.filePicker, query: model.filePicker.query + key.sequence, selected: 0 },
          },
          key.sequence,
        )
      : { ...model, filePicker: { ...model.filePicker, selected } }
  }
  return undefined
}
