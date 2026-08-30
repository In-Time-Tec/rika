import { Function } from "effect"
import type { Message } from "../message"
import type { Model } from "../model"
import { filteredFiles, filteredThreads } from "../thread/navigation"
import { filter } from "../../presentation/terminal/command-palette"
import { isPrintable, type Key } from "../../presentation/terminal/keymap"
import type { CancelAction } from "../../terminal-session"

export interface KeyboardPickerContext {
  readonly insert: (model: Model, value: string) => Model
  readonly erase: (model: Model, length: number) => Model
  readonly lastCharacterLength: (value: string) => number
  readonly fileMention: (path: string) => string
  readonly questionKey: (key: Key) => boolean
  readonly insertWhileShortcutsOpen: (model: Model, value: string) => Model
  readonly continueShortcutsAfterEdit: (before: Model, after: Model) => Model
}

type Update = (model: Model, message: Message) => Model

const reduceThreadSwitcher = (model: Model, key: Key, context: KeyboardPickerContext): Model => {
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
    const closed = {
      ...model,
      threadSwitcher: { open: false, query: "", selected: 0, kind: "switch" as const },
      threadPreview: { _tag: "Idle" as const },
    }
    return model.threadSwitcher.kind === "mention"
      ? context.insert(
          context.erase(closed, Math.min(2 + model.threadSwitcher.query.length, model.cursor)),
          `@${thread.id} `,
        )
      : {
          ...closed,
          pendingAction: thread.id === model.currentThreadId ? undefined : { _tag: "SelectThread", id: thread.id },
        }
  }
  if (key.name === "backspace") return eraseThreadSwitcherQuery(model, context)
  return moveOrFilterThreads(model, key, threads.length, context)
}

const eraseThreadSwitcherQuery = (model: Model, context: KeyboardPickerContext): Model => {
  if (model.threadSwitcher.kind === "mention" && model.threadSwitcher.query.length === 0)
    return context.erase(
      {
        ...model,
        threadSwitcher: { open: false, query: "", selected: 0, kind: "switch" },
        filePicker: { ...model.filePicker, open: true, query: "", selected: 0 },
      },
      1,
    )
  const length = context.lastCharacterLength(model.threadSwitcher.query)
  const next = {
    ...model,
    threadSwitcher: { ...model.threadSwitcher, query: model.threadSwitcher.query.slice(0, -length), selected: 0 },
  }
  const restored = model.threadSwitcher.kind === "mention" ? context.erase(next, length) : next
  return filteredThreads(restored).length === 0 ? { ...restored, threadPreview: { _tag: "Idle" as const } } : restored
}

const moveOrFilterThreads = (model: Model, key: Key, threadCount: number, context: KeyboardPickerContext): Model => {
  const count = Math.max(1, threadCount)
  let selected = model.threadSwitcher.selected
  if (key.name === "up") selected = (model.threadSwitcher.selected + count - 1) % count
  else if (key.name === "down") selected = (model.threadSwitcher.selected + 1) % count
  if (!isPrintable(key)) return { ...model, threadSwitcher: { ...model.threadSwitcher, selected } }
  const next = {
    ...model,
    threadSwitcher: { ...model.threadSwitcher, query: model.threadSwitcher.query + key.sequence, selected: 0 },
  }
  const filtered = model.threadSwitcher.kind === "mention" ? context.insert(next, key.sequence) : next
  return filteredThreads(filtered).length === 0 ? { ...filtered, threadPreview: { _tag: "Idle" as const } } : filtered
}

const reduceGlobalPickerKey = (model: Model, key: Key, update: Update, context: KeyboardPickerContext) => {
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
    return context.insert(
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
  return reduceExecutionKey(model, key, update)
}

const reduceExecutionKey = (model: Model, key: Key, update: Update): Model | undefined => {
  const unresolvedDraft = model.submittedDrafts.find((draft) => draft.turnId === undefined)
  if (key.ctrl && key.name === "c" && !model.cancelPending && (model.busy || unresolvedDraft !== undefined))
    return requestCancellation(model, unresolvedDraft?.submissionId)
  if (key.ctrl && key.name === "return" && model.busy && model.input.length > 0)
    return { ...model, pendingAction: { _tag: "InterruptAndSend", prompt: model.input }, input: "", cursor: 0 }
  if (key.alt && key.name === "t") return update(model, { _tag: "WorkspaceFilesToggled" })
  if (key.alt && key.name === "s") return update(model, { _tag: "SidebarViewToggled" })
  return undefined
}

const requestCancellation = (model: Model, submissionId: string | undefined): Model => {
  const pendingAction: CancelAction = { _tag: "Cancel" }
  if (submissionId !== undefined) pendingAction.submissionId = submissionId
  if (model.currentThreadId !== undefined) pendingAction.threadId = model.currentThreadId
  return { ...model, activity: { _tag: "Waiting" }, cancelPending: true, pendingAction }
}

const closeOpenPicker = (model: Model, key: Key): Model | undefined => {
  if (key.name !== "escape") return undefined
  if (!model.palette.open && !model.modePicker.open && !model.filePicker.open && !model.shortcutsOpen) return undefined
  return {
    ...model,
    paletteOpen: false,
    palette: { open: false, query: "", selected: 0 },
    modePicker: { ...model.modePicker, open: false },
    filePicker: { ...model.filePicker, open: false, query: "", selected: 0 },
    shortcutsOpen: false,
    shortcutsTrigger: undefined,
  }
}

const reduceShortcuts = (model: Model, key: Key, update: Update, context: KeyboardPickerContext): Model => {
  if (context.questionKey(key)) return { ...model, shortcutsOpen: false, shortcutsTrigger: undefined }
  if (isPrintable(key)) return context.insertWhileShortcutsOpen(model, key.sequence)
  const next = update({ ...model, shortcutsOpen: false, shortcutsTrigger: undefined }, { _tag: "KeyPressed", key })
  return context.continueShortcutsAfterEdit(model, next)
}

const reduceModePicker = (model: Model, key: Key, update: Update): Model => {
  if (key.name === "escape") return { ...model, modePicker: { ...model.modePicker, open: false } }
  if (key.name === "left" || key.name === "up") return update(model, { _tag: "ModeTurned", offset: -1 })
  if (key.name === "right" || key.name === "down") return update(model, { _tag: "ModeTurned", offset: 1 })
  return key.name === "return" ? update(model, { _tag: "ModeCommitted" }) : model
}

const reduceLimitPicker = (model: Model, key: Key): Model => {
  if (key.name === "return") {
    if (!/^\d+$/.test(model.palette.query)) return model
    const value = Number(model.palette.query)
    if (!Number.isSafeInteger(value) || value > 1_024) return model
    return {
      ...model,
      paletteOpen: false,
      palette: { open: false, query: "", selected: 0 },
      pendingAction: { _tag: "SetSubagentLimit", limit: model.palette.limit!, value },
    }
  }
  if (key.name === "backspace")
    return { ...model, palette: { ...model.palette, query: model.palette.query.slice(0, -1) } }
  return isPrintable(key) && /^\d$/.test(key.sequence)
    ? { ...model, palette: { ...model.palette, query: model.palette.query + key.sequence } }
    : model
}

const commitPaletteAction = (model: Model, selected: number, update: Update): Model => {
  const action = filter(model.palette.query)[selected]?.action
  if (action === undefined) return { ...model, palette: { ...model.palette, selected: 0 } }
  const closed = { ...model, paletteOpen: false, palette: { open: false, query: "", selected: 0 } }
  if (action._tag === "OpenModePicker")
    return model.busy
      ? closed
      : {
          ...closed,
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
    return { ...closed, threadSwitcher: { open: true, query: "", selected: 0, kind: "switch" } }
  if (action._tag === "ToggleContextDetails") return update(model, { _tag: "ContextDetailsToggled" })
  if (action._tag === "ToggleFastMode") return { ...closed, fastMode: !model.fastMode }
  if (action._tag === "EditSubagentLimit")
    return { ...model, paletteOpen: true, palette: { open: true, query: "", selected: 0, limit: action.limit } }
  return { ...closed, pendingAction: action }
}

const reducePalette = (model: Model, key: Key, update: Update): Model => {
  if (model.palette.limit !== undefined) return reduceLimitPicker(model, key)
  const results = filter(model.palette.query)
  let selected = model.palette.selected
  if (key.name === "up") selected = Math.max(0, model.palette.selected - 1)
  else if (key.name === "down") selected = Math.max(0, Math.min(results.length - 1, model.palette.selected + 1))
  if (key.name === "return") return commitPaletteAction(model, selected, update)
  if (key.name === "backspace")
    return { ...model, palette: { ...model.palette, query: model.palette.query.slice(0, -1), selected: 0 } }
  return isPrintable(key)
    ? { ...model, palette: { ...model.palette, query: model.palette.query + key.sequence, selected: 0 } }
    : { ...model, palette: { ...model.palette, selected } }
}

const reduceFilePicker = (model: Model, key: Key, context: KeyboardPickerContext): Model => {
  if (isPrintable(key) && key.sequence === "@" && model.filePicker.query === "")
    return context.insert(
      {
        ...model,
        filePicker: { ...model.filePicker, open: false },
        threadSwitcher: { open: true, query: "", selected: 0, kind: "mention" },
      },
      "@",
    )
  const files = filteredFiles(model)
  const count = Math.max(1, files.length)
  let selected = model.filePicker.selected
  if (key.name === "up") selected = (model.filePicker.selected + count - 1) % count
  else if (key.name === "down") selected = (model.filePicker.selected + 1) % count
  if (key.name === "return") return commitFileMention(model, files[selected], context)
  if (key.name === "backspace") return eraseFileQuery(model, context)
  return isPrintable(key)
    ? context.insert(
        {
          ...model,
          filePicker: { ...model.filePicker, query: model.filePicker.query + key.sequence, selected: 0 },
        },
        key.sequence,
      )
    : { ...model, filePicker: { ...model.filePicker, selected } }
}

const commitFileMention = (model: Model, file: string | undefined, context: KeyboardPickerContext): Model => {
  if (file === undefined) return { ...model, filePicker: { ...model.filePicker, open: false } }
  const mentionLength = Math.min(1 + model.filePicker.query.length, model.cursor)
  return context.insert(
    context.erase(
      { ...model, filePicker: { ...model.filePicker, open: false, query: "", selected: 0 } },
      mentionLength,
    ),
    context.fileMention(file),
  )
}

const eraseFileQuery = (model: Model, context: KeyboardPickerContext): Model => {
  if (model.filePicker.query.length === 0)
    return context.erase({ ...model, filePicker: { ...model.filePicker, open: false, selected: 0 } }, 1)
  const length = context.lastCharacterLength(model.filePicker.query)
  return context.erase(
    {
      ...model,
      filePicker: { ...model.filePicker, query: model.filePicker.query.slice(0, -length), selected: 0 },
    },
    length,
  )
}

const reduceKeyboardPickerImpl = (
  model: Model,
  key: Key,
  update: (model: Model, message: Message) => Model,
  context: KeyboardPickerContext,
): Model | undefined => {
  if (model.threadSwitcher.open) return reduceThreadSwitcher(model, key, context)
  const global = reduceGlobalPickerKey(model, key, update, context)
  if (global !== undefined) return global
  const closed = closeOpenPicker(model, key)
  if (closed !== undefined) return closed
  if (model.shortcutsOpen) return reduceShortcuts(model, key, update, context)
  if (model.modePicker.open) return reduceModePicker(model, key, update)
  if (model.palette.open) return reducePalette(model, key, update)
  if (model.filePicker.open) return reduceFilePicker(model, key, context)
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
