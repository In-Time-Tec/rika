import { Function } from "effect"
import type { Message } from "../model/terminal-message"
import type { Model } from "../model/terminal-state"
import type { QueueItem } from "../model/terminal-queue-item"
import { isPrintable } from "../../presentation/terminal/terminal-keymap"
import { context } from "./terminal-state-reducer"
import { reduceKeyboardPrelude } from "./terminal-keyboard-prelude"
import { reduceKeyboardPicker } from "./terminal-keyboard-picker"

const reduceKeyboardImpl = (
  model: Model,
  message: Message,
  reduce: (model: Model, message: Message) => Model,
): Model | undefined => {
  const update = reduce
  const {
    insert,
    erase,
    lastCharacterLength,
    fileMention,
    questionKey,
    continueShortcutsAfterEdit,
    insertWhileShortcutsOpen,
  } = context
  switch (message._tag) {
    case "KeyPressed": {
      const key = message.key
      if (key.ctrl && key.name === "y") return update(model, { _tag: "ContextDetailsToggled" })
      if (model.contextDetailsOpen) {
        if (key.name === "escape") return update(model, { _tag: "ContextDetailsToggled" })
        return update(update(model, { _tag: "ContextDetailsToggled" }), message)
      }
      const prelude = reduceKeyboardPrelude(model, key, update)
      if (prelude !== undefined) return prelude
      const picker = reduceKeyboardPicker(model, key, update, {
        insert,
        erase,
        lastCharacterLength,
        fileMention,
        questionKey,
        insertWhileShortcutsOpen,
        continueShortcutsAfterEdit,
      })
      if (picker !== undefined) return picker

      if (questionKey(key) && model.input.length === 0) {
        const trigger = model.cursor
        const next = insert(model, "?")
        return {
          ...next,
          shortcutsOpen: true,
          shortcutsTrigger: trigger,
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          modePicker: { ...model.modePicker, open: false },
          filePicker: { ...model.filePicker, open: false },
        }
      }
      if (
        (key.sequence === "D" || (key.name === "d" && key.shift)) &&
        !key.ctrl &&
        !key.alt &&
        !key.meta &&
        model.input.length === 0
      )
        return update(model, { _tag: "AllDetailsToggled" })
      if ((key.name === "tab" || key.name === "backtab") && !key.ctrl && !key.alt && !key.meta)
        return update(model, { _tag: "DetailMoved", offset: key.name === "backtab" || key.shift ? -1 : 1 })
      if (
        key.name === "return" &&
        !key.ctrl &&
        !key.alt &&
        !key.meta &&
        !key.shift &&
        model.input.length === 0 &&
        model.detailSelection !== undefined
      )
        return update(model, { _tag: "DetailToggled" })
      const queued = model.queue as ReadonlyArray<QueueItem>
      if (model.busy && model.input.length === 0 && queued.length > 0 && model.editingTurnId === undefined) {
        const current = queued.findIndex((item) => item.id === model.queueSelection)
        if (current < 0) {
          if (key.name === "up")
            return {
              ...model,
              queueSelection: queued.at(-1)!.id,
            }
        } else {
          if (key.name === "escape") return { ...model, queueSelection: undefined }
          if (key.name === "up") {
            const index = Math.max(0, current - 1)
            return {
              ...model,
              queueSelection: queued[index]!.id,
            }
          }
          if (key.name === "down") {
            if (current === queued.length - 1) return { ...model, queueSelection: undefined }
            return {
              ...model,
              queueSelection: queued[current + 1]!.id,
            }
          }
          const selected = queued[current]!
          if (selected.provisional === true) return model
          if (key.ctrl && key.name === "e")
            return insert(
              {
                ...model,
                editingTurnId: selected.id,
                editReturn: { input: model.input, attachments: model.pastedText },
                input: "",
                cursor: 0,
                pastedText: [],
              },
              selected.prompt,
            )
          if (key.name === "return")
            return {
              ...model,
              ...(model.activeTurnId === undefined
                ? {}
                : {
                    pendingSteering: [...model.pendingSteering, { turnId: model.activeTurnId, text: selected.prompt }],
                  }),
              pendingAction: {
                _tag: "SteerQueued",
                id: selected.id,
                prompt: selected.prompt,
              },
            }
          if (key.name === "backspace") return { ...model, pendingAction: { _tag: "Dequeue", id: selected.id } }
        }
      }
      if ((key.name === "return" && key.shift) || key.name === "linefeed" || (key.ctrl && key.name === "j"))
        return insert(model, "\n")
      if (key.name === "return" && model.cursor > 0 && model.input[model.cursor - 1] === "\\") {
        const withoutSlash = {
          ...model,
          input: model.input.slice(0, model.cursor - 1) + model.input.slice(model.cursor),
          cursor: model.cursor - 1,
        }
        return insert(withoutSlash, "\n")
      }
      if (key.name === "up" || key.name === "down") {
        if (model.history.length === 0) return model
        const lineStart = model.input.lastIndexOf("\n", Math.max(0, model.cursor - 1)) + 1
        const lineEnd = model.input.indexOf("\n", model.cursor)
        if (key.name === "up" && lineStart > 0) return model
        if (key.name === "down" && lineEnd >= 0) return model
        const current = model.historyIndex ?? model.history.length
        const index = key.name === "up" ? Math.max(0, current - 1) : Math.min(model.history.length, current + 1)
        const savedDraft =
          model.historyIndex === undefined ? { input: model.input, attachments: model.pastedText } : model.historyDraft
        const draft = index === model.history.length ? savedDraft : model.historyComposers[index]
        const input = draft?.input ?? (index === model.history.length ? "" : model.history[index]!)
        return {
          ...model,
          historyIndex: index === model.history.length ? undefined : index,
          historyDraft: index === model.history.length ? undefined : savedDraft,
          input,
          pastedText: draft?.attachments ?? [],
          cursor: input.length,
        }
      }
      if (key.ctrl && key.name === "r") {
        const query = model.input || model.historySearch
        const input = model.history.toReversed().find((prompt) => prompt.includes(query)) ?? model.input
        return { ...model, input, cursor: input.length, historySearch: query }
      }
      if (((key.alt && key.name === "backspace") || (key.ctrl && key.name === "w")) && model.cursor > 0) {
        const before = model.input.slice(0, model.cursor)
        const trimmed = before.replace(/[ \t]+$/, "")
        const boundary = Math.max(trimmed.lastIndexOf(" "), trimmed.lastIndexOf("\n"), trimmed.lastIndexOf("\t"))
        const target = trimmed.length === 0 ? 0 : boundary + 1
        return { ...model, input: model.input.slice(0, target) + model.input.slice(model.cursor), cursor: target }
      }
      if (((key.meta && key.name === "backspace") || (key.ctrl && key.name === "u")) && model.cursor > 0) {
        const lineStart = model.input.lastIndexOf("\n", model.cursor - 1) + 1
        return {
          ...model,
          input: model.input.slice(0, lineStart) + model.input.slice(model.cursor),
          cursor: lineStart,
        }
      }
      if (key.name === "backspace" && model.cursor > 0) {
        return {
          ...model,
          input: model.input.slice(0, model.cursor - 1) + model.input.slice(model.cursor),
          cursor: model.cursor - 1,
        }
      }
      if (key.name === "left") return { ...model, cursor: Math.max(0, model.cursor - 1) }
      if (key.name === "right") return { ...model, cursor: Math.min(model.input.length, model.cursor + 1) }
      return isPrintable(key) ? insert(model, key.sequence) : model
    }
  }
  return undefined
}

export const reduceKeyboard: {
  (
    arg1: Parameters<typeof reduceKeyboardImpl>[1],
    arg2: Parameters<typeof reduceKeyboardImpl>[2],
  ): (arg0: Parameters<typeof reduceKeyboardImpl>[0]) => ReturnType<typeof reduceKeyboardImpl>
  (
    arg0: Parameters<typeof reduceKeyboardImpl>[0],
    arg1: Parameters<typeof reduceKeyboardImpl>[1],
    arg2: Parameters<typeof reduceKeyboardImpl>[2],
  ): ReturnType<typeof reduceKeyboardImpl>
} = Function.dual(3, reduceKeyboardImpl)
