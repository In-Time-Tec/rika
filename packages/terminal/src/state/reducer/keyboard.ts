import { Function } from "effect"
import type { Message } from "../message"
import type { Model } from "../model"
import { isPrintable, type Key } from "../../presentation/terminal/keymap"
import { transcriptUnitId, transcriptUnits } from "../../presentation/transcript/row"
import { composerEdit } from "../composer/edit"
import { reduceKeyboardPrelude } from "./keyboard-prelude"
import { reduceKeyboardPicker } from "./keyboard-picker"
import { expandPastedText } from "../composer/paste"

type Update = (model: Model, message: Message) => Model

const reduceContextDetails = (model: Model, message: Extract<Message, { _tag: "KeyPressed" }>, update: Update) => {
  const key = message.key
  if (key.ctrl && key.name === "y") return update(model, { _tag: "ContextDetailsToggled" })
  if (!model.contextDetailsOpen) return undefined
  if (key.name === "escape") return update(model, { _tag: "ContextDetailsToggled" })
  return update(update(model, { _tag: "ContextDetailsToggled" }), message)
}

const selectedAuthorization = (
  model: Model,
): { readonly turnId: string; readonly authorizationId: string } | undefined => {
  if (model.detailSelection === undefined) return undefined
  const unit = transcriptUnits(model).find(
    (candidate) => candidate.kind === "block" && transcriptUnitId(model, candidate) === model.detailSelection,
  )
  if (unit?.kind !== "block") return undefined
  const block = model.blocks[unit.block]
  if (block === undefined) return undefined
  if (block._tag !== "AuthorizationCard" || block.status !== "pending") return undefined
  const item = model.items.find((candidate) => candidate._tag === "Block" && candidate.index === unit.block)
  const turnId = item?.rootTurnId ?? item?.turnId
  return turnId === undefined ? undefined : { turnId, authorizationId: block.id }
}

const reduceAuthorizationKey = (model: Model, key: Key): Model | undefined => {
  if (model.input.length > 0 || key.ctrl || key.alt || key.meta || key.shift) return undefined
  if (key.name !== "a" && key.name !== "d") return undefined
  const authorization = selectedAuthorization(model)
  return authorization === undefined
    ? undefined
    : {
        ...model,
        pendingAction: { _tag: key.name === "a" ? "ApproveAuthorization" : "DenyAuthorization", ...authorization },
      }
}

const reduceDetailKey = (model: Model, key: Key, update: Update): Model | undefined => {
  const authorization = reduceAuthorizationKey(model, key)
  if (authorization !== undefined) return authorization
  const plain = !key.ctrl && !key.alt && !key.meta
  if ((key.sequence === "D" || (key.name === "d" && key.shift)) && plain && model.input.length === 0)
    return update(model, { _tag: "AllDetailsToggled" })
  return reduceDetailNavigation(model, key, update)
}

const reduceDetailNavigation = (model: Model, key: Key, update: Update): Model | undefined => {
  const plain = !key.ctrl && !key.alt && !key.meta
  if ((key.name === "tab" || key.name === "backtab") && plain)
    return update(model, { _tag: "DetailMoved", offset: key.name === "backtab" || key.shift ? -1 : 1 })
  if (key.name === "return" && plain && !key.shift && model.input.length === 0 && model.detailSelection !== undefined)
    return update(model, { _tag: "DetailToggled" })
  return undefined
}

const openShortcuts = (model: Model): Model => {
  const trigger = model.cursor
  const next = composerEdit.insert(model, "?")
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

const selectableQueue = (model: Model) => {
  const steeringQueueIds = new Set(
    model.steeringRequests.flatMap((request) => (request.origin === "queue" ? [request.queuedTurnId] : [])),
  )
  return model.queue.filter((item) => !steeringQueueIds.has(item.id))
}

const reduceSelectedQueueItem = (
  model: Model,
  message: Extract<Message, { _tag: "KeyPressed" }>,
  queued: Model["queue"],
  current: number,
): Model | undefined => {
  const key = message.key
  if (key.name === "escape") return { ...model, queueSelection: undefined }
  if (key.name === "up") return { ...model, queueSelection: queued[Math.max(0, current - 1)]!.id }
  if (key.name === "down")
    return {
      ...model,
      queueSelection: current === queued.length - 1 ? undefined : queued[current + 1]!.id,
    }
  const selected = queued[current]!
  if (selected.provisional === true) return model
  if (key.ctrl && key.name === "e") return editQueuedItem(model, selected)
  if (key.name === "return" && model.activeTurnId !== undefined && message.steeringRequestId !== undefined)
    return steerQueuedItem(model, selected, message.steeringRequestId)
  if (key.name === "backspace") return { ...model, pendingAction: { _tag: "Dequeue", id: selected.id } }
  return undefined
}

const editQueuedItem = (model: Model, selected: Model["queue"][number]): Model =>
  composerEdit.insert(
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

const steerQueuedItem = (model: Model, selected: Model["queue"][number], requestId: string): Model => ({
  ...model,
  queueSelection: undefined,
  steeringRequests: [
    ...model.steeringRequests,
    {
      requestId,
      turnId: model.activeTurnId!,
      text: selected.prompt,
      origin: "queue",
      queuedTurnId: selected.id,
    },
  ],
  pendingAction: { _tag: "SteerQueued", id: selected.id, prompt: selected.prompt, requestId },
})

const reduceQueueKey = (model: Model, message: Extract<Message, { _tag: "KeyPressed" }>): Model | undefined => {
  const queued = selectableQueue(model)
  if (model.input.length > 0 || queued.length === 0 || model.editingTurnId !== undefined) return undefined
  const current = queued.findIndex((item) => item.id === model.queueSelection)
  if (current < 0) return message.key.name === "up" ? { ...model, queueSelection: queued.at(-1)!.id } : undefined
  return reduceSelectedQueueItem(model, message, queued, current)
}

const reduceNewlineKey = (model: Model, key: Key): Model | undefined => {
  if ((key.name === "return" && key.shift) || key.name === "linefeed" || (key.ctrl && key.name === "j"))
    return composerEdit.insert(model, "\n")
  if (key.name !== "return" || model.cursor === 0 || model.input[model.cursor - 1] !== "\\") return undefined
  const withoutSlash = {
    ...model,
    input: model.input.slice(0, model.cursor - 1) + model.input.slice(model.cursor),
    cursor: model.cursor - 1,
  }
  return composerEdit.insert(withoutSlash, "\n")
}

const reduceHistoryNavigation = (model: Model, key: Key): Model | undefined => {
  if (key.name !== "up" && key.name !== "down") return undefined
  if (model.history.length === 0) return model
  const lineStart = model.input.lastIndexOf("\n", Math.max(0, model.cursor - 1)) + 1
  const lineEnd = model.input.indexOf("\n", model.cursor)
  if (key.name === "up" && lineStart > 0) return model
  if (key.name === "down" && lineEnd >= 0) return model
  const current = model.historyIndex ?? model.history.length
  const index = key.name === "up" ? Math.max(0, current - 1) : Math.min(model.history.length, current + 1)
  return restoreHistoryEntry(model, index)
}

const restoreHistoryEntry = (model: Model, index: number): Model => {
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

const reduceEraseKey = (model: Model, key: Key): Model | undefined => {
  if (((key.alt && key.name === "backspace") || (key.ctrl && key.name === "w")) && model.cursor > 0) {
    const before = model.input.slice(0, model.cursor)
    const trimmed = before.replace(/[ \t]+$/, "")
    const boundary = Math.max(trimmed.lastIndexOf(" "), trimmed.lastIndexOf("\n"), trimmed.lastIndexOf("\t"))
    const target = trimmed.length === 0 ? 0 : boundary + 1
    return { ...model, input: model.input.slice(0, target) + model.input.slice(model.cursor), cursor: target }
  }
  if (((key.meta && key.name === "backspace") || (key.ctrl && key.name === "u")) && model.cursor > 0) {
    const lineStart = model.input.lastIndexOf("\n", model.cursor - 1) + 1
    return { ...model, input: model.input.slice(0, lineStart) + model.input.slice(model.cursor), cursor: lineStart }
  }
  if (key.name !== "backspace" || model.cursor === 0) return undefined
  return {
    ...model,
    input: model.input.slice(0, model.cursor - 1) + model.input.slice(model.cursor),
    cursor: model.cursor - 1,
  }
}

const reduceComposerKey = (model: Model, key: Key): Model => {
  const newline = reduceNewlineKey(model, key)
  if (newline !== undefined) return newline
  const history = reduceHistoryNavigation(model, key)
  if (history !== undefined) return history
  if (key.ctrl && key.name === "r") {
    const query = model.input || model.historySearch
    const input = model.history.toReversed().find((prompt) => prompt.includes(query)) ?? model.input
    return { ...model, input, cursor: input.length, historySearch: query }
  }
  const erased = reduceEraseKey(model, key)
  if (erased !== undefined) return erased
  if (key.name === "left") return { ...model, cursor: Math.max(0, model.cursor - 1) }
  if (key.name === "right") return { ...model, cursor: Math.min(model.input.length, model.cursor + 1) }
  return isPrintable(key) ? composerEdit.insert(model, key.sequence) : model
}

const reduceComposerSteering = (model: Model, message: Extract<Message, { _tag: "KeyPressed" }>): Model | undefined => {
  const requestId = message.steeringRequestId
  if (
    !message.key.ctrl ||
    message.key.name !== "s" ||
    !model.busy ||
    model.activeTurnId === undefined ||
    model.input.length === 0 ||
    requestId === undefined
  )
    return undefined
  const prompt = expandPastedText(model.input, model.pastedText)
  return {
    ...model,
    input: "",
    cursor: 0,
    pastedText: [],
    steeringRequests: [
      ...model.steeringRequests,
      { requestId, turnId: model.activeTurnId, text: prompt, origin: "composer" },
    ],
    pendingAction: { _tag: "Steer", prompt, requestId, turnId: model.activeTurnId },
  }
}

const reduceKeyPressed = (model: Model, message: Extract<Message, { _tag: "KeyPressed" }>, update: Update): Model => {
  const key = message.key
  const contextDetails = reduceContextDetails(model, message, update)
  if (contextDetails !== undefined) return contextDetails
  const prelude = reduceKeyboardPrelude(model, key, update)
  if (prelude !== undefined) return prelude
  const steering = reduceComposerSteering(model, message)
  if (steering !== undefined) return steering
  const picker = reduceKeyboardPicker(model, key, update, composerEdit)
  if (picker !== undefined) return picker
  const detail = reduceDetailKey(model, key, update)
  if (detail !== undefined) return detail
  if (composerEdit.questionKey(key) && model.input.length === 0) return openShortcuts(model)
  const queue = reduceQueueKey(model, message)
  return queue ?? reduceComposerKey(model, key)
}

const reduceKeyboardImpl = (
  model: Model,
  message: Message,
  reduce: (model: Model, message: Message) => Model,
): Model | undefined => {
  switch (message._tag) {
    case "KeyPressed":
      return reduceKeyPressed(model, message, reduce)
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
