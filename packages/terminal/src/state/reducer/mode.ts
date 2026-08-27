import { Function } from "effect"
import type { Message } from "../message"
import { contentColumnWidth } from "../layout/model"
import type { Model } from "../model"

const modeIds = (model: Model) => Object.keys(model.modeRoutes)

const openModeSelector = (model: Model): Model => ({
  ...model,
  contextDetailsOpen: false,
  threadSidebar:
    contentColumnWidth(model) < 24 ? { ...model.threadSidebar, open: false, focused: false } : model.threadSidebar,
  paletteOpen: false,
  palette: { open: false, query: "", selected: 0 },
  modePicker: {
    open: true,
    selected: modeIds(model).indexOf(
      model.rememberedMode !== undefined && Object.hasOwn(model.modeRoutes, model.rememberedMode)
        ? model.rememberedMode
        : model.mode,
    ),
  },
  filePicker: { ...model.filePicker, open: false },
  threadSwitcher: { open: false, query: "", selected: 0, kind: "switch" },
  threadPreview: { _tag: "Idle" },
  shortcutsOpen: false,
  shortcutsTrigger: undefined,
})

const slidePosition = (picker: Model["modePicker"]): number => {
  const target = picker.selected
  const from = picker.fromPosition ?? picker.from ?? target
  const progress = Math.min(1, ((picker.turnTick ?? 4) + 1) / 4)
  return from + (target - from) * (1 - (1 - progress) * (1 - progress))
}

const turnModeSelector = (model: Model, offset: number): Model => {
  if (!model.modePicker.open) return model
  const modes = modeIds(model)
  if (modes.length === 0) return model
  const selected = (model.modePicker.selected + offset + modes.length) % modes.length
  return {
    ...model,
    modePicker: {
      open: true,
      selected,
      from: model.modePicker.selected,
      fromPosition: slidePosition(model.modePicker),
      turnTick: 0,
    },
  }
}

const commitModeSelector = (model: Model, selected = model.modePicker.selected): Model => {
  const next = modeIds(model)[selected]
  if (next === undefined) return model
  return {
    ...model,
    mode: next,
    rememberedMode: next,
    contextUsage: next === model.mode ? model.contextUsage : { _tag: "NotStarted" },
    modePicker: { open: false, selected },
    modeCommit: next === model.mode ? undefined : { from: model.mode, to: next, tick: 0 },
  }
}

const tickAnimations = (model: Model): Model => {
  const modePicker =
    model.modePicker.turnTick === undefined || model.modePicker.turnTick >= 3
      ? { ...model.modePicker, from: undefined, fromPosition: undefined, turnTick: undefined }
      : { ...model.modePicker, turnTick: model.modePicker.turnTick + 1 }
  const commitLength = model.modeCommit === undefined ? 0 : model.modeCommit.from.length + model.modeCommit.to.length
  let modeCommit = model.modeCommit
  if (modeCommit !== undefined)
    modeCommit = modeCommit.tick >= commitLength ? undefined : { ...modeCommit, tick: modeCommit.tick + 1 }
  const compactionShimmer =
    model.compactionShimmer === undefined || model.compactionShimmer.remaining <= 1
      ? undefined
      : { tick: model.compactionShimmer.tick + 1, remaining: model.compactionShimmer.remaining - 1 }
  return {
    ...model,
    animationTick: model.animationTick + 1,
    compactionShimmer,
    modePicker,
    modeCommit,
  }
}

const reduceModeInteractionImpl = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
    case "ModeSelectorOpened":
      return model.busy ? model : openModeSelector(model)
    case "ModeTurned":
      return turnModeSelector(model, message.offset)
    case "ModeCommitted":
      return commitModeSelector(model, message.selected)
    case "ModeHovered":
      return model.modePicker.open && modeIds(model)[message.selected] !== undefined
        ? { ...model, modePicker: { ...model.modePicker, selected: message.selected } }
        : model
    case "AnimationTicked":
      return tickAnimations(model)
    default:
      return undefined
  }
}

export const reduceModeInteraction: {
  (model: Model, message: Message): Model | undefined
  (message: Message): (model: Model) => Model | undefined
} = Function.dual(2, reduceModeInteractionImpl)
