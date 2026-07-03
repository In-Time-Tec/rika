import * as SelectPrimitive from "@foldkit/ui/select"
import { html, type Html } from "foldkit/html"
import { cn } from "../../lib/cn"
import type { SlotConfig } from "./types"

export interface SelectOption {
  readonly value: string
  readonly label: string
}

export interface SelectConfig<Message> extends SlotConfig<Message> {
  readonly id: string
  readonly value?: string
  readonly options: ReadonlyArray<SelectOption>
  readonly onChange?: (value: string) => Message
  readonly disabled?: boolean
  readonly invalid?: boolean
  readonly autofocus?: boolean
  readonly name?: string
}

export const select = <Message>(config: SelectConfig<Message>): Html =>
  SelectPrimitive.view<Message>({
    id: config.id,
    ...(config.value === undefined ? {} : { value: config.value }),
    ...(config.onChange === undefined ? {} : { onChange: config.onChange }),
    ...(config.disabled === undefined ? {} : { isDisabled: config.disabled }),
    ...(config.invalid === undefined ? {} : { isInvalid: config.invalid }),
    ...(config.autofocus === undefined ? {} : { isAutofocus: config.autofocus }),
    ...(config.name === undefined ? {} : { name: config.name }),
    toView: (attributes) => {
      const H = html<Message>()
      return H.select(
        [
          ...attributes.select,
          ...(config.attributes ?? []),
          H.DataAttribute("slot", "select"),
          H.Class(cn("select", config.class)),
        ],
        config.options.map((option) =>
          H.option(
            [
              H.Value(option.value),
              H.Selected(config.value === option.value),
              H.DataAttribute("slot", "select-option"),
            ],
            [option.label],
          ),
        ),
      )
    },
  })
