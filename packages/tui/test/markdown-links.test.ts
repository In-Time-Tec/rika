import { describe, expect, test } from "bun:test"
import { Adapter } from "../src/index"

const TEAL: readonly [number, number, number] = [45, 212, 191]

type Chunk = Adapter.RenderedChunk

const chunksOf = (markdown: string): ReadonlyArray<Chunk> => Adapter.renderMarkdownChunks(markdown)

const linkChunks = (markdown: string): ReadonlyArray<Chunk> =>
  chunksOf(markdown).filter((chunk) => chunk.url !== undefined)

describe("renderMarkdownChunks link handling", () => {
  test("linkifies a bare http(s) URL with teal underline and the URL as its target", () => {
    const links = linkChunks("Visit https://github.com/In-Time-Tec/relay for details")
    expect(links).toHaveLength(1)
    const [chunk] = links
    expect(chunk?.text).toBe("https://github.com/In-Time-Tec/relay")
    expect(chunk?.url).toBe("https://github.com/In-Time-Tec/relay")
    expect(chunk?.fg).toEqual([...TEAL])
    expect(chunk?.underline).toBe(true)
  })

  test("markdown [text](url) shows only the text but links to the url", () => {
    const chunks = chunksOf("Build passed: [ci #123](https://ci.example.com/runs/123).")
    const links = chunks.filter((chunk) => chunk.url !== undefined)
    expect(links).toHaveLength(1)
    expect(links[0]?.text).toBe("ci #123")
    expect(links[0]?.url).toBe("https://ci.example.com/runs/123")
    const rendered = chunks.map((chunk) => chunk.text).join("")
    expect(rendered).toBe("Build passed: ci #123.")
    expect(rendered).not.toContain("[")
    expect(rendered).not.toContain("ci.example.com")
  })

  test("trailing sentence punctuation is not swallowed into the link", () => {
    const chunks = chunksOf("See https://example.com/a.")
    const link = chunks.find((chunk) => chunk.url !== undefined)
    expect(link?.url).toBe("https://example.com/a")
    expect(chunks.map((chunk) => chunk.text).join("")).toBe("See https://example.com/a.")
    expect(chunks.some((chunk) => chunk.url === undefined && chunk.text === ".")).toBe(true)
  })

  test("URL inside backticks stays literal code and is not linkified", () => {
    const chunks = chunksOf("Run `curl https://example.com` locally")
    expect(chunks.some((chunk) => chunk.url !== undefined)).toBe(false)
    expect(chunks.some((chunk) => chunk.text === "curl https://example.com")).toBe(true)
  })

  test("markdown link syntax inside backticks stays literal code", () => {
    const chunks = chunksOf("Type `[label](https://example.com)` verbatim")
    expect(chunks.some((chunk) => chunk.url !== undefined)).toBe(false)
    expect(chunks.some((chunk) => chunk.text === "[label](https://example.com)")).toBe(true)
  })

  test("URLs inside fenced code blocks are not linkified", () => {
    const chunks = chunksOf("```\nhttps://example.com/in/fence\n```")
    expect(chunks.some((chunk) => chunk.url !== undefined)).toBe(false)
  })

  test("bare URLs are linkified inside bullet list items", () => {
    const links = linkChunks("- see https://example.com/docs")
    expect(links).toHaveLength(1)
    expect(links[0]?.url).toBe("https://example.com/docs")
  })

  test("multiple links on one line are each linkified independently", () => {
    const links = linkChunks("[a](https://a.example.com) and https://b.example.com done")
    expect(links.map((chunk) => chunk.text)).toEqual(["a", "https://b.example.com"])
    expect(links.map((chunk) => chunk.url)).toEqual(["https://a.example.com", "https://b.example.com"])
  })

  test("plain prose without URLs produces no link chunks", () => {
    const chunks = chunksOf("just some ordinary text with no links at all")
    expect(chunks.some((chunk) => chunk.url !== undefined)).toBe(false)
  })

  test("non-http schemes are not linkified", () => {
    const chunks = chunksOf("mailto:me@example.com and ftp://host/file")
    expect(chunks.some((chunk) => chunk.url !== undefined)).toBe(false)
  })
})
