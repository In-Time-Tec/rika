import type { Attribute, ChildAttribute, Html } from "foldkit/html"

export type UiAttribute<Message> = Attribute<Message> | ChildAttribute
export type UiAttributes<Message> = ReadonlyArray<UiAttribute<Message>>
export type UiChild = Html | string
export type UiChildren = ReadonlyArray<UiChild>

export interface SlotConfig<Message> {
  readonly attributes?: UiAttributes<Message>
  readonly class?: string
}
