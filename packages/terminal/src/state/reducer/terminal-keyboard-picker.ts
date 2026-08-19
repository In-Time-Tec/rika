import { Function } from "effect"
import type { Message } from "../model/terminal-message"
import type { Model } from "../model/terminal-state"
import { filteredFiles, filteredThreads } from "../model/terminal-thread-navigation"
import { filter } from "../../presentation/terminal/command-palette"
import { isPrintable, type Key } from "../../presentation/terminal/terminal-keymap"

export interface KeyboardPickerContext {
  readonly insert: (model: Model, value: string) => Model
  readonly erase: (model: Model, length: number) => Model
  readonly lastCharacterLength: (value: string) => number
  readonly fileMention: (path: string) => string
  readonly questionKey: (key: Key) => boolean
  readonly insertWhileShortcutsOpen: (model: Model, value: string) => Model
  readonly continueShortcutsAfterEdit: (before: Model, after: Model) => Model
}

const reduceKeyboardPickerImpl = (
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
        threadSwitcher: { open: false, query: "", selected: 0, kind: "switch" },
        threadPreview: { _tag: "Idle" },
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
              },
              threadPreview: { _tag: "Idle" },
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
        },
        threadPreview: { _tag: "Idle" },
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
        },
      }
      const restored =
        model.threadSwitcher.kind === "mention" ? erase(next, lastCharacterLength(model.threadSwitcher.query)) : next
      return filteredThreads(restored).length === 0
        ? { ...restored, threadPreview: { _tag: "Idle" as const } }
        : restored
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
        },
      }
    const next = {
      ...model,
      threadSwitcher: {
        ...model.threadSwitcher,
        query: model.threadSwitcher.query + key.sequence,
        selected: 0,
      },
    }
    const filtered = model.threadSwitcher.kind === "mention" ? insert(next, key.sequence) : next
    return filteredThreads(filtered).length === 0 ? { ...filtered, threadPreview: { _tag: "Idle" as const } } : filtered
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
  if (key.ctrl && (key.name === "s" || key.name === "m") && !model.busy)
    return model.modePicker.open
      ? update(model, { _tag: "ModeTurned", offset: 1 })
      : update(model, { _tag: "ModeSelectorOpened" })
  if (key.ctrl && key.name === "c" && !model.cancelPending && model.busy)
    return { ...model, activity: { _tag: "Waiting" }, cancelPending: model.busy, pendingAction: { _tag: "Cancel" } }
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
    if (key.name === "left" || key.name === "up") return update(model, { _tag: "ModeTurned", offset: -1 })
    if (key.name === "right" || key.name === "down") return update(model, { _tag: "ModeTurned", offset: 1 })
    if (key.name === "return") return update(model, { _tag: "ModeCommitted" })
    return model
  }
  if (model.palette.open) {
    if (model.palette.limit !== undefined) {
      if (key.name === "return") {
        if (!/^\d+$/.test(model.palette.query)) return model
        const value = Number(model.palette.query)
        if (!Number.isSafeInteger(value) || value > 1_024) return model
        return {
          ...model,
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          pendingAction: { _tag: "SetSubagentLimit", limit: model.palette.limit, value },
        }
      }
      if (key.name === "backspace")
        return { ...model, palette: { ...model.palette, query: model.palette.query.slice(0, -1) } }
      return isPrintable(key) && /^\d$/.test(key.sequence)
        ? { ...model, palette: { ...model.palette, query: model.palette.query + key.sequence } }
        : model
    }
    const results = filter(model.palette.query)
    let selected = model.palette.selected
    if (key.name === "up") selected = Math.max(0, model.palette.selected - 1)
    else if (key.name === "down") {
      selected = Math.max(0, Math.min(results.length - 1, model.palette.selected + 1))
    }
    if (key.name === "return") {
      const action = results[selected]?.action
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
              modePicker: {
                open: true,
                selected: Object.keys(model.modeRoutes).indexOf(
                  model.rememberedMode !== undefined && Object.hasOwn(model.modeRoutes, model.rememberedMode)
                    ? model.rememberedMode
                    : model.mode,
                ),
              },
            }
      if (action._tag === "SwitchThread")
        return {
          ...model,
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          threadSwitcher: { open: true, query: "", selected: 0, kind: "switch" },
        }
      if (action._tag === "ToggleContextDetails") return update(model, { _tag: "ContextDetailsToggled" })
      if (action._tag === "ToggleFastMode")
        return {
          ...model,
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          fastMode: !model.fastMode,
        }
      if (action._tag === "EditSubagentLimit")
        return {
          ...model,
          paletteOpen: true,
          palette: { open: true, query: "", selected: 0, limit: action.limit },
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
          threadSwitcher: { open: true, query: "", selected: 0, kind: "mention" },
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

export const reduceKeyboardPicker: {
  (
    arg1: Parameters<typeof reduceKeyboardPickerImpl>[1],
    arg2: Parameters<typeof reduceKeyboardPickerImpl>[2],
    arg3: Parameters<typeof reduceKeyboardPickerImpl>[3],
  ): (arg0: Parameters<typeof reduceKeyboardPickerImpl>[0]) => ReturnType<typeof reduceKeyboardPickerImpl>
  (
    arg0: Parameters<typeof reduceKeyboardPickerImpl>[0],
    arg1: Parameters<typeof reduceKeyboardPickerImpl>[1],
    arg2: Parameters<typeof reduceKeyboardPickerImpl>[2],
    arg3: Parameters<typeof reduceKeyboardPickerImpl>[3],
  ): ReturnType<typeof reduceKeyboardPickerImpl>
} = Function.dual(4, reduceKeyboardPickerImpl)
