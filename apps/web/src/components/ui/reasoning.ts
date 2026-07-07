import type { Html } from "foldkit/html"
import { html } from "foldkit/html"
import { cn } from "../../lib/cn"
import type { SlotConfig, UiChildren } from "./types"

const brainIcon = (): Html => {
  const H = html()
  return H.svg(
    [
      H.Attribute("xmlns", "http://www.w3.org/2000/svg"),
      H.Attribute("viewBox", "0 0 24 24"),
      H.Attribute("fill", "none"),
      H.Attribute("stroke", "currentColor"),
      H.Attribute("stroke-width", "2"),
      H.Attribute("stroke-linecap", "round"),
      H.Attribute("stroke-linejoin", "round"),
      H.AriaHidden(true),
      H.Class("size-4"),
    ],
    [
      H.path(
        [H.Attribute("d", "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z")],
        [],
      ),
      H.path(
        [H.Attribute("d", "M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z")],
        [],
      ),
      H.path([H.Attribute("d", "M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4")], []),
      H.path([H.Attribute("d", "M17.599 6.5a3 3 0 0 0 .399-1.375")], []),
      H.path([H.Attribute("d", "M6.003 5.125A3 3 0 0 0 6.401 6.5")], []),
      H.path([H.Attribute("d", "M3.477 10.896a4 4 0 0 1 .585-.396")], []),
      H.path([H.Attribute("d", "M19.938 10.5a4 4 0 0 1 .585.396")], []),
      H.path([H.Attribute("d", "M6 18a4 4 0 0 1-1.967-.516")], []),
      H.path([H.Attribute("d", "M19.967 17.484A4 4 0 0 1 18 18")], []),
    ],
  )
}

const chevronDownIcon = (isOpen: boolean): Html => {
  const H = html()
  return H.svg(
    [
      H.Attribute("xmlns", "http://www.w3.org/2000/svg"),
      H.Attribute("viewBox", "0 0 24 24"),
      H.Attribute("fill", "none"),
      H.Attribute("stroke", "currentColor"),
      H.Attribute("stroke-width", "2"),
      H.Attribute("stroke-linecap", "round"),
      H.Attribute("stroke-linejoin", "round"),
      H.AriaHidden(true),
      H.Class(cn("size-4 transition-transform", isOpen ? "rotate-180" : "rotate-0")),
    ],
    [H.path([H.Attribute("d", "m6 9 6 6 6-6")], [])],
  )
}

export type ReasoningConfig<Message> = SlotConfig<Message> &
  Readonly<{
    isOpen: boolean
  }>

export const reasoning = <Message>(config: ReasoningConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "reasoning"),
      H.DataAttribute("state", config.isOpen ? "open" : "closed"),
      H.Class(cn("not-prose mb-4", config.class)),
    ],
    [...children],
  )
}

export type ReasoningTriggerConfig<Message> = SlotConfig<Message> &
  Readonly<{
    isOpen: boolean
    onToggled: Message
    isStreaming?: boolean
    durationSeconds?: number
  }>

const thinkingMessage = (isStreaming: boolean, durationSeconds: number | undefined): Html => {
  const H = html()
  if (isStreaming || durationSeconds === 0) {
    return H.span([H.Class("shimmer")], ["Thinking..."])
  }
  if (durationSeconds === undefined) {
    return H.span([], ["Thought for a few seconds"])
  }
  return H.span([], [`Thought for ${durationSeconds} seconds`])
}

export const reasoningTrigger = <Message>(config: ReasoningTriggerConfig<Message>, children: UiChildren = []): Html => {
  const H = html<Message>()
  const defaultChildren: ReadonlyArray<Html> = [
    brainIcon(),
    thinkingMessage(config.isStreaming ?? false, config.durationSeconds),
    chevronDownIcon(config.isOpen),
  ]
  return H.button(
    [
      H.Type("button"),
      H.OnClick(config.onToggled),
      H.AriaExpanded(config.isOpen),
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "reasoning-trigger"),
      H.DataAttribute("state", config.isOpen ? "open" : "closed"),
      H.Class(
        cn(
          "flex w-full items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground",
          config.class,
        ),
      ),
    ],
    children.length > 0 ? [...children] : defaultChildren,
  )
}

export const reasoningContent = <Message>(config: SlotConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "reasoning-content"),
      H.Class(cn("mt-4 text-sm text-muted-foreground outline-none", config.class)),
    ],
    [...children],
  )
}
