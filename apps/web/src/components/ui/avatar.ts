import type { Html } from "foldkit/html"
import { html } from "foldkit/html"
import { cn } from "../../lib/cn"
import type { SlotConfig, UiChildren } from "./types"

export type AvatarConfig<Message> = SlotConfig<Message> &
  Readonly<{
    size?: "default" | "sm" | "lg"
  }>

export const avatar = <Message>(config: AvatarConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  return H.span(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "avatar"),
      H.DataAttribute("size", config.size ?? "default"),
      H.Class(
        cn(
          "group/avatar relative flex size-8 shrink-0 overflow-hidden rounded-full select-none data-[size=lg]:size-10 data-[size=sm]:size-6",
          config.class,
        ),
      ),
    ],
    [...children],
  )
}

export type AvatarImageConfig<Message> = SlotConfig<Message> &
  Readonly<{
    src: string
    alt: string
  }>

export const avatarImage = <Message>(config: AvatarImageConfig<Message>): Html => {
  const H = html<Message>()
  return H.img([
    ...(config.attributes ?? []),
    H.Src(config.src),
    H.Alt(config.alt),
    H.DataAttribute("slot", "avatar-image"),
    H.Class(cn("aspect-square size-full", config.class)),
  ])
}

export const avatarFallback = <Message>(config: SlotConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  return H.span(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "avatar-fallback"),
      H.Class(
        cn(
          "flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground group-data-[size=sm]/avatar:text-xs",
          config.class,
        ),
      ),
    ],
    [...children],
  )
}
