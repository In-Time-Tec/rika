import { Option } from "effect"
import type { Html } from "foldkit/html"
import { html } from "foldkit/html"
import type { ButtonConfig } from "./button"
import { button } from "./button"
import * as SelectComponent from "./select"
import { spinner } from "./spinner"
import type { TextareaConfig } from "./textarea"
import { textarea } from "./textarea"
import { cn } from "../../lib/cn"
import type { SlotConfig } from "./types"

const sendIcon = (): Html => {
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
    ],
    [H.path([H.Attribute("d", "M12 19V5")], []), H.path([H.Attribute("d", "m5 12 7-7 7 7")], [])],
  )
}

const squareIcon = (): Html => {
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
    ],
    [
      H.rect(
        [
          H.Attribute("x", "3"),
          H.Attribute("y", "3"),
          H.Attribute("width", "18"),
          H.Attribute("height", "18"),
          H.Attribute("rx", "2"),
        ],
        [],
      ),
    ],
  )
}

const xIcon = (): Html => {
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
    ],
    [H.path([H.Attribute("d", "M18 6 6 18")], []), H.path([H.Attribute("d", "m6 6 12 12")], [])],
  )
}

export type PromptInputConfig<Message> = SlotConfig<Message> &
  Readonly<{
    onSubmitted?: Message
  }>

export const promptInput = <Message>(config: PromptInputConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  return H.form(
    [
      ...(config.onSubmitted === undefined ? [] : [H.OnSubmit(config.onSubmitted)]),
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "prompt-input"),
      H.Class(cn("w-full divide-y overflow-hidden rounded-xl border bg-background shadow-xs", config.class)),
    ],
    [...children],
  )
}

export type PromptInputTextareaConfig<Message> = TextareaConfig<Message> &
  Readonly<{
    onSubmitRequested?: Message
  }>

export const promptInputTextarea = <Message>(config: PromptInputTextareaConfig<Message>): Html => {
  const H = html<Message>()
  const { onSubmitRequested, ...textareaConfig } = config
  const submitAttributes =
    onSubmitRequested === undefined
      ? []
      : [
          H.OnKeyDownPreventDefault((key, modifiers) =>
            key === "Enter" && !modifiers.shiftKey ? Option.some(onSubmitRequested) : Option.none(),
          ),
        ]
  return textarea({
    ...textareaConfig,
    placeholder: config.placeholder ?? "What would you like to know?",
    class: cn(
      "field-sizing-content max-h-48 min-h-16 w-full resize-none rounded-none border-none bg-transparent p-3 shadow-none outline-none ring-0 focus-visible:ring-0 dark:bg-transparent",
      config.class,
    ),
    dataSlot: "prompt-input-textarea",
    attributes: [...submitAttributes, ...(config.attributes ?? [])],
  })
}

export const promptInputToolbar = <Message>(config: SlotConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "prompt-input-toolbar"),
      H.Class(cn("flex items-center justify-between p-1", config.class)),
    ],
    [...children],
  )
}

export const promptInputTools = <Message>(config: SlotConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "prompt-input-tools"),
      H.Class(cn("flex min-w-0 items-center gap-1", config.class)),
    ],
    [...children],
  )
}

export type PromptInputButtonConfig<Message> = ButtonConfig<Message>

export const promptInputButton = <Message>(
  config: PromptInputButtonConfig<Message>,
  children: ReadonlyArray<Html | string>,
): Html => {
  const size = config.size ?? (children.length > 1 ? "sm" : "icon")
  return button(
    {
      ...config,
      variant: config.variant ?? "ghost",
      size,
      class: cn("shrink-0 gap-1.5 rounded-lg text-muted-foreground", config.class),
      dataSlot: "prompt-input-button",
      attributes: [...(config.attributes ?? [])],
    },
    children,
  )
}

export type PromptInputStatus = "idle" | "submitted" | "streaming" | "error"

export type PromptInputSubmitConfig<Message> = ButtonConfig<Message> &
  Readonly<{
    status?: PromptInputStatus
  }>

const statusIcon = (status: PromptInputStatus): Html => {
  const icons: Record<PromptInputStatus, () => Html> = {
    idle: () => sendIcon(),
    submitted: () => spinner({}),
    streaming: () => squareIcon(),
    error: () => xIcon(),
  }
  return (icons[status] ?? icons.idle)()
}

export const promptInputSubmit = <Message>(
  config: PromptInputSubmitConfig<Message>,
  children: ReadonlyArray<Html | string> = [],
): Html => {
  const H = html<Message>()
  const { status = "idle", ...buttonConfig } = config
  return button(
    {
      ...buttonConfig,
      variant: config.variant ?? "default",
      size: config.size ?? "icon",
      type: config.type ?? "submit",
      class: cn("gap-1.5 rounded-full", config.class),
      dataSlot: "prompt-input-submit",
      attributes: [
        ...(config.attributes ?? []),
        H.DataAttribute("status", status),
        H.AriaLabel(status === "streaming" || status === "submitted" ? "Stop" : "Submit"),
      ],
    },
    children.length > 0 ? children : [statusIcon(status)],
  )
}

export type PromptInputModelSelectConfig<Item extends string = string> = SelectComponent.RootConfig<Item>

export const promptInputModelSelect = <Item extends string = string>(
  config: PromptInputModelSelectConfig<Item>,
): ReturnType<typeof SelectComponent.root<Item>> =>
  SelectComponent.root({
    ...config,
    triggerClass: cn(
      "border-none bg-transparent font-medium text-muted-foreground shadow-none transition-colors hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground dark:bg-transparent dark:hover:bg-accent",
      config.triggerClass,
    ),
  })

export const promptInputModelSelectItem = SelectComponent.item

export const promptInputAttachments = <Message>(config: SlotConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "prompt-input-attachments"),
      H.Class(cn("flex flex-wrap items-center gap-2 p-3", config.class)),
    ],
    [...children],
  )
}
