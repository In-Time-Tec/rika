import { type VariantProps, cva } from "class-variance-authority"
import { html, type Html } from "foldkit/html"
import { cn } from "../../lib/cn"
import type { SlotConfig, UiChildren } from "./types"

export type BadgeTone = "default" | "success" | "warning" | "danger"

export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90",
        outline: "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: { variant: "default" },
  },
)

export interface BadgeConfig<Message> extends SlotConfig<Message> {
  readonly tone?: BadgeTone
  readonly variant?: VariantProps<typeof badgeVariants>["variant"]
  readonly dataSlot?: string
}

const toneClass = (tone: BadgeTone | undefined): string | undefined => {
  if (tone === "success") return "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300"
  if (tone === "warning") return "border-yellow-500/40 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300"
  if (tone === "danger") return "border-destructive/40 bg-destructive/10 text-destructive"
  return undefined
}

export const badge = <Message>(config: BadgeConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  return H.span(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", config.dataSlot ?? "badge"),
      H.Class(cn(badgeVariants({ variant: config.variant }), toneClass(config.tone), config.class)),
    ],
    children,
  )
}
