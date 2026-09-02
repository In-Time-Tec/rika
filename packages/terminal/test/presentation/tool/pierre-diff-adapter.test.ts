import { describe, expect, test } from "vitest"
import type { TerminalTextChunk as TextChunk } from "../../../src/presentation/markdown/styled-text"
import { renderPierreDiff } from "../../../src/presentation/tool/pierre-diff-adapter"
import { colors } from "../../../src/presentation/terminal/theme"

const patch = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " const keep = 1",
  '-const removed = "old"',
  '+const added = "new"',
  "",
].join("\n")

const splitLines = (chunks: ReadonlyArray<TextChunk>): ReadonlyArray<ReadonlyArray<TextChunk>> => {
  const lines: Array<Array<TextChunk>> = [[]]
  for (const chunk of chunks) {
    if (chunk.text === "\n") lines.push([])
    else lines[lines.length - 1]!.push(chunk)
  }
  return lines
}

const lineText = (line: ReadonlyArray<TextChunk>): string => line.map((chunk) => chunk.text).join("")

describe("renderPierreDiff", () => {
  test("indents the gutter and colors it by change type", () => {
    const lines = splitLines(renderPierreDiff(patch, { width: 100 })!.chunks)
    const context = lines.find((line) => lineText(line).includes("keep"))!
    const removed = lines.find((line) => lineText(line).includes("removed"))!
    const added = lines.find((line) => lineText(line).includes("added"))!
    expect(context[0]!.text).toBe("  1   ")
    expect(context[0]!.fg).toEqual(colors.muted)
    expect(removed[0]!.text).toBe("  2 - ")
    expect(removed[0]!.fg).toEqual(colors.red)
    expect(added[0]!.text).toBe("  2 + ")
    expect(added[0]!.fg).toEqual(colors.green)
  })

  test("syntax highlights every row and tints additions and deletions", () => {
    const lines = splitLines(renderPierreDiff(patch, { width: 40 })!.chunks)
    const context = lines.find((line) => lineText(line).includes("keep"))!
    const removed = lines.find((line) => lineText(line).includes("removed"))!
    const added = lines.find((line) => lineText(line).includes("added"))!
    expect(context.find((chunk) => chunk.text === "const")!.fg).toEqual(colors.blue)
    expect(context.every((chunk) => chunk.bg === undefined)).toBe(true)
    expect(added.find((chunk) => chunk.text === "const")!.fg).toEqual(colors.blue)
    expect(added.slice(1).every((chunk) => chunk.bg === colors.addedBg)).toBe(true)
    expect(lineText(added)).toHaveLength(40)
    expect(removed.find((chunk) => chunk.text === "const")!.fg).toEqual(colors.blue)
    expect(removed.slice(1).every((chunk) => chunk.bg === colors.removedBg)).toBe(true)
    expect(lineText(removed)).toHaveLength(40)
  })

  test("falls back to plain tinted text and muted context for unknown languages", () => {
    const plain = ["--- a/notes.txt", "+++ b/notes.txt", "@@ -1,2 +1,2 @@", " same words", "+more words", ""].join("\n")
    const lines = splitLines(renderPierreDiff(plain, { width: 100 })!.chunks)
    const context = lines.find((line) => lineText(line).includes("same"))!
    const added = lines.find((line) => lineText(line).includes("more"))!
    expect(context[1]!.fg).toEqual(colors.muted)
    expect(added[1]!.fg).toEqual(colors.text)
    expect(added[1]!.bg).toEqual(colors.addedBg)
  })

  test("clips highlighted lines to the width with an ellipsis", () => {
    const lines = splitLines(renderPierreDiff(patch, { width: 16 })!.chunks)
    for (const line of lines) expect(lineText(line).length).toBeLessThanOrEqual(16)
    const added = lines.find((line) => lineText(line).startsWith("  2 + "))!
    expect(lineText(added).endsWith("…")).toBe(true)
  })

  test("aligns hunk ellipsis rows with the number column", () => {
    const twoDigit = patch.replace("@@ -1,3 +1,3 @@", "@@ -10,3 +10,3 @@")
    const twoDigitLines = splitLines(renderPierreDiff(twoDigit, { width: 100 })!.chunks)
    expect(lineText(twoDigitLines[0]!)).toBe("  ...")
    expect(twoDigitLines[0]![0]!.fg).toEqual(colors.muted)
    const threeDigit = patch.replace("@@ -1,3 +1,3 @@", "@@ -100,3 +100,3 @@")
    const threeDigitLines = splitLines(renderPierreDiff(threeDigit, { width: 100 })!.chunks)
    expect(lineText(threeDigitLines[0]!)).toBe("  ...")
  })

  test("honors a wider indent for nested diffs", () => {
    const lines = splitLines(renderPierreDiff(patch, { width: 100, indent: 4 })!.chunks)
    const context = lines.find((line) => lineText(line).includes("keep"))!
    expect(context[0]!.text.startsWith("    1")).toBe(true)
  })

  test("a patch without hunk headers cannot render, so completed edits must carry the real unified diff", () => {
    const synthetic = "--- a/src/a.ts\n+++ b/src/a.ts\n-const a = 1\n+const a = 2"
    expect(renderPierreDiff(synthetic, { width: 100 })).toBeUndefined()
    const real = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-const a = 1\n+const a = 2"
    expect(renderPierreDiff(real, { width: 100 })).toBeDefined()
  })
})
