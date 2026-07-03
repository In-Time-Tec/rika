import { html, type Attribute, type Html } from "foldkit/html"
import type { AppMessage } from "./app"
import { cn } from "./lib/cn"
import * as Badge from "./components/ui/badge"
import * as Button from "./components/ui/button"
import * as Select from "./components/ui/select"
import * as Tabs from "./components/ui/tabs"
import * as Textarea from "./components/ui/textarea"

const H = html<AppMessage>()

type Attributes = ReadonlyArray<Attribute<AppMessage>>
type Child = Html | string
type Children = ReadonlyArray<Child>

export { cn }
export { Tabs }
export type SelectOption = Select.SelectOption

export const button = (attributes: Attributes, children: Children, variant: Button.ButtonVariant = "default"): Html =>
  Button.button<AppMessage>({ attributes, variant }, children)

export const card = (attributes: Attributes, children: Children): Html =>
  H.section(
    [...attributes.filter((attribute) => attribute._tag !== "Class"), H.Class(cn("card", className(attributes)))],
    children,
  )

export const badge = (children: Children, tone: "default" | "success" | "warning" | "danger" = "default"): Html =>
  Badge.badge<AppMessage>({ tone }, children)

export const textarea = (config: Textarea.TextareaConfig<AppMessage>): Html => Textarea.textarea<AppMessage>(config)

export const select = (config: Select.SelectConfig<AppMessage>): Html => Select.select<AppMessage>(config)

export const empty = H.empty

const className = (attributes: Attributes): string | undefined =>
  attributes.find(
    (attribute): attribute is Extract<Attribute<AppMessage>, { readonly _tag: "Class" }> => attribute._tag === "Class",
  )?.value
