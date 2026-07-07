import type { Html } from "foldkit/html"
import { html } from "foldkit/html"
import { cn } from "../../lib/cn"
import type { SlotConfig } from "./types"

export type SpinnerConfig<Message> = SlotConfig<Message> &
  Readonly<{
    dataSlot?: string
  }>

export const spinner = <Message>(config: SpinnerConfig<Message>): Html => {
  const H = html<Message>()
  return H.svg(
    [
      H.Attribute("xmlns", "http://www.w3.org/2000/svg"),
      H.Attribute("viewBox", "0 0 24 24"),
      H.Attribute("fill", "none"),
      H.Attribute("stroke", "currentColor"),
      H.Attribute("stroke-width", "2"),
      H.Attribute("stroke-linecap", "round"),
      H.Attribute("stroke-linejoin", "round"),
      ...(config.attributes ?? []),
      H.DataAttribute("slot", config.dataSlot ?? "spinner"),
      H.Attribute("role", "status"),
      H.AriaLabel("Loading"),
      H.Class(cn("size-4 animate-spin", config.class)),
    ],
    [H.path([H.Attribute("d", "M21 12a9 9 0 1 1-6.219-8.56")], [])],
  )
}
