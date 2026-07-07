import { describe, expect, test } from "bun:test"
import type { Html } from "foldkit/html"
import { markdownContent } from "../src/markdown"

type Node = Html | string | null | undefined

const collectText = (node: Node): string => {
  if (node === null || node === undefined) return ""
  if (typeof node === "string") return node
  const own = node.text ?? ""
  const children = (node.children ?? []).map((child) => collectText(child as Node)).join("")
  return `${own}${children}`
}

const collectSels = (node: Node): ReadonlyArray<string> => {
  if (node === null || node === undefined || typeof node === "string") return []
  const own = node.sel === undefined ? [] : [node.sel.split(/[.#]/)[0] ?? node.sel]
  return [...own, ...(node.children ?? []).flatMap((child) => collectSels(child as Node))]
}

const render = (value: string) => {
  const nodes = markdownContent(value)
  return {
    text: nodes.map(collectText).join(""),
    sels: nodes.flatMap(collectSels),
    json: JSON.stringify(nodes),
  }
}

describe("markdownContent", () => {
  test("renders headings instead of literal markdown", () => {
    const { text, sels } = render("## Title\n\nBody text.")

    expect(sels).toContain("h2")
    expect(sels).toContain("p")
    expect(text).toContain("Title")
    expect(text).toContain("Body text.")
    expect(text).not.toContain("##")
  })

  test("renders inline emphasis", () => {
    const { text, sels } = render("**bold** and *soft* and `code` and ~~gone~~")

    expect(sels).toEqual(expect.arrayContaining(["strong", "em", "code", "del"]))
    expect(text).toContain("bold")
    expect(text).not.toContain("**")
    expect(text).not.toContain("~~")
  })

  test("renders unordered and ordered lists", () => {
    const unordered = render("- first\n- second")
    expect(unordered.sels).toContain("ul")
    expect(unordered.sels.filter((sel) => sel === "li")).toHaveLength(2)

    const ordered = render("2. first\n3. second")
    expect(ordered.sels).toContain("ol")
    expect(ordered.json).toContain('"start"')
  })

  test("delegates fenced code to the code block component", () => {
    const { text, json } = render("```ts\nconst x = 1\n```")

    expect(json).toContain("code-block")
    expect(text).toContain("const x = 1")
    expect(text).not.toContain("```")
  })

  test("renders an unclosed fence as a growing code block", () => {
    const { text, json } = render("```ts\nconst x = 1")

    expect(json).toContain("code-block")
    expect(text).toContain("const x = 1")
    expect(text).not.toContain("```")
  })

  test("keeps safe links and neutralizes unsafe protocols", () => {
    const safe = render("[docs](https://example.com)")
    expect(safe.sels).toContain("a")
    expect(safe.json).toContain("https://example.com")

    const unsafe = render("[click](javascript:alert(1))")
    expect(unsafe.sels).not.toContain("a")
    expect(unsafe.text).toContain("click")
    expect(unsafe.json).not.toContain("javascript:alert")
  })

  test("renders raw html as escaped text, never as elements", () => {
    const { text, sels } = render("before <script>alert(1)</script> after")

    expect(sels).not.toContain("script")
    expect(text).toContain("<script>")
  })

  test("turns single newlines into line breaks", () => {
    const { sels } = render("line one\nline two")

    expect(sels).toContain("br")
  })

  test("keeps sentence spacing in plain prose", () => {
    const { text } = render("First sentence. Second sentence.")

    expect(text).toContain("First sentence. Second sentence.")
  })

  test("renders blockquotes and tables", () => {
    const quote = render("> quoted line")
    expect(quote.sels).toContain("blockquote")

    const table = render("| a | b |\n| - | - |\n| 1 | 2 |")
    expect(table.sels).toEqual(expect.arrayContaining(["table", "thead", "tbody", "th", "td"]))
  })
})
