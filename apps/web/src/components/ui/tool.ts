import { cva } from "class-variance-authority"
import type { Html } from "foldkit/html"
import { html } from "foldkit/html"
import { badge } from "./badge"
import { cn } from "../../lib/cn"
import type { SlotConfig, UiChildren } from "./types"

const iconAttributes = (className: string) => {
  const H = html()
  return [
    H.Attribute("xmlns", "http://www.w3.org/2000/svg"),
    H.Attribute("viewBox", "0 0 24 24"),
    H.Attribute("fill", "none"),
    H.Attribute("stroke", "currentColor"),
    H.Attribute("stroke-width", "2"),
    H.Attribute("stroke-linecap", "round"),
    H.Attribute("stroke-linejoin", "round"),
    H.AriaHidden(true),
    H.Class(className),
  ]
}

const wrenchIcon = (): Html => {
  const H = html()
  return H.svg(iconAttributes("size-4 text-muted-foreground"), [
    H.path(
      [
        H.Attribute(
          "d",
          "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
        ),
      ],
      [],
    ),
  ])
}

const chevronDownIcon = (isOpen: boolean): Html => {
  const H = html()
  return H.svg(
    iconAttributes(cn("size-4 text-muted-foreground transition-transform", isOpen ? "rotate-180" : "rotate-0")),
    [H.path([H.Attribute("d", "m6 9 6 6 6-6")], [])],
  )
}

const circleIcon = (): Html => {
  const H = html()
  return H.svg(iconAttributes("size-4"), [
    H.circle([H.Attribute("cx", "12"), H.Attribute("cy", "12"), H.Attribute("r", "10")], []),
  ])
}

const clockIcon = (): Html => {
  const H = html()
  return H.svg(iconAttributes("size-4"), [
    H.circle([H.Attribute("cx", "12"), H.Attribute("cy", "12"), H.Attribute("r", "10")], []),
    H.path([H.Attribute("d", "M12 6v6l4 2")], []),
  ])
}

const circleCheckIcon = (): Html => {
  const H = html()
  return H.svg(iconAttributes("size-4"), [
    H.circle([H.Attribute("cx", "12"), H.Attribute("cy", "12"), H.Attribute("r", "10")], []),
    H.path([H.Attribute("d", "m9 12 2 2 4-4")], []),
  ])
}

const circleXIcon = (): Html => {
  const H = html()
  return H.svg(iconAttributes("size-4"), [
    H.circle([H.Attribute("cx", "12"), H.Attribute("cy", "12"), H.Attribute("r", "10")], []),
    H.path([H.Attribute("d", "m15 9-6 6")], []),
    H.path([H.Attribute("d", "m9 9 6 6")], []),
  ])
}

export type ToolStatus = "input-streaming" | "input-available" | "output-available" | "output-error"

export const toolStatusBadgeVariants = cva("gap-1.5 rounded-full text-xs", {
  variants: {
    status: {
      "input-streaming": "",
      "input-available": "[&>svg]:animate-pulse",
      "output-available": "[&>svg]:text-green-600",
      "output-error": "[&>svg]:text-red-600",
    },
  },
})

const statusLabels: Record<ToolStatus, string> = {
  "input-streaming": "Pending",
  "input-available": "Running",
  "output-available": "Completed",
  "output-error": "Error",
}

const statusIcon = (status: ToolStatus): Html => {
  const icons: Record<ToolStatus, () => Html> = {
    "input-streaming": () => circleIcon(),
    "input-available": () => clockIcon(),
    "output-available": () => circleCheckIcon(),
    "output-error": () => circleXIcon(),
  }
  return (icons[status] ?? icons["input-streaming"])()
}

export const toolStatusBadge = (status: ToolStatus): Html =>
  badge({ variant: "secondary", class: toolStatusBadgeVariants({ status }) }, [
    statusIcon(status),
    statusLabels[status] ?? status,
  ])

export const tool = <Message>(config: SlotConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "tool"),
      H.Class(cn("not-prose mb-4 w-full rounded-md border", config.class)),
    ],
    [...children],
  )
}

export type ToolHeaderConfig<Message> = SlotConfig<Message> &
  Readonly<{
    name: string
    status: ToolStatus
    isOpen: boolean
    onToggled: Message
  }>

export const toolHeader = <Message>(config: ToolHeaderConfig<Message>): Html => {
  const H = html<Message>()
  return H.button(
    [
      H.Type("button"),
      H.OnClick(config.onToggled),
      H.AriaExpanded(config.isOpen),
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "tool-header"),
      H.DataAttribute("state", config.isOpen ? "open" : "closed"),
      H.Class(cn("flex w-full items-center justify-between gap-4 p-3", config.class)),
    ],
    [
      H.div(
        [H.Class("flex items-center gap-2")],
        [wrenchIcon(), H.span([H.Class("text-sm font-medium")], [config.name]), toolStatusBadge(config.status)],
      ),
      chevronDownIcon(config.isOpen),
    ],
  )
}

export const toolContent = <Message>(config: SlotConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "tool-content"),
      H.Class(cn("space-y-4 p-4 text-popover-foreground outline-none", config.class)),
    ],
    [...children],
  )
}

export const toolInput = <Message>(config: SlotConfig<Message>, code: string): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "tool-input"),
      H.Class(cn("space-y-2 overflow-hidden", config.class)),
    ],
    [
      H.h4([H.Class("text-xs font-medium tracking-wide text-muted-foreground uppercase")], ["Parameters"]),
      H.div(
        [H.Class("rounded-md bg-muted/50")],
        [H.pre([H.Class("overflow-x-auto p-4 text-xs")], [H.code([], [code])])],
      ),
    ],
  )
}

export type ToolOutputConfig<Message> = SlotConfig<Message> &
  Readonly<{
    isError?: boolean
  }>

export const toolOutput = <Message>(config: ToolOutputConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  const isError = config.isError ?? false
  return H.div(
    [...(config.attributes ?? []), H.DataAttribute("slot", "tool-output"), H.Class(cn("space-y-2", config.class))],
    [
      H.h4(
        [H.Class("text-xs font-medium tracking-wide text-muted-foreground uppercase")],
        [isError ? "Error" : "Result"],
      ),
      H.div(
        [
          H.Class(
            cn(
              "overflow-x-auto rounded-md text-xs [&_table]:w-full",
              isError ? "bg-destructive/10 text-destructive" : "bg-muted/50 text-foreground",
            ),
          ),
        ],
        [...children],
      ),
    ],
  )
}
