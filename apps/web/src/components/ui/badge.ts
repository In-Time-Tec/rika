import { html, type Html } from "foldkit/html"
import { cn } from "../../lib/cn"
import type { SlotConfig, UiChildren } from "./types"

export type BadgeTone = "default" | "success" | "warning" | "danger"

export interface BadgeConfig<Message> extends SlotConfig<Message> {
  readonly tone?: BadgeTone
}

export const badge = <Message>(config: BadgeConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  const tone = config.tone ?? "default"
  return H.span(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "badge"),
      H.Class(
        cn(
          "badge",
          tone === "success" && "badge-success",
          tone === "warning" && "badge-warning",
          tone === "danger" && "badge-danger",
          config.class,
        ),
      ),
    ],
    children,
  )
}
