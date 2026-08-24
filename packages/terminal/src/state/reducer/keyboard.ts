import { Function } from "effect"
import type { Message } from "../message"
import type { Model } from "../model"
import { isPrintable } from "../../presentation/terminal/keymap"
import { transcriptUnitId, transcriptUnits } from "../../presentation/transcript/row"
import { context } from "./model"
import { reduceKeyboardPrelude } from "./keyboard-prelude"
import { reduceKeyboardPicker } from "./keyboard-picker"
import { decodeTranscriptBlocks, decodeTranscriptItems } from "../transcript/model"

const selectedAuthorization = (
  model: Model,
): { readonly turnId: string; readonly authorizationId: string } | undefined => {
  if (model.detailSelection === undefined) return undefined
  const unit = transcriptUnits(model).find(
    (candidate) => candidate.kind === "block" && transcriptUnitId(model, candidate) === model.detailSelection,
  )
  if (unit?.kind !== "block") return undefined
  const block = decodeTranscriptBlocks(model.blocks)[unit.block]
  if (block === undefined) return undefined
  if (block._tag !== "AuthorizationCard" || block.status !== "pending") return undefined
  const item = decodeTranscriptItems(model.items).find(
    (candidate) => candidate._tag === "Block" && candidate.index === unit.block,
  )
  const turnId = item?.rootTurnId ?? item?.turnId
  return turnId === undefined ? undefined : { turnId, authorizationId: block.id }
}

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

      if (
        model.input.length === 0 &&
        !key.ctrl &&
        !key.alt &&
        !key.meta &&
        !key.shift &&
        (key.name === "a" || key.name === "d")
      ) {
        const authorization = selectedAuthorization(model)
        if (authorization !== undefined)
          return {
            ...model,
            pendingAction: {
              _tag: key.name === "a" ? "ApproveAuthorization" : "DenyAuthorization",
              ...authorization,
            },
          }
      }

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
      const steeringQueueIds = new Set(
        model.steeringRequests.flatMap((request) => (request.origin === "queue" ? [request.queuedTurnId] : [])),
      )
      const queued = model.queue.filter((item) => !steeringQueueIds.has(item.id))
      if (model.input.length === 0 && queued.length > 0 && model.editingTurnId === undefined) {
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
          if (key.name === "return" && model.activeTurnId !== undefined && message.steeringRequestId !== undefined)
            return {
              ...model,
              queueSelection: undefined,
              steeringRequests: [
                ...model.steeringRequests,
                {
                  requestId: message.steeringRequestId,
                  turnId: model.activeTurnId,
                  text: selected.prompt,
                  origin: "queue",
                  queuedTurnId: selected.id,
                },
              ],
              pendingAction: {
                _tag: "SteerQueued",
                id: selected.id,
                prompt: selected.prompt,
                requestId: message.steeringRequestId,
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
