import { describe, expect, test } from "vitest"
import type { TextChunk } from "@opentui/core"
import { renderPierreDiff } from "../src/pierre-diff"
import { colors } from "../src/theme"

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

  test("syntax highlights context lines and paints additions green and deletions red", () => {
    const lines = splitLines(renderPierreDiff(patch, { width: 100 })!.chunks)
    const context = lines.find((line) => lineText(line).includes("keep"))!
    const removed = lines.find((line) => lineText(line).includes("removed"))!
    const added = lines.find((line) => lineText(line).includes("added"))!
    expect(context.some((chunk) => chunk.text === "const" && chunk.fg !== undefined)).toBe(true)
    expect(context.find((chunk) => chunk.text === "const")!.fg).toEqual(colors.blue)
    expect(added.slice(1)).toHaveLength(1)
    expect(added[1]!.text).toBe('const added = "new"')
    expect(added[1]!.fg).toEqual(colors.green)
    expect(removed.slice(1)).toHaveLength(1)
    expect(removed[1]!.text).toBe('const removed = "old"')
    expect(removed[1]!.fg).toEqual(colors.red)
  })

  test("falls back to plain green and muted lines for unknown languages", () => {
    const plain = ["--- a/notes.txt", "+++ b/notes.txt", "@@ -1,2 +1,2 @@", " same words", "+more words", ""].join("\n")
    const lines = splitLines(renderPierreDiff(plain, { width: 100 })!.chunks)
    const context = lines.find((line) => lineText(line).includes("same"))!
    const added = lines.find((line) => lineText(line).includes("more"))!
    expect(context[1]!.fg).toEqual(colors.muted)
    expect(added[1]!.fg).toEqual(colors.green)
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
    expect(lineText(twoDigitLines[0]!)).toBe("  ..")
    const threeDigit = patch.replace("@@ -1,3 +1,3 @@", "@@ -100,3 +100,3 @@")
    const threeDigitLines = splitLines(renderPierreDiff(threeDigit, { width: 100 })!.chunks)
    expect(lineText(threeDigitLines[0]!)).toBe("  ...")
  })

  test("honors a wider indent for nested diffs", () => {
    const lines = splitLines(renderPierreDiff(patch, { width: 100, indent: 4 })!.chunks)
    const context = lines.find((line) => lineText(line).includes("keep"))!
    expect(context[0]!.text.startsWith("    1")).toBe(true)
  })
})
