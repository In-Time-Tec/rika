import * as ButtonPrimitive from "@foldkit/ui/button"
import { html, type Html } from "foldkit/html"
import { cn } from "../../lib/cn"
import type { SlotConfig, UiChildren } from "./types"

export type ButtonVariant = "default" | "ghost" | "danger"

export interface ButtonConfig<Message> extends SlotConfig<Message> {
  readonly variant?: ButtonVariant
  readonly onClick?: Message
  readonly disabled?: boolean
  readonly type?: "button" | "submit" | "reset"
  readonly autofocus?: boolean
}

export const button = <Message>(config: ButtonConfig<Message>, children: UiChildren): Html =>
  ButtonPrimitive.view<Message>({
    ...(config.onClick === undefined ? {} : { onClick: config.onClick }),
    ...(config.disabled === undefined ? {} : { isDisabled: config.disabled }),
    ...(config.type === undefined ? {} : { type: config.type }),
    ...(config.autofocus === undefined ? {} : { isAutofocus: config.autofocus }),
    toView: (attributes) => {
      const H = html<Message>()
      const variant = config.variant ?? "default"
      return H.button(
        [
          ...attributes.button,
          ...(config.attributes ?? []),
          H.DataAttribute("slot", "button"),
          H.Class(
            cn("button", variant === "ghost" && "button-ghost", variant === "danger" && "button-danger", config.class),
          ),
        ],
        children,
      )
    },
  })
