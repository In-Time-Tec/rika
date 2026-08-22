import { inertHtml, type HtmlBuilder } from "foldkit/html"

let current: HtmlBuilder<unknown> = inertHtml as unknown as HtmlBuilder<unknown>

export const html = <Message>(): HtmlBuilder<Message> => current as unknown as HtmlBuilder<Message>

export const htmlScope = {
  with: <Message, A>(builder: HtmlBuilder<Message>, render: () => A): A => {
    const previous = current
    current = builder as unknown as HtmlBuilder<unknown>
    try {
      return render()
    } finally {
      current = previous
    }
  },
} as const
