import * as TabsPrimitive from "@foldkit/ui/tabs"
import { html, type Html } from "foldkit/html"
import { defineView } from "foldkit/submodel"
import { cn } from "../../lib/cn"
import * as TabsState from "./tabs-state"

export const Model = TabsState.Model
export const Message = TabsState.Message
export const OutMessage = TabsState.OutMessage
export const SelectedTab = TabsState.SelectedTab
export const FocusedTab = TabsState.FocusedTab
export const CompletedFocusTab = TabsState.CompletedFocusTab
export const FocusTab = TabsState.FocusTab
export const init = TabsState.init
export const update = TabsState.update
export type Model = TabsState.Model
export type Message = TabsState.Message
export type OutMessage = TabsState.OutMessage

export interface TabItem<Value extends string> {
  readonly value: Value
  readonly label: string
}

export interface ViewInputs<Value extends string> {
  readonly items: ReadonlyArray<TabItem<Value>>
  readonly ariaLabel: string
  readonly panel: (value: Value) => Html
  readonly class?: string
}

export const create = <Value extends string>() => {
  const Primitive = TabsPrimitive.create<Value>()
  return {
    ...TabsState.create(),
    view: defineView<TabsState.Model, TabsState.Message, ViewInputs<Value>>((model, inputs) =>
      Primitive.view(model, {
        tabs: inputs.items.map((item) => item.value),
        ariaLabel: inputs.ariaLabel,
        toView: (render) => tabsView(render, inputs),
      }),
    ),
  }
}

const tabsView = <Value extends string>(render: TabsPrimitive.RenderInfo<Value>, inputs: ViewInputs<Value>): Html => {
  const H = html<TabsPrimitive.Message>()
  const active = render.tabs[render.activeIndex]
  return H.section(
    [H.DataAttribute("slot", "tabs"), H.Class(cn("tabs", inputs.class))],
    [
      H.div(
        [...render.tablist, H.DataAttribute("slot", "tabs-list"), H.Class("tabs-list")],
        render.tabs.map((tab) =>
          H.button(
            [
              ...tab.tab,
              H.DataAttribute("slot", "tabs-trigger"),
              H.Class(cn("tabs-trigger", tab.isActive && "tabs-trigger-active")),
            ],
            [labelFor(inputs.items, tab.value)],
          ),
        ),
      ),
      active === undefined
        ? H.div([H.DataAttribute("slot", "tabs-content"), H.Class("tabs-content")], [])
        : H.div(
            [
              ...active.panel,
              H.DataAttribute("slot", "tabs-content"),
              H.Class(cn("tabs-content", "tabs-content-active")),
            ],
            [inputs.panel(active.value)],
          ),
    ],
  )
}

const labelFor = <Value extends string>(items: ReadonlyArray<TabItem<Value>>, value: Value): string =>
  items.find((item) => item.value === value)?.label ?? value
