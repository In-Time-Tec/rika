import { describe, expect, test } from "vitest"
import type { TerminalTextChunk as TextChunk } from "../../../src/presentation/markdown/styled-text"
import { renderReadFile } from "../../../src/presentation/tool/read-file-renderer"
import { colors } from "../../../src/presentation/terminal/theme"

const splitLines = (chunks: ReadonlyArray<TextChunk>): ReadonlyArray<ReadonlyArray<TextChunk>> => {
  const lines: Array<Array<TextChunk>> = [[]]
  for (const chunk of chunks) {
    if (chunk.text === "\n") lines.push([])
    else lines[lines.length - 1]!.push(chunk)
  }
  return lines
}

const lineText = (line: ReadonlyArray<TextChunk>): string => line.map((chunk) => chunk.text).join("")

const listing = ['9: const a = "x"', "10: ", "11: export const b = a", ""].join("\n")

describe("renderReadFile", () => {
  test("strips the numbered prefix into a muted gutter and highlights the code by path", () => {
    const lines = splitLines(renderReadFile(listing, { path: "src/a.ts", width: 80 }).chunks)
    expect(lines.map(lineText)).toEqual(['   9  const a = "x"', "  10  ", "  11  export const b = a"])
    expect(lines[0]![0]!.fg).toEqual(colors.muted)
    expect(lines[0]!.find((chunk) => chunk.text === "const")!.fg).toEqual(colors.blue)
    expect(lines[2]!.find((chunk) => chunk.text === "export")!.fg).toEqual(colors.blue)
  })

  test("keeps every line, renders unnumbered notices muted, and honors a prefix indent", () => {
    const text = "1: hello\n2: world\n[truncated]"
    const lines = splitLines(renderReadFile(text, { path: "notes.txt", width: 80, indent: "│   " }).chunks)
    expect(lines.map(lineText)).toEqual(["│   1  hello", "│   2  world", "│      [truncated]"])
    expect(lines[0]![0]!.fg).toEqual(colors.subtle)
    expect(lines[0]!.at(-1)!.fg).toEqual(colors.text)
    expect(lines[2]!.at(-1)!.fg).toEqual(colors.muted)
  })

  test("clips long lines to the width with an ellipsis", () => {
    const lines = splitLines(renderReadFile("1: abcdefghijklmnopqrstuvwxyz", { path: undefined, width: 12 }).chunks)
    expect(lineText(lines[0]!)).toBe("  1  abcdef…")
  })
})
