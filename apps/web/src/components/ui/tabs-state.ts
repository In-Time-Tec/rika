import { Effect, Option, Schema as S } from "effect"
import * as Command from "foldkit/command"
import * as Dom from "foldkit/dom"
import { m } from "foldkit/message"

export const ActivationMode = S.Literals(["Automatic", "Manual"])
export type ActivationMode = typeof ActivationMode.Type

export const Model = S.Struct({
  id: S.String,
  activeIndex: S.Number,
  focusedIndex: S.Number,
  activationMode: ActivationMode,
})
export type Model = typeof Model.Type

export const SelectedTab = m("SelectedTab", {
  index: S.Number,
  value: S.String,
})
export const FocusedTab = m("FocusedTab", { index: S.Number })
export const CompletedFocusTab = m("CompletedFocusTab")

export const Message = S.Union([SelectedTab, FocusedTab, CompletedFocusTab])
export type Message = typeof Message.Type

export const Selected = m("Selected", {
  value: S.String,
  index: S.Number,
})
export type Selected = typeof Selected.Type

export const OutMessage = S.Union([Selected])
export type OutMessage = typeof OutMessage.Type

export interface TabItem<Value extends string> {
  readonly value: Value
  readonly label: string
}

export interface InitConfig {
  readonly id: string
  readonly activeIndex?: number
  readonly activationMode?: ActivationMode
}

export const init = (config: InitConfig): Model => {
  const activeIndex = config.activeIndex ?? 0
  return {
    id: config.id,
    activeIndex,
    focusedIndex: activeIndex,
    activationMode: config.activationMode ?? "Automatic",
  }
}

export const FocusTab = Command.define(
  "FocusTab",
  { id: S.String, index: S.Number },
  CompletedFocusTab,
)(({ id, index }) => Dom.focus(`#${id}-tab-${index}`).pipe(Effect.ignore, Effect.as(CompletedFocusTab())))

export const update = (
  model: Model,
  message: Message,
): readonly [Model, ReadonlyArray<Command.Command<Message>>, Option.Option<OutMessage>] => {
  if (message._tag === "SelectedTab") {
    return [
      { ...model, activeIndex: message.index, focusedIndex: message.index },
      [FocusTab({ id: model.id, index: message.index })],
      Option.some(Selected({ value: message.value, index: message.index })),
    ]
  }
  if (message._tag === "FocusedTab") {
    return [
      { ...model, focusedIndex: message.index },
      [FocusTab({ id: model.id, index: message.index })],
      Option.none(),
    ]
  }
  return [model, [], Option.none()]
}

export const create = () => ({ init, update })
