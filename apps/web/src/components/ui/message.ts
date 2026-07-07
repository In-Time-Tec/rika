import type { Html } from "foldkit/html"
import { html } from "foldkit/html"
import { cn } from "../../lib/cn"
import type { SlotConfig, UiChildren } from "./types"

export type MessageAlign = "start" | "end"

export const messageGroup = <Message>(config: SlotConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "message-group"),
      H.Class(cn("flex min-w-0 flex-col gap-2", config.class)),
    ],
    [...children],
  )
}

export type MessageConfig<Message> = SlotConfig<Message> &
  Readonly<{
    align?: MessageAlign
  }>

export const message = <Message>(config: MessageConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "message"),
      H.DataAttribute("align", config.align ?? "start"),
      H.Class(
        cn("group/message relative flex w-full min-w-0 gap-2 text-sm data-[align=end]:flex-row-reverse", config.class),
      ),
    ],
    [...children],
  )
}

export const messageAvatar = <Message>(config: SlotConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "message-avatar"),
      H.Class(
        cn(
          "flex w-fit min-w-8 shrink-0 items-center justify-center self-end overflow-hidden rounded-full bg-muted group-has-data-[slot=message-footer]/message:-translate-y-8",
          config.class,
        ),
      ),
    ],
    [...children],
  )
}

export const messageContent = <Message>(config: SlotConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "message-content"),
      H.Class(
        cn(
          "flex w-full min-w-0 flex-col gap-2.5 wrap-break-word group-data-[align=end]/message:*:data-[slot]:self-end",
          config.class,
        ),
      ),
    ],
    [...children],
  )
}

export const messageHeader = <Message>(config: SlotConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "message-header"),
      H.Class(
        cn(
          "flex max-w-full min-w-0 items-center px-3 text-xs font-medium text-muted-foreground group-has-data-[variant=ghost]/message:px-0",
          config.class,
        ),
      ),
    ],
    [...children],
  )
}

export const messageFooter = <Message>(config: SlotConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "message-footer"),
      H.Class(
        cn(
          "flex max-w-full min-w-0 items-center px-3 text-xs font-medium text-muted-foreground group-has-data-[variant=ghost]/message:px-0 group-data-[align=end]/message:justify-end",
          config.class,
        ),
      ),
    ],
    [...children],
  )
}
