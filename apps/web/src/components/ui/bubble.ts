import { type VariantProps, cva } from "class-variance-authority"
import type { Html } from "foldkit/html"
import { html } from "foldkit/html"
import { cn } from "../../lib/cn"
import type { SlotConfig, UiChildren } from "./types"

export type BubbleAlign = "start" | "end"

export const bubbleGroup = <Message>(config: SlotConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "bubble-group"),
      H.Class(cn("flex min-w-0 flex-col gap-2", config.class)),
    ],
    [...children],
  )
}

export const bubbleVariants = cva(
  "group/bubble relative flex w-fit max-w-[80%] min-w-0 flex-col gap-1 group-data-[align=end]/message:self-end data-[align=end]:self-end data-[variant=ghost]:max-w-full",
  {
    variants: {
      variant: {
        default:
          "*:data-[slot=bubble-content]:bg-primary *:data-[slot=bubble-content]:text-primary-foreground [&>[data-slot=bubble-content]:is(button,a):hover]:bg-primary/80",
        secondary:
          "*:data-[slot=bubble-content]:bg-secondary *:data-[slot=bubble-content]:text-secondary-foreground [&>[data-slot=bubble-content]:is(button,a):hover]:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
        muted:
          "*:data-[slot=bubble-content]:bg-muted [&>[data-slot=bubble-content]:is(button,a):hover]:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_5%)]",
        tinted:
          "*:data-[slot=bubble-content]:bg-[oklch(from_var(--primary)_0.93_calc(c*0.4)_h)] *:data-[slot=bubble-content]:text-foreground dark:*:data-[slot=bubble-content]:bg-[oklch(from_var(--primary)_0.3_calc(c*0.4)_h)] [&>[data-slot=bubble-content]:is(button,a):hover]:bg-[oklch(from_var(--primary)_0.88_calc(c*0.5)_h)] dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-[oklch(from_var(--primary)_0.35_calc(c*0.5)_h)]",
        outline:
          "*:data-[slot=bubble-content]:border-border *:data-[slot=bubble-content]:bg-background [&>[data-slot=bubble-content]:is(button,a):hover]:bg-muted [&>[data-slot=bubble-content]:is(button,a):hover]:text-foreground dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-input/30",
        ghost:
          "border-none *:data-[slot=bubble-content]:rounded-none *:data-[slot=bubble-content]:bg-transparent *:data-[slot=bubble-content]:p-0 [&>[data-slot=bubble-content]:is(button,a):hover]:bg-muted [&>[data-slot=bubble-content]:is(button,a):hover]:text-foreground dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-muted/50",
        destructive:
          "*:data-[slot=bubble-content]:bg-destructive/10 *:data-[slot=bubble-content]:text-destructive dark:*:data-[slot=bubble-content]:bg-destructive/20 [&>[data-slot=bubble-content]:is(button,a):hover]:bg-destructive/20 dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-destructive/30",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

export type BubbleConfig<Message> = SlotConfig<Message> &
  Readonly<{
    variant?: VariantProps<typeof bubbleVariants>["variant"]
    align?: BubbleAlign
  }>

export const bubble = <Message>(config: BubbleConfig<Message>, children: ReadonlyArray<Html>): Html => {
  const H = html<Message>()
  const variant = config.variant ?? "default"
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "bubble"),
      H.DataAttribute("variant", variant),
      H.DataAttribute("align", config.align ?? "start"),
      H.Class(cn(bubbleVariants({ variant }), config.class)),
    ],
    [...children],
  )
}

const bubbleContentClass =
  "w-fit max-w-full min-w-0 overflow-hidden rounded-xl border border-transparent px-3 py-2 text-sm leading-relaxed wrap-break-word group-data-[align=end]/bubble:self-end [button]:text-left [button,a]:transition-colors [button,a]:outline-none [button,a]:focus-visible:border-ring [button,a]:focus-visible:ring-3 [button,a]:focus-visible:ring-ring/50"

export type BubbleContentConfig<Message> = SlotConfig<Message> &
  Readonly<{
    onClick?: Message
    href?: string
  }>

export const bubbleContent = <Message>(config: BubbleContentConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()

  if (config.href !== undefined) {
    return H.a(
      [
        H.Href(config.href),
        ...(config.onClick === undefined ? [] : [H.OnClick(config.onClick)]),
        ...(config.attributes ?? []),
        H.DataAttribute("slot", "bubble-content"),
        H.Class(cn(bubbleContentClass, config.class)),
      ],
      [...children],
    )
  }

  if (config.onClick !== undefined) {
    return H.button(
      [
        H.Type("button"),
        H.OnClick(config.onClick),
        ...(config.attributes ?? []),
        H.DataAttribute("slot", "bubble-content"),
        H.Class(cn(bubbleContentClass, config.class)),
      ],
      [...children],
    )
  }

  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "bubble-content"),
      H.Class(cn(bubbleContentClass, config.class)),
    ],
    [...children],
  )
}

export const bubbleReactionsVariants = cva(
  "absolute z-10 flex w-fit shrink-0 items-center justify-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-sm ring-3 ring-card has-[button]:p-0",
  {
    variants: {
      side: {
        top: "top-0 -translate-y-3/4",
        bottom: "bottom-0 translate-y-3/4",
      },
      align: {
        start: "left-3",
        end: "right-3",
      },
    },
    defaultVariants: {
      side: "bottom",
      align: "end",
    },
  },
)

export type BubbleReactionsConfig<Message> = SlotConfig<Message> &
  Readonly<{
    side?: VariantProps<typeof bubbleReactionsVariants>["side"]
    align?: VariantProps<typeof bubbleReactionsVariants>["align"]
  }>

export const bubbleReactions = <Message>(config: BubbleReactionsConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  const side = config.side ?? "bottom"
  const align = config.align ?? "end"
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "bubble-reactions"),
      H.DataAttribute("align", align),
      H.DataAttribute("side", side),
      H.Class(cn(bubbleReactionsVariants({ side, align }), config.class)),
    ],
    [...children],
  )
}
