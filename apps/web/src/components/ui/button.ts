import * as ButtonPrimitive from "@foldkit/ui/button"
import { type VariantProps, cva } from "class-variance-authority"
import type { Attribute, ChildAttribute, Html } from "foldkit/html"
import { html } from "foldkit/html"
import { cn } from "../../lib/cn"
import type { UiChildren } from "./types"

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
)

export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"] | "danger"

export interface ButtonConfig<Message> {
  readonly variant?: ButtonVariant
  readonly size?: VariantProps<typeof buttonVariants>["size"]
  readonly class?: string
  readonly onClick?: Message
  readonly isDisabled?: boolean
  readonly disabled?: boolean
  readonly isAutofocus?: boolean
  readonly type?: "button" | "submit" | "reset"
  readonly autofocus?: boolean
  readonly dataSlot?: string
  readonly attributes?: ReadonlyArray<Attribute<Message> | ChildAttribute>
}

const variantName = (variant: ButtonVariant | undefined): VariantProps<typeof buttonVariants>["variant"] =>
  variant === "danger" ? "destructive" : variant

export const button = <Message>(config: ButtonConfig<Message>, children: UiChildren): Html =>
  ButtonPrimitive.view<Message>({
    ...(config.onClick === undefined ? {} : { onClick: config.onClick }),
    isDisabled: config.isDisabled ?? config.disabled ?? false,
    ...(config.type === undefined ? {} : { type: config.type }),
    isAutofocus: config.isAutofocus ?? config.autofocus ?? false,
    toView: (attributes) => {
      const H = html<Message>()
      return H.button(
        [
          ...attributes.button,
          ...(config.attributes ?? []),
          H.DataAttribute("slot", config.dataSlot ?? "button"),
          H.Class(cn(buttonVariants({ variant: variantName(config.variant), size: config.size }), config.class)),
        ],
        children,
      )
    },
  })
