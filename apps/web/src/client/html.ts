import { inertHtml, type HtmlBuilder } from "foldkit/html"

export const html = inertHtml

export const htmlScope = {
  with: <Message, A>(builder: HtmlBuilder<Message>, render: (html: HtmlBuilder<Message>) => A): A => render(builder),
} as const
