import { TextAttributes, type TextChunk } from "@opentui/core"
import stringWidth from "string-width"
import { describe, expect, test } from "vitest"
import { renderMarkdown, renderMarkdownStyled } from "../src/markdown-renderer"
import { renderDiff } from "../src/diff-renderer"
import { renderTool } from "../src/tool-renderer"
import { colors } from "../src/theme"

const chunkFor = (chunks: ReadonlyArray<TextChunk>, text: string): TextChunk => {
  const chunk = chunks.find((candidate) => candidate.text.includes(text))
  if (chunk === undefined) throw new Error(`Missing styled chunk for ${text}`)
  return chunk
}

const hasAttribute = (chunk: TextChunk, attribute: number): boolean =>
  ((chunk.attributes ?? TextAttributes.NONE) & attribute) === attribute

describe("transcript renderers", () => {
  test("renders terminal-safe Markdown structure", () => {
    expect(
      renderMarkdown(
        "# Heading\n\n- one\n  - two\n> quoted\n`code` and [docs](https://rika.dev)\n```ts\nconst x = 1\n```",
      ),
    ).toBe("Heading\n\n- one\n  - two\n    │ quoted\n    │ code and docs <https://rika.dev>\n    const x = 1")
  })

  test("renders GFM tables as bounded terminal grids", () => {
    const rendered = renderMarkdown(
      "| Layer | Owner |\n|---|---|\n| Durable execution | Relay |\n| Agent loop | Baton |",
      48,
    )
    expect(rendered).toContain("╭")
    expect(rendered).toContain("│ Layer")
    expect(rendered).toContain("├")
    expect(rendered).toContain("Durable execution")
    expect(rendered).toContain("╰")
    expect(rendered).not.toContain("|---|---|")
    expect(rendered.split("\n").every((line) => line.length === 48)).toBe(true)
  })

  test("wraps paragraphs to the requested cell width", () => {
    const rendered = renderMarkdown("alpha beta gamma delta epsilon zeta", 20)

    expect(rendered).toBe("alpha beta gamma\ndelta epsilon zeta")
    expect(rendered.split("\n").every((line) => stringWidth(line) <= 20)).toBe(true)
  })

  test("measures CJK, emoji, and combining marks by terminal cell width", () => {
    const source = "界界界 👩‍💻 e\u0301e\u0301e\u0301"
    const rendered = renderMarkdown(source, 4)

    expect(rendered.split("\n").every((line) => stringWidth(line) <= 4)).toBe(true)
    expect(rendered.replace(/\s/gu, "")).toBe(source.replace(/\s/gu, ""))
    expect(rendered.split("\n").every((line) => !line.startsWith("\u0301"))).toBe(true)
  })

  test("keeps list and blockquote prefixes within the requested cell width", () => {
    const rendered = renderMarkdown(
      "- alpha beta gamma delta epsilon\n- [x] checked\n\n> zeta eta theta iota kappa",
      16,
    )

    expect(rendered.split("\n").every((line) => stringWidth(line) <= 16)).toBe(true)
    expect(rendered.replace(/\s/gu, "")).toContain("-alphabetagammadeltaepsilon")
    expect(rendered).toContain("- [x] checked")
    expect(rendered).not.toContain("[x] [x]")
    expect(rendered.replace(/[\s│]/gu, "")).toContain("zetaetathetaiotakappa")
  })

  test("renders terminal control characters as inert visible text", () => {
    const rendered = renderMarkdown("before \u001b]2;owned\u0007 middle \u001b[2J after")

    expect(rendered).toBe("before �]2;owned� middle �[2J after")
    expect(Array.from(rendered).every((character) => character === "\n" || !/\p{Cc}/u.test(character))).toBe(true)
  })

  test("wraps code blocks with the code indent on every physical line", () => {
    const sourceLine = "const result = someLongIdentifier"
    const rendered = renderMarkdown(`\`\`\`ts\n${sourceLine}\n\`\`\``, 20)
    const lines = rendered.split("\n")

    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every((line) => line.startsWith("    "))).toBe(true)
    expect(lines.every((line) => stringWidth(line) <= 20)).toBe(true)
    expect(lines.map((line) => line.slice(4)).join("")).toBe(sourceLine)

    const styled = renderMarkdownStyled(`\`\`\`ts\n${sourceLine}\n\`\`\``, 20)
    expect(chunkFor(styled.chunks, "const").fg?.equals(colors.blue)).toBe(true)
  })

  test("wraps table rows without losing cell content or styling", () => {
    const rendered = renderMarkdown(
      "| Alpha | Beta |\n|---|---|\n| keep every alpha phrase | preserve each beta token |",
      24,
    )

    for (const word of ["keep", "every", "alpha", "phrase", "preserve", "each", "beta", "token"])
      expect(rendered).toContain(word)
    expect(rendered.split("\n").filter((line) => line.startsWith("│")).length).toBeGreaterThan(2)
    expect(rendered.split("\n").every((line) => stringWidth(line) <= 24)).toBe(true)

    const styled = renderMarkdownStyled("| Kind |\n|---|\n| **bold** *italic* `code` |", 18)
    const boldChunk = chunkFor(styled.chunks, "bold")
    const italicChunk = chunkFor(styled.chunks, "italic")
    const codeChunk = chunkFor(styled.chunks, "code")

    expect(hasAttribute(boldChunk, TextAttributes.BOLD)).toBe(true)
    expect(hasAttribute(italicChunk, TextAttributes.ITALIC)).toBe(true)
    expect(hasAttribute(codeChunk, TextAttributes.BOLD)).toBe(true)
    expect(codeChunk.fg?.equals(colors.amber)).toBe(true)
  })

  test("stacks table cells when a minimum-width grid cannot fit", () => {
    const rendered = renderMarkdown("| A | B | C |\n|---|---|---|\n| one | two | three |", 8)

    for (const word of ["A", "B", "C", "one", "two", "three"]) expect(rendered).toContain(word)
    expect(rendered.split("\n").every((line) => stringWidth(line) <= 8)).toBe(true)
  })

  test("stacks a grid when wide graphemes cannot fit its cells", () => {
    const rendered = renderMarkdown("| A | B |\n|---|---|\n| 界 | 👩‍💻 |", 9)

    expect(rendered).toContain("界")
    expect(rendered).toContain("👩‍💻")
    expect(rendered.split("\n").every((line) => stringWidth(line) <= 9)).toBe(true)
  })

  test("preserves inline heading styles and gives heading levels distinct emphasis", () => {
    const styled = renderMarkdownStyled("###### plain **bold** *italic* `code` [link](https://rika.dev)", 18)
    const boldChunk = chunkFor(styled.chunks, "bold")
    const italicChunk = chunkFor(styled.chunks, "italic")
    const codeChunk = chunkFor(styled.chunks, "code")
    const linkChunk = chunkFor(styled.chunks, "link")
    const rendered = styled.chunks.map((chunk) => chunk.text).join("")

    expect(rendered.split("\n").length).toBeGreaterThan(1)
    expect(rendered.split("\n").every((line) => stringWidth(line) <= 18)).toBe(true)
    expect(hasAttribute(boldChunk, TextAttributes.BOLD)).toBe(true)
    expect(hasAttribute(italicChunk, TextAttributes.ITALIC)).toBe(true)
    expect(hasAttribute(codeChunk, TextAttributes.BOLD)).toBe(true)
    expect(codeChunk.fg?.equals(colors.amber)).toBe(true)
    expect(hasAttribute(linkChunk, TextAttributes.UNDERLINE)).toBe(true)
    expect(linkChunk.link?.url).toBe("https://rika.dev")

    const attributes = Array.from({ length: 6 }, (_, index) => {
      const heading = renderMarkdownStyled(`${"#".repeat(index + 1)} Level`)
      return chunkFor(heading.chunks, "Level").attributes ?? TextAttributes.NONE
    })
    expect(attributes).toEqual([
      TextAttributes.BOLD | TextAttributes.UNDERLINE,
      TextAttributes.BOLD,
      TextAttributes.UNDERLINE,
      TextAttributes.ITALIC,
      TextAttributes.NONE,
      TextAttributes.DIM,
    ])
  })

  test("renders a 4000-chunk unbroken stream without quadratic wrapping", () => {
    const source = Array.from({ length: 4_000 }, (_, index) => `LONG_CHUNK_${String(index).padStart(4, "0")};`).join("")
    const startedAt = performance.now()
    const rendered = renderMarkdownStyled(source, 116)
    const elapsed = performance.now() - startedAt
    const text = rendered.chunks.map((chunk) => chunk.text).join("")

    expect(text).toContain("LONG_CHUNK_3999")
    expect(elapsed).toBeLessThan(1_000)
  })

  test("parses hunk line numbers and clips source lines", () => {
    const rendered = renderDiff(
      "--- a/a.ts\n+++ b/a.ts\n@@ -10,2 +20,2 @@ name\n-old value that is long\n+new value that is long\n same",
      18,
    )
    expect(rendered).toContain("@@ -10,2 +20,2 @@…")
    expect(rendered).toContain("10    -old value …")
    expect(rendered).toContain("   20 +new value …")
    expect(rendered.split("\n").every((line) => line.length <= 18)).toBe(true)
  })

  test("labels status and bounds tool output", () => {
    const output = Array.from({ length: 15 }, (_, index) => `line ${index}`).join("\n")
    const rendered = renderTool({ name: "Shell", input: "run", output, status: "complete", expanded: true }, 20)
    expect(rendered).toContain("✓ Shell [succeeded] ▾")
    expect(rendered).toContain("… 3 lines omitted")
    expect(rendered).not.toContain("line 14")
  })
})
