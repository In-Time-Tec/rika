import { html, type Attribute, type Html } from "foldkit/html"
import type { AppMessage } from "./app"

const H = html<AppMessage>()

type Attributes = ReadonlyArray<Attribute<AppMessage>>
type Child = Html | string
type Children = ReadonlyArray<Child>

export const cn = (...values: ReadonlyArray<string | false | undefined>) => values.filter(Boolean).join(" ")

export const button = (attributes: Attributes, children: Children, variant: "default" | "ghost" = "default"): Html =>
  H.button([H.Class(cn("button", variant === "ghost" && "button-ghost")), ...attributes], children)

export const card = (attributes: Attributes, children: Children): Html =>
  H.section([H.Class("card"), ...attributes], children)

export const badge = (children: Children, tone: "default" | "success" | "danger" = "default"): Html =>
  H.span([H.Class(cn("badge", tone === "success" && "badge-success", tone === "danger" && "badge-danger"))], children)

export const textarea = (attributes: Attributes): Html => H.textarea([H.Class("textarea"), ...attributes], [])

export const empty = H.empty
