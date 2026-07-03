import * as TextareaPrimitive from "@foldkit/ui/textarea"
import { html, type Html } from "foldkit/html"
import { cn } from "../../lib/cn"
import type { SlotConfig } from "./types"

export interface TextareaConfig<Message> extends SlotConfig<Message> {
  readonly id: string
  readonly value?: string
  readonly onInput?: (value: string) => Message
  readonly disabled?: boolean
  readonly invalid?: boolean
  readonly autofocus?: boolean
  readonly name?: string
  readonly rows?: number
  readonly placeholder?: string
}

export const textarea = <Message>(config: TextareaConfig<Message>): Html =>
  TextareaPrimitive.view<Message>({
    id: config.id,
    ...(config.value === undefined ? {} : { value: config.value }),
    ...(config.onInput === undefined ? {} : { onInput: config.onInput }),
    ...(config.disabled === undefined ? {} : { isDisabled: config.disabled }),
    ...(config.invalid === undefined ? {} : { isInvalid: config.invalid }),
    ...(config.autofocus === undefined ? {} : { isAutofocus: config.autofocus }),
    ...(config.name === undefined ? {} : { name: config.name }),
    ...(config.rows === undefined ? {} : { rows: config.rows }),
    ...(config.placeholder === undefined ? {} : { placeholder: config.placeholder }),
    toView: (attributes) => {
      const H = html<Message>()
      return H.textarea(
        [
          ...attributes.textarea,
          ...(config.attributes ?? []),
          H.DataAttribute("slot", "textarea"),
          H.Class(cn("textarea", config.class)),
        ],
        [],
      )
    },
  })
