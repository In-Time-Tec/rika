import { Function } from "effect"
import * as QueueState from "../queue/model"
import * as Palette from "../../presentation/terminal/command-palette"
import * as ThreadNavigation from "../thread/navigation"
import type { Message } from "../message"
import type { Model } from "../model"
import { reduceData } from "./data"
import { reduceExecution } from "./execution"
import { reduceOverlay } from "./overlay"
import { reduceKeyboard } from "./keyboard"
import { advanceAnimation } from "./animation"
import { contentColumnWidth } from "../layout/model"
import { reduceModeInteraction } from "./mode"
const toggleContextDetails = (model: Model): Model => {
  const open = !model.contextDetailsOpen
  return {
    ...model,
    contextDetailsOpen: open,
    threadSidebar:
      open && contentColumnWidth(model) < 24
        ? { ...model.threadSidebar, open: false, focused: false }
        : model.threadSidebar,
    paletteOpen: false,
    palette: { open: false, query: "", selected: 0 },
    modePicker: { ...model.modePicker, open: false },
    filePicker: { ...model.filePicker, open: false, query: "", selected: 0 },
    threadSwitcher: { open: false, query: "", selected: 0, kind: "switch" },
    shortcutsOpen: false,
    shortcutsTrigger: undefined,
  }
}

export const canSubmit = (model: Model): boolean =>
  !model.threadLoading &&
  (model.connection === undefined || model.connection.connectivity === "connected") &&
  !model.submittedDrafts.some((draft) => draft.turnId === undefined) &&
  model.editingTurnId === undefined &&
  !model.threadSwitcher.open &&
  !model.threadSidebar.focused &&
  !model.paletteOpen &&
  !model.palette.open &&
  !model.modePicker.open &&
  !model.filePicker.open &&
  !model.contextDetailsOpen &&
  !model.shortcutsOpen &&
  !(model.cursor > 0 && model.input[model.cursor - 1] === "\\")

const updateImpl = (model: Model, message: Message): Model =>
  (message._tag === "ContextDetailsToggled" ? toggleContextDetails(model) : reduceModeInteraction(model, message)) ??
  reduceData(model, message, update) ??
  reduceExecution(model, message, update) ??
  reduceOverlay(model, message, update) ??
  reduceKeyboard(model, message, update) ??
  model

export const update: {
  (model: Model, message: Message): Model
  (message: Message): (model: Model) => Model
} = Function.dual(
  2,
  (model: Model, message: Message): Model =>
    message._tag === "ContextUsageReplaced"
      ? advanceAnimation(model, { ...model, contextUsage: message.contextUsage }, message.contextUsage)
      : advanceAnimation(model, updateImpl(model, message), undefined),
)

export const reduce = update
export const applyQueueDelta = QueueState.applyQueueDelta
export const resetQueue = QueueState.resetQueue
export const commands = Palette.commands
export const selectedThreadMetadata = ThreadNavigation.selectedThreadMetadata
