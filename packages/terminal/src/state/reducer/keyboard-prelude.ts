import { Function } from "effect"
import type { Message } from "../message"
import type { Model } from "../model"
import type { ThreadItem } from "../thread/model"
import type { Key } from "../../presentation/terminal/keymap"
import { filteredThreads } from "../thread/navigation"
import { expandPastedText } from "../composer/paste"

const reduceKeyboardPreludeImpl = (
  model: Model,
  key: Key,
  reduce: (model: Model, message: Message) => Model,
): Model | undefined => {
  if (key.eventType === "release") return model
  if (model.editingTurnId !== undefined) {
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
    if (key.name === "return" && !key.shift && !(model.cursor > 0 && model.input[model.cursor - 1] === "\\"))
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
  if (key.ctrl && (key.name === "\\" || key.sequence === "\u001c")) {
    const currentIndex = Math.max(
      0,
      (model.threads as ReadonlyArray<ThreadItem>).findIndex((thread) => thread.id === model.currentThreadId),
    )
    if (model.threadSidebar.open) {
      if (model.threadSidebar.focused) {
        return { ...model, threadSidebar: { ...model.threadSidebar, open: false, focused: false } }
      }
      return { ...model, threadSidebar: { ...model.threadSidebar, focused: true } }
    }
    return {
      ...model,
      threadSidebar: {
        open: true,
        focused: false,
        selected: currentIndex,
        scrollTop: Math.max(0, currentIndex - model.height + 1),
      },
    }
  }
  if (model.threadSidebar.open && model.threadSidebar.focused) {
    if (key.name === "escape") return { ...model, threadSidebar: { ...model.threadSidebar, focused: false } }
    if (key.name === "up") return reduce(model, { _tag: "ThreadSidebarSelectionMoved", offset: -1 })
    if (key.name === "down") return reduce(model, { _tag: "ThreadSidebarSelectionMoved", offset: 1 })
    if (key.name === "return") return reduce(model, { _tag: "ThreadSidebarSelectionConfirmed" })
    return model
  }
  if (!key.ctrl && !key.alt && !key.meta && ["pageup", "pagedown", "end"].includes(key.name)) return model
  if ((key.ctrl && key.name === "t") || (key.alt && key.name === "w")) {
    const open = !model.threadSwitcher.open
    const selected = Math.max(
      0,
      filteredThreads({ ...model, threadSwitcher: { ...model.threadSwitcher, query: "" } }).findIndex(
        (thread) => thread.id === model.currentThreadId,
      ),
    )
    return {
      ...model,
      threadSwitcher: { open, query: "", selected, kind: "switch" },
      paletteOpen: false,
      palette: { open: false, query: "", selected: 0 },
      modePicker: { ...model.modePicker, open: false },
      filePicker: { ...model.filePicker, open: false },
      shortcutsOpen: false,
      ...(open ? {} : { threadPreview: { _tag: "Idle" as const } }),
    }
  }
  return undefined
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
