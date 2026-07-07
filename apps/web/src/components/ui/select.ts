import * as ListboxPrimitive from "@foldkit/ui/listbox"
import * as SelectPrimitive from "@foldkit/ui/select"
import { childAttributes, html, type Html } from "foldkit/html"
import { cn } from "../../lib/cn"
import type { SlotConfig } from "./types"

export const Model = ListboxPrimitive.Model
export type Model = ListboxPrimitive.Model
export type InitConfig = ListboxPrimitive.InitConfig
export type AnchorConfig = ListboxPrimitive.AnchorConfig
export const Orientation = ListboxPrimitive.Orientation
export type Orientation = ListboxPrimitive.Orientation
export const init = ListboxPrimitive.init

export const Message = ListboxPrimitive.Message
export type Message = ListboxPrimitive.Message
export const OutMessage = ListboxPrimitive.OutMessage
export type OutMessage<Value extends string = string> = ListboxPrimitive.OutMessage<Value>
export const Selected = ListboxPrimitive.Selected
export type Selected<Value extends string = string> = ListboxPrimitive.Selected<Value>
export const create: typeof ListboxPrimitive.create = ListboxPrimitive.create
export const buttonId = ListboxPrimitive.buttonId

export type GroupHeading = ListboxPrimitive.GroupHeading

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

const DEFAULT_ANCHOR: ListboxPrimitive.AnchorConfig = { placement: "bottom-start", gap: 4, padding: 8 }

const wrapperClass = "relative inline-block"

const backdropClass = "fixed inset-0 z-0"

const triggerClass =
  "flex w-fit items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[disabled]:pointer-events-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[invalid]:border-destructive data-[invalid]:ring-destructive/20 dark:bg-input/30 dark:hover:bg-input/50 dark:data-[invalid]:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground"

const triggerSizeDefaultClass = "h-9"

const triggerSizeSmallClass = "h-8"

const contentClass =
  "relative z-50 max-h-96 min-w-(--button-width) overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md transition duration-200 ease-out data-[closed]:scale-95 data-[closed]:opacity-0"

const itemClass =
  "group/item relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[active]:bg-accent data-[active]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground"

const indicatorClass =
  "pointer-events-none absolute right-2 flex size-3.5 items-center justify-center opacity-0 group-data-[selected]/item:opacity-100"

const labelClass = "px-2 py-1.5 text-xs text-muted-foreground"

const separatorClass = "pointer-events-none -mx-1 my-1 h-px bg-border"

const chevronDownIcon = (): Html => {
  const H = html<ListboxPrimitive.Message>()
  return H.svg(
    [
      H.Attribute("xmlns", "http://www.w3.org/2000/svg"),
      H.Attribute("viewBox", "0 0 24 24"),
      H.Attribute("fill", "none"),
      H.Attribute("stroke", "currentColor"),
      H.Attribute("stroke-width", "2"),
      H.Attribute("stroke-linecap", "round"),
      H.Attribute("stroke-linejoin", "round"),
      H.AriaHidden(true),
      H.Class("size-4 opacity-50"),
    ],
    [H.path([H.Attribute("d", "m6 9 6 6 6-6")], [])],
  )
}

const checkIcon = (): Html => {
  const H = html<ListboxPrimitive.Message>()
  return H.svg(
    [
      H.Attribute("xmlns", "http://www.w3.org/2000/svg"),
      H.Attribute("viewBox", "0 0 24 24"),
      H.Attribute("fill", "none"),
      H.Attribute("stroke", "currentColor"),
      H.Attribute("stroke-width", "2"),
      H.Attribute("stroke-linecap", "round"),
      H.Attribute("stroke-linejoin", "round"),
      H.AriaHidden(true),
      H.Class("size-4"),
    ],
    [H.path([H.Attribute("d", "M20 6 9 17l-5-5")], [])],
  )
}

export type TriggerSize = "default" | "sm"

export type RootConfig<Item extends string = string> = Readonly<{
  items: ReadonlyArray<Item>
  itemToConfig: (
    item: Item,
    context: Readonly<{ isActive: boolean; isDisabled: boolean; isSelected: boolean }>,
  ) => ListboxPrimitive.ItemConfig
  trigger: Html
  class?: string
  triggerClass?: string
  size?: TriggerSize
  isDisabled?: boolean
  isInvalid?: boolean
  isItemDisabled?: (item: Item, index: number) => boolean
  itemToSearchText?: (item: Item, index: number) => string
  itemGroupKey?: (item: Item, index: number) => string
  groupToHeading?: (groupKey: string) => ListboxPrimitive.GroupHeading | undefined
  ariaLabel?: string
  ariaLabelledBy?: string
  name?: string
  form?: string
  anchor?: ListboxPrimitive.AnchorConfig
}>

export const root = <Item extends string = string>(
  config: RootConfig<Item>,
): ListboxPrimitive.ViewInputs<Item, Item> => {
  const H = html<ListboxPrimitive.Message>()
  const sizeClass = config.size === "sm" ? triggerSizeSmallClass : triggerSizeDefaultClass
  return {
    items: config.items,
    itemToConfig: config.itemToConfig,
    itemToValue: (item) => item,
    ...(config.isItemDisabled !== undefined ? { isItemDisabled: config.isItemDisabled } : {}),
    ...(config.itemToSearchText !== undefined ? { itemToSearchText: config.itemToSearchText } : {}),
    ...(config.itemGroupKey !== undefined ? { itemGroupKey: config.itemGroupKey } : {}),
    ...(config.groupToHeading !== undefined ? { groupToHeading: config.groupToHeading } : {}),
    ...(config.isDisabled !== undefined ? { isDisabled: config.isDisabled } : {}),
    ...(config.isInvalid !== undefined ? { isInvalid: config.isInvalid } : {}),
    ...(config.ariaLabel !== undefined ? { ariaLabel: config.ariaLabel } : {}),
    ...(config.ariaLabelledBy !== undefined ? { ariaLabelledBy: config.ariaLabelledBy } : {}),
    ...(config.name !== undefined ? { name: config.name } : {}),
    ...(config.form !== undefined ? { form: config.form } : {}),
    buttonContent: H.div(
      [H.Class("flex w-full items-center justify-between gap-2")],
      [
        H.span(
          [H.DataAttribute("slot", "select-value"), H.Class("flex items-center gap-2 line-clamp-1")],
          [config.trigger],
        ),
        chevronDownIcon(),
      ],
    ),
    buttonClassName: cn(triggerClass, sizeClass, config.triggerClass),
    buttonAttributes: childAttributes([H.DataAttribute("slot", "select-trigger")]),
    itemsClassName: cn(contentClass, config.class),
    itemsAttributes: childAttributes([H.DataAttribute("slot", "select-content")]),
    backdropClassName: backdropClass,
    separatorClassName: separatorClass,
    className: wrapperClass,
    attributes: childAttributes([H.DataAttribute("slot", "select")]),
    anchor: config.anchor ?? DEFAULT_ANCHOR,
  }
}

export type ItemConfig = Readonly<{
  class?: string
}>

export const item = (config: ItemConfig, children: ReadonlyArray<Html | string>): ListboxPrimitive.ItemConfig => {
  const H = html<ListboxPrimitive.Message>()
  return {
    className: cn(itemClass, config.class),
    content: H.div(
      [H.DataAttribute("slot", "select-item"), H.Class("flex w-full items-center gap-2")],
      [...children, H.span([H.DataAttribute("slot", "select-item-indicator"), H.Class(indicatorClass)], [checkIcon()])],
    ),
  }
}

export type LabelConfig = Readonly<{
  class?: string
}>

export const label = (config: LabelConfig, children: ReadonlyArray<Html | string>): ListboxPrimitive.GroupHeading => {
  const H = html<ListboxPrimitive.Message>()
  return {
    className: cn(labelClass, config.class),
    content: H.span([H.DataAttribute("slot", "select-label")], [...children]),
  }
}
