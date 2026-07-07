import * as DialogPrimitive from "@foldkit/ui/dialog"
import type { VariantProps } from "class-variance-authority"
import type { Html } from "foldkit/html"
import { html } from "foldkit/html"
import { buttonVariants } from "./button"
import { cn } from "../../lib/cn"
import type { SlotConfig, UiChildren } from "./types"

export const Model = DialogPrimitive.Model
export type Model = DialogPrimitive.Model
export type InitConfig = DialogPrimitive.InitConfig
export const init = DialogPrimitive.init

export const Message = DialogPrimitive.Message
export type Message = DialogPrimitive.Message
export const OutMessage = DialogPrimitive.OutMessage
export type OutMessage = DialogPrimitive.OutMessage

export const update = DialogPrimitive.update
export const open = DialogPrimitive.open
export const close = DialogPrimitive.close
export const CompletedShowDialog = DialogPrimitive.CompletedShowDialog
export const CompletedCloseDialog = DialogPrimitive.CompletedCloseDialog
export const ShowDialog = DialogPrimitive.ShowDialog
export const CloseDialog = DialogPrimitive.CloseDialog

export const view = DialogPrimitive.view
export const titleId = DialogPrimitive.titleId
export const descriptionId = DialogPrimitive.descriptionId

const alertDialogClass = "items-center justify-center bg-transparent p-0 open:flex"

const overlayClass = "fixed inset-0 z-50 bg-black/50"

const contentClass =
  "group/alert-dialog-content relative z-50 grid w-full max-w-[calc(100%-2rem)] gap-4 rounded-lg border bg-background p-6 shadow-lg transition duration-200 ease-out data-[closed]:scale-95 data-[closed]:opacity-0 data-[size=sm]:max-w-xs data-[size=default]:sm:max-w-lg"

export type Size = "default" | "sm"

export type ContentSlots = Readonly<{
  close: DialogPrimitive.RenderInfo["closeButton"]
}>

export type ContentConfig = Readonly<{
  class?: string
  size?: Size
}>

export const content = (
  config: ContentConfig,
  toChildren: (slots: ContentSlots) => ReadonlyArray<Html>,
): DialogPrimitive.ViewInputs => ({
  toView: ({ closeButton, dialog, isVisible, panel }) => {
    const H = html<DialogPrimitive.Message>()
    const size = config.size ?? "default"

    return H.dialog(
      [...dialog, H.Role("alertdialog"), H.Class(alertDialogClass)],
      isVisible
        ? [
            H.div([H.DataAttribute("slot", "alert-dialog-overlay"), H.Class(overlayClass)], []),
            H.div(
              [
                ...panel,
                H.DataAttribute("slot", "alert-dialog-content"),
                H.DataAttribute("size", size),
                H.Class(cn(contentClass, config.class)),
              ],
              [...toChildren({ close: closeButton })],
            ),
          ]
        : [],
    )
  },
})

export const header = <Message>(config: SlotConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "alert-dialog-header"),
      H.Class(
        cn(
          "grid grid-rows-[auto_1fr] place-items-center gap-1.5 text-center has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-6 sm:group-data-[size=default]/alert-dialog-content:place-items-start sm:group-data-[size=default]/alert-dialog-content:text-left sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]",
          config.class,
        ),
      ),
    ],
    [...children],
  )
}

export const footer = <Message>(config: SlotConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "alert-dialog-footer"),
      H.Class(
        cn(
          "flex flex-col-reverse gap-2 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 sm:flex-row sm:justify-end",
          config.class,
        ),
      ),
    ],
    [...children],
  )
}

export const title = <Message>(
  config: SlotConfig<Message> & Readonly<{ model: Model }>,
  children: UiChildren,
): Html => {
  const H = html<Message>()
  return H.h2(
    [
      ...(config.attributes ?? []),
      H.Id(titleId(config.model)),
      H.DataAttribute("slot", "alert-dialog-title"),
      H.Class(
        cn(
          "text-lg font-semibold sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2",
          config.class,
        ),
      ),
    ],
    [...children],
  )
}

export const description = <Message>(
  config: SlotConfig<Message> & Readonly<{ model: Model }>,
  children: UiChildren,
): Html => {
  const H = html<Message>()
  return H.p(
    [
      ...(config.attributes ?? []),
      H.Id(descriptionId(config.model)),
      H.DataAttribute("slot", "alert-dialog-description"),
      H.Class(cn("text-sm text-muted-foreground", config.class)),
    ],
    [...children],
  )
}

export const media = <Message>(config: SlotConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  return H.div(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "alert-dialog-media"),
      H.Class(
        cn(
          "mb-2 inline-flex size-16 items-center justify-center rounded-md bg-muted sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-8",
          config.class,
        ),
      ),
    ],
    [...children],
  )
}

export type ActionConfig<Message> = SlotConfig<Message> &
  Readonly<{
    variant?: VariantProps<typeof buttonVariants>["variant"]
    size?: VariantProps<typeof buttonVariants>["size"]
  }>

export const action = <Message>(config: ActionConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  return H.button(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "alert-dialog-action"),
      H.Class(cn(buttonVariants({ variant: config.variant, size: config.size }), config.class)),
    ],
    [...children],
  )
}

export const cancel = <Message>(config: ActionConfig<Message>, children: UiChildren): Html => {
  const H = html<Message>()
  return H.button(
    [
      ...(config.attributes ?? []),
      H.DataAttribute("slot", "alert-dialog-cancel"),
      H.Class(cn(buttonVariants({ variant: config.variant ?? "outline", size: config.size }), config.class)),
    ],
    [...children],
  )
}
