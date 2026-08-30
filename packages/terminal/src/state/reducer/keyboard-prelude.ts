import { Function } from "effect"
import type { Message } from "../message"
import type { Model } from "../model"
import type { Key } from "../../presentation/terminal/keymap"
import { filteredThreads } from "../thread/navigation"
import { expandPastedText } from "../composer/paste"

const reduceEditing = (model: Model, key: Key): Model | undefined => {
  if (model.editingTurnId === undefined) return undefined
  if (key.name === "escape") {
    const restore = model.editReturn ?? { input: "", attachments: [] }
    return {
      ...model,
      editingTurnId: undefined,
      editReturn: undefined,
      queueSelection: undefined,
      input: restore.input,
      cursor: restore.input.length,
      pastedText: [...restore.attachments],
    }
  }
  if (key.name !== "return" || key.shift || (model.cursor > 0 && model.input[model.cursor - 1] === "\\"))
    return undefined
  return {
    ...model,
    pendingAction: {
      _tag: "EditQueued",
      id: model.editingTurnId,
      prompt: expandPastedText(model.input, model.pastedText),
    },
    editingTurnId: undefined,
    editReturn: undefined,
    input: "",
    cursor: 0,
    pastedText: [],
  }
}

const toggleThreadSidebar = (model: Model): Model => {
  const currentIndex = Math.max(
    0,
    model.threads.findIndex((thread) => thread.id === model.currentThreadId),
  )
  if (!model.threadSidebar.open)
    return {
      ...model,
      threadSidebar: {
        open: true,
        focused: false,
        selected: currentIndex,
        scrollTop: Math.max(0, currentIndex - model.height + 1),
      },
    }
  return {
    ...model,
    threadSidebar: model.threadSidebar.focused
      ? { ...model.threadSidebar, open: false, focused: false }
      : { ...model.threadSidebar, focused: true },
  }
}

const toggleThreadSwitcher = (model: Model): Model => {
  const open = !model.threadSwitcher.open
  const selected = Math.max(
    0,
    filteredThreads({ ...model, threadSwitcher: { ...model.threadSwitcher, query: "" } }).findIndex(
      (thread) => thread.id === model.currentThreadId,
    ),
  )
  const next: Model = {
    ...model,
    threadSwitcher: { open, query: "", selected, kind: "switch" },
    paletteOpen: false,
    palette: { open: false, query: "", selected: 0 },
    modePicker: { ...model.modePicker, open: false },
    filePicker: { ...model.filePicker, open: false },
    shortcutsOpen: false,
  }
  return open ? next : { ...next, threadPreview: { _tag: "Idle" } }
}

const reduceFocusedThreadSidebar = (model: Model, key: Key, reduce: (model: Model, message: Message) => Model) => {
  if (key.name === "escape") return { ...model, threadSidebar: { ...model.threadSidebar, focused: false } }
  if (key.name === "up") return reduce(model, { _tag: "ThreadSidebarSelectionMoved", offset: -1 })
  if (key.name === "down") return reduce(model, { _tag: "ThreadSidebarSelectionMoved", offset: 1 })
  if (key.name === "return") return reduce(model, { _tag: "ThreadSidebarSelectionConfirmed" })
  return model
}

const reduceNavigationPrelude = (model: Model, key: Key, reduce: (model: Model, message: Message) => Model) => {
  if (model.threadSidebar.open && model.threadSidebar.focused) return reduceFocusedThreadSidebar(model, key, reduce)
  if (!key.ctrl && !key.alt && !key.meta && ["pageup", "pagedown", "end"].includes(key.name)) return model
  if ((key.ctrl && key.name === "t") || (key.alt && key.name === "w")) return toggleThreadSwitcher(model)
  return undefined
}

const reduceKeyboardPreludeImpl = (
  model: Model,
  key: Key,
  reduce: (model: Model, message: Message) => Model,
): Model | undefined => {
  if (key.eventType === "release") return model
  const editing = reduceEditing(model, key)
  if (editing !== undefined) return editing
  if (key.ctrl && (key.name === "\\" || key.sequence === "\u001c")) return toggleThreadSidebar(model)
  return reduceNavigationPrelude(model, key, reduce)
}

export const reduceKeyboardPrelude: {
  (
    arg1: Parameters<typeof reduceKeyboardPreludeImpl>[1],
    arg2: Parameters<typeof reduceKeyboardPreludeImpl>[2],
  ): (arg0: Parameters<typeof reduceKeyboardPreludeImpl>[0]) => ReturnType<typeof reduceKeyboardPreludeImpl>
  (
    arg0: Parameters<typeof reduceKeyboardPreludeImpl>[0],
    arg1: Parameters<typeof reduceKeyboardPreludeImpl>[1],
    arg2: Parameters<typeof reduceKeyboardPreludeImpl>[2],
  ): ReturnType<typeof reduceKeyboardPreludeImpl>
} = Function.dual(3, reduceKeyboardPreludeImpl)
