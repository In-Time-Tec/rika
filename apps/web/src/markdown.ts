import { html, type Html } from "foldkit/html"
import { Lexer, type Token, type Tokens } from "marked"
import * as CodeBlock from "./components/ui/code-block"

const H = html()

export const codeBlock = (language: string, code: string, title: string): Html =>
  CodeBlock.codeBlock({ language, class: "my-1 max-w-full" }, [
    CodeBlock.codeBlockHeader({}, [CodeBlock.codeBlockTitle({}, [CodeBlock.codeBlockFilename({}, [title])])]),
    CodeBlock.codeBlockContent({ code }),
  ])

export const markdownContent = (value: string): ReadonlyArray<Html> => [
  H.div([H.Class("markdown-body")], blockTokens(Lexer.lex(value, { gfm: true, breaks: true }))),
]

const blockTokens = (tokens: ReadonlyArray<Token>): ReadonlyArray<Html | string> => tokens.flatMap(blockToken)

const blockToken = (token: Token): ReadonlyArray<Html | string> => {
  switch (token.type) {
    case "space":
    case "def":
      return []
    case "heading":
      return [headingNode(token)]
    case "paragraph":
      return [H.p([], inlineTokens(token.tokens))]
    case "code":
      return [codeBlock(token.lang || "text", token.text, token.lang || "text")]
    case "blockquote":
      return [H.blockquote([], blockTokens(token.tokens ?? []))]
    case "list":
      return [listNode(token)]
    case "table":
      return [tableNode(token)]
    case "hr":
      return [H.hr([])]
    case "html":
      return [H.span([H.Class("whitespace-pre-wrap")], [token.text])]
    case "text":
      return token.tokens === undefined ? [token.text] : inlineTokens(token.tokens)
    default:
      return [rawText(token)]
  }
}

const headingNode = (token: Tokens.Heading | Tokens.Generic): Html => {
  const children = inlineTokens(token.tokens)
  switch (token.depth) {
    case 1:
      return H.h1([], children)
    case 2:
      return H.h2([], children)
    case 3:
      return H.h3([], children)
    case 4:
      return H.h4([], children)
    case 5:
      return H.h5([], children)
    default:
      return H.h6([], children)
  }
}

const listNode = (token: Tokens.List | Tokens.Generic): Html => {
  const listItems: ReadonlyArray<Tokens.ListItem> = token.items ?? []
  const items = listItems.map((item) => H.li([], blockTokens(item.tokens)))
  if (token.ordered !== true) return H.ul([], items)
  const attributes = token.start === "" || token.start === 1 ? [] : [H.Attribute("start", String(token.start))]
  return H.ol(attributes, items)
}

const tableNode = (token: Tokens.Table | Tokens.Generic): Html => {
  const header: ReadonlyArray<Tokens.TableCell> = token.header ?? []
  const rows: ReadonlyArray<ReadonlyArray<Tokens.TableCell>> = token.rows ?? []
  return H.table(
    [],
    [
      H.thead([], [H.tr([], header.map((cell) => H.th([], inlineTokens(cell.tokens))))]),
      H.tbody(
        [],
        rows.map((row) => H.tr([], row.map((cell) => H.td([], inlineTokens(cell.tokens))))),
      ),
    ],
  )
}

const inlineTokens = (tokens: ReadonlyArray<Token> | undefined): ReadonlyArray<Html | string> =>
  (tokens ?? []).flatMap(inlineToken)

const inlineToken = (token: Token): ReadonlyArray<Html | string> => {
  switch (token.type) {
    case "text":
      return token.tokens === undefined ? [token.text] : inlineTokens(token.tokens)
    case "escape":
      return [token.text]
    case "codespan":
      return [H.code([], [token.text])]
    case "strong":
      return [H.strong([], inlineTokens(token.tokens))]
    case "em":
      return [H.em([], inlineTokens(token.tokens))]
    case "del":
      return [H.del([], inlineTokens(token.tokens))]
    case "br":
      return [H.br([])]
    case "link":
      return [linkNode(token)]
    case "image":
      return [token.text]
    case "html":
      return [token.text]
    default:
      return [rawText(token)]
  }
}

const linkNode = (token: Tokens.Link | Tokens.Generic): Html => {
  const tokens: ReadonlyArray<Token> = token.tokens ?? []
  const href = safeHref(typeof token.href === "string" ? token.href : "")
  const children = tokens.length === 0 ? [rawText(token)] : inlineTokens(tokens)
  if (href === undefined) return H.span([], children)
  return H.a([H.Href(href), H.Target("_blank"), H.Rel("noreferrer noopener")], children)
}

const safeHref = (href: string): string | undefined => {
  const trimmed = href.trim()
  if (trimmed.length === 0) return undefined
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined
  return trimmed
}

const rawText = (token: Token): string => ("raw" in token ? token.raw : "")
