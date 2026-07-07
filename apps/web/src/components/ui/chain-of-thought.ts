import type { Html } from "foldkit/html"
import { html } from "foldkit/html"
import { badge } from "./badge"
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

const dotIcon = (): Html => {
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
    [H.circle([H.Attribute("cx", "12.1"), H.Attribute("cy", "12.1"), H.Attribute("r", "1")], [])],
  )
}

export const chainOfThought = <Message>(config: SlotConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "chain-of-thought"),
      H.Class(cn("not-prose w-full space-y-4", config.class)),
    ],
    [...children],
  )
}

export type ChainOfThoughtHeaderConfig<Message> = SlotConfig<Message> &
  Readonly<{
    isOpen: boolean
    onToggled: Message
  }>

export const chainOfThoughtHeader = <Message>(
  config: ChainOfThoughtHeaderConfig<Message>,
  children: UiChildren = [],
): Html => {
  const H = html<Message>()
  return H.button(
    [
      H.Type("button"),
      H.OnClick(config.onToggled),
      H.AriaExpanded(config.isOpen),
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "chain-of-thought-header"),
      H.DataAttribute("state", config.isOpen ? "open" : "closed"),
      H.Class(
        cn(
          "flex w-full items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground",
          config.class,
        ),
      ),
    ],
    [
      brainIcon(),
      H.span([H.Class("flex-1 text-left")], children.length > 0 ? [...children] : ["Chain of Thought"]),
      chevronDownIcon(config.isOpen),
    ],
  )
}

export type ChainOfThoughtStepStatus = "complete" | "active" | "pending"

const stepStatusClasses: Record<ChainOfThoughtStepStatus, string> = {
  active: "text-foreground",
  complete: "text-muted-foreground",
  pending: "text-muted-foreground/50",
}

export type ChainOfThoughtStepConfig<Message> = SlotConfig<Message> &
  Readonly<{
    label: Html | string
    icon?: Html
    description?: Html | string
    status?: ChainOfThoughtStepStatus
  }>

export const chainOfThoughtStep = <Message>(
  config: ChainOfThoughtStepConfig<Message>,
  children: UiChildren = [],
): Html => {
  const H = html<Message>()
  const status = config.status ?? "complete"
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "chain-of-thought-step"),
      H.DataAttribute("status", status),
      H.Class(cn("flex gap-2 text-sm", stepStatusClasses[status], config.class)),
    ],
    [
      H.div(
        [H.Class("relative mt-0.5")],
        [config.icon ?? dotIcon(), H.div([H.Class("absolute top-7 bottom-0 left-1/2 -mx-px w-px bg-border")], [])],
      ),
      H.div(
        [H.Class("flex-1 space-y-2 overflow-hidden")],
        [
          H.div([], [config.label]),
          ...(config.description === undefined
            ? []
            : [H.div([H.Class("text-xs text-muted-foreground")], [config.description])]),
          ...children,
        ],
      ),
    ],
  )
}

export const chainOfThoughtSearchResults = <Message>(
  config: SlotConfig<Message>,
  children: ReadonlyArray<Html>,
): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "chain-of-thought-search-results"),
      H.Class(cn("flex flex-wrap items-center gap-2", config.class)),
    ],
    [...children],
  )
}

export const chainOfThoughtSearchResult = <Message>(config: SlotConfig<Message>, children: UiChildren): Html =>
  badge(
    {
      variant: "secondary",
      class: cn("gap-1 px-2 py-0.5 text-xs font-normal", config.class),
      dataSlot: "chain-of-thought-search-result",
      attributes: [...(config.attributes ?? [])],
    },
    children,
  )

export const chainOfThoughtContent = <Message>(config: SlotConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "chain-of-thought-content"),
      H.Class(cn("mt-2 space-y-3", config.class)),
    ],
    [...children],
  )
}

export type ChainOfThoughtImageConfig<Message> = SlotConfig<Message> &
  Readonly<{
    caption?: string
  }>

export const chainOfThoughtImage = <Message>(
  config: ChainOfThoughtImageConfig<Message>,
  children: ReadonlyArray<Html>,
): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "chain-of-thought-image"),
      H.Class(cn("mt-2 space-y-2", config.class)),
    ],
    [
      H.div(
        [H.Class("relative flex max-h-[22rem] items-center justify-center overflow-hidden rounded-lg bg-muted p-3")],
        [...children],
      ),
      ...(config.caption === undefined ? [] : [H.p([H.Class("text-xs text-muted-foreground")], [config.caption])]),
    ],
  )
}
