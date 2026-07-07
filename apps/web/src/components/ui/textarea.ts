import * as TextareaPrimitive from "@foldkit/ui/textarea"
import type { Attribute, ChildAttribute, Html } from "foldkit/html"
import { html } from "foldkit/html"
import { cn } from "../../lib/cn"

const textareaClass = cn(
  "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
  "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
)

export interface TextareaConfig<Message> {
  readonly id: string
  readonly class?: string
  readonly value?: string
  readonly onInput?: (value: string) => Message
  readonly isDisabled?: boolean
  readonly disabled?: boolean
  readonly isInvalid?: boolean
  readonly invalid?: boolean
  readonly isAutofocus?: boolean
  readonly autofocus?: boolean
  readonly name?: string
  readonly rows?: number
  readonly placeholder?: string
  readonly dataSlot?: string
  readonly attributes?: ReadonlyArray<Attribute<Message> | ChildAttribute>
}

export const textarea = <Message>(config: TextareaConfig<Message>): Html =>
  TextareaPrimitive.view<Message>({
    id: config.id,
    ...(config.value === undefined ? {} : { value: config.value }),
    ...(config.onInput === undefined ? {} : { onInput: config.onInput }),
    isDisabled: config.isDisabled ?? config.disabled ?? false,
    isInvalid: config.isInvalid ?? config.invalid ?? false,
    isAutofocus: config.isAutofocus ?? config.autofocus ?? false,
    ...(config.name === undefined ? {} : { name: config.name }),
    ...(config.rows === undefined ? {} : { rows: config.rows }),
    ...(config.placeholder === undefined ? {} : { placeholder: config.placeholder }),
    toView: (attributes) => {
      const H = html<Message>()
      return H.textarea(
        [
          ...attributes.textarea,
          ...(config.attributes ?? []),
          H.DataAttribute("slot", config.dataSlot ?? "textarea"),
          H.Class(cn(textareaClass, config.class)),
        ],
        [],
      )
    },
  })
