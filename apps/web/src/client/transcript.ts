import { Marked, type MarkedToken, type Token } from "marked"
import { Function, Match, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Block, Unit } from "@rika/product/execution-transcript-contract"

// Private instance with no extensions: lexer tokens are the built-in MarkedToken union.
// No HTML injection or image loading: workspace/model text is untrusted.
const parser = new Marked()
const builtIn = (token: Token): token is MarkedToken =>
  [
    "space",
    "def",
    "heading",
    "paragraph",
    "text",
    "escape",
    "strong",
    "em",
    "del",
    "codespan",
    "code",
    "br",
    "hr",
    "blockquote",
    "link",
    "image",
    "list",
    "table",
    "html",
    "checkbox",
    "list_item",
  ].includes(token.type)
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
export const safeLink = (href: string): boolean => {
  try {
    const url = new URL(href, "https://rika.invalid")
    return (
      ["http:", "https:", "mailto:"].includes(url.protocol) && Array.from(href).every((char) => char.charCodeAt(0) > 32)
    )
  } catch {
    return false
  }
}

export const markdown: {
  <M>(text: string, h: HtmlBuilder<M>): Html
  <M>(h: HtmlBuilder<M>): (text: string) => Html
} = Function.dual(2, <M>(text: string, h: HtmlBuilder<M>): Html => {
  type Node = Html | string
  const tokens = (items: ReadonlyArray<Token>): Array<Node> =>
    items.flatMap((item): Array<Node> => {
      if (!builtIn(item)) return [item.raw]
      const token = item
      const children = () => tokens("tokens" in token ? (token.tokens ?? []) : [])
      return Match.value(token).pipe(
        Match.discriminator("type")("space", "def", () => []),
        Match.discriminator("type")("heading", (value) => [
          value.depth <= 2 ? h.h2([], children()) : h.h3([], children()),
        ]),
        Match.discriminator("type")("paragraph", () => [h.p([], children())]),
        Match.discriminator("type")("text", (value) => (value.tokens === undefined ? [value.text] : children())),
        Match.discriminator("type")("escape", (value) => [value.text]),
        Match.discriminator("type")("strong", () => [h.strong([], children())]),
        Match.discriminator("type")("em", () => [h.em([], children())]),
        Match.discriminator("type")("del", () => [h.del([], children())]),
        Match.discriminator("type")("codespan", (value) => [h.code([], [value.text])]),
        Match.discriminator("type")("code", (value) => [h.pre([h.Tabindex(0)], [h.code([], [value.text])])]),
        Match.discriminator("type")("br", () => [h.br([])]),
        Match.discriminator("type")("hr", () => [h.hr([])]),
        Match.discriminator("type")("blockquote", () => [h.blockquote([], children())]),
        Match.discriminator("type")("link", (value) =>
          safeLink(value.href) ? [h.a([h.Href(value.href), h.Rel("noreferrer noopener")], children())] : children(),
        ),
        Match.discriminator("type")("image", (value) => [h.span([], [`[Image: ${value.text}]`])]),
        Match.discriminator("type")("list", (value) => {
          const entries = value.items.map((entry) => {
            const check = entry.checked === true ? "☑ " : "☐ "
            return h.li([], [entry.task ? check : "", ...tokens(entry.tokens)])
          })
          return [value.ordered ? h.ol([h.Start(Number(value.start) || 1)], entries) : h.ul([], entries)]
        }),
        Match.discriminator("type")("table", (value) => [
          h.div(
            [h.Class("table-scroll"), h.Tabindex(0)],
            [
              h.table(
                [],
                [
                  h.thead(
                    [],
                    [
                      h.tr(
                        [],
                        value.header.map((cell) => h.th([], tokens(cell.tokens))),
                      ),
                    ],
                  ),
                  h.tbody(
                    [],
                    value.rows.map((row) =>
                      h.tr(
                        [],
                        row.map((cell) => h.td([], tokens(cell.tokens))),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ]),
        Match.orElse((value) => [value.raw]),
      )
    })
  return h.div([h.Class("markdown")], tokens(parser.lexer(text)))
})

const diff = <M>(path: string, patch: string, h: HtmlBuilder<M>) =>
  h.details(
    [h.Class("diff")],
    [
      h.summary([], [path]),
      h.pre(
        [h.Tabindex(0)],
        patch.split("\n").map((line) => {
          let kind = "context"
          if (line.startsWith("+")) kind = "added"
          else if (line.startsWith("-")) kind = "removed"
          return h.span([h.Class(kind)], [line + "\n"])
        }),
      ),
    ],
  )

const block = <M>(source: Block, h: HtmlBuilder<M>): Html => {
  const disclosure = (title: string, text: string) =>
    h.details([h.Class("tool")], [h.summary([], [title]), h.pre([h.Tabindex(0)], [text])])
  return Match.value(source).pipe(
    Match.tagsExhaustive({
      ToolCall: (value) =>
        h.details(
          [h.Class(`tool tool-${value.status}`)],
          [
            h.summary(
              [],
              [h.strong([], [value.name]), ` · ${value.status}`, h.span([h.Class("muted")], [` — ${value.detail}`])],
            ),
            h.h3([], ["Input"]),
            h.pre([h.Tabindex(0)], [value.input]),
            ...(value.process === undefined
              ? []
              : [
                  h.h3([], ["Process output"]),
                  h.pre([h.Tabindex(0)], [value.process.stdout ?? "", value.process.stderr ?? ""]),
                  h.p(
                    [],
                    [
                      value.process.running === true
                        ? "Process running"
                        : `Exit code: ${value.process.exitCode ?? "not reported"}`,
                    ],
                  ),
                ]),
            ...(value.result === undefined
              ? []
              : [
                  h.h3([], ["Result"]),
                  h.pre(
                    [h.Tabindex(0)],
                    [Schema.is(Schema.String)(value.result) ? value.result : encodeJson(value.result)],
                  ),
                ]),
            ...(value.truncated === true || value.process?.truncated === true
              ? [h.p([h.Class("muted")], ["Output truncated by the executor."])]
              : []),
            ...value.files.map((file) =>
              diff(
                `${file.path} · +${file.additions} −${file.deletions}${file.preview ? " · preview" : ""}`,
                file.patch,
                h,
              ),
            ),
          ],
        ),
      ToolResult: (value) => disclosure(value.failed ? "Tool result · failed" : "Tool result", value.output),
      Diff: (value) => diff(value.path, value.patch, h),
      Reasoning: (value) => disclosure("Reasoning", value.text),
      Error: (value) => h.div([h.Class("error")], [h.strong([], [value.title]), h.p([], [value.detail])]),
      Notification: (value) => h.div([h.Class("notice")], [h.strong([], [value.title]), h.p([], [value.detail])]),
      SubagentCard: (value) =>
        disclosure(`${value.name} · ${value.status}`, [value.prompt, value.summary, ...value.activity].join("\n\n")),
      SubagentGroup: (value) =>
        h.p([], [`${value.name} · ${value.status} · ${value.counts.complete}/${value.counts.total} complete`]),
      AuthorizationCard: (value) =>
        disclosure(
          `Authorization · ${value.operation} · ${value.status}`,
          `${value.capability}\n${value.input}${value.inputTruncated ? "\n[Truncated]" : ""}\nRead-only authorization record.`,
        ),
      Compaction: (value) => disclosure(`Compaction · ${value.status ?? "complete"}`, value.summary),
      ContextUsage: (value) => h.p([h.Class("muted")], [value.text, value.cost ?? ""]),
      ImageAttachment: (value) => h.p([], [`Attachment: ${value.name} (${value.mediaType})`]),
    }),
  )
}

export const transcriptUnit: {
  <M>(unit: Unit, h: HtmlBuilder<M>): Html
  <M>(h: HtmlBuilder<M>): (unit: Unit) => Html
} = Function.dual(
  2,
  <M>(unit: Unit, h: HtmlBuilder<M>): Html =>
    h.keyed("article")(
      unit.key,
      [h.Class(unit.content._tag === "Entry" ? `entry ${unit.content.role}` : "block")],
      unit.content._tag === "Entry"
        ? [
            h.h3([h.Class("role")], [{ user: "User", assistant: "Assistant", notice: "Notice" }[unit.content.role]]),
            markdown(unit.content.text, h),
          ]
        : [block(unit.content.block, h)],
    ),
)
