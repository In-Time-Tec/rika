import { expect, test } from "vitest"
import { renderToolSummary, joinToolSummary } from "../../../src/presentation/tool/summary"
import { colors } from "../../../src/presentation/terminal/theme"

for (const selected of [false, true]) {
  test(`Read path is underlined without its separator (selected=${selected})`, () => {
    const summary = { primary: "Read", secondary: " src/my_file.ts L2-8" }
    const chunks = renderToolSummary(summary, { leading: " ", underlineSecondary: true, selected }).flat()
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(` ${joinToolSummary(summary)}`)
    const cells = chunks.flatMap((chunk) => Array.from(chunk.text, (text) => ({ ...chunk, text })))
    expect(cells.slice(0, 6).every((cell) => ((cell.attributes ?? 0) & 8) === 0)).toBe(true)
    expect(cells.slice(6).every((cell) => ((cell.attributes ?? 0) & 8) === 8)).toBe(true)
    expect(cells.every((cell) => ((cell.attributes ?? 0) & 1) === (selected ? 1 : 0))).toBe(true)
    expect(chunks.at(-1)?.fg).toEqual(selected ? colors.blue : colors.muted)
  })
}

test("preserves a path with no separator and internal spaces", () => {
  const chunks = renderToolSummary(
    { primary: "Read", secondary: "src/my file.ts" },
    { underlineSecondary: true },
  ).flat()
  expect(chunks[1]).toMatchObject({ text: "src/my file.ts", attributes: 8 })
})

test("does not underline absent, empty, or whitespace-only secondary text", () => {
  for (const secondary of [undefined, "", "  "]) {
    const summary = secondary === undefined ? { primary: "Read" } : { primary: "Read", secondary }
    const chunks = renderToolSummary(summary, { underlineSecondary: true }).flat()
    expect(chunks.map((chunk) => chunk.text).join("")).toBe("Read")
    expect(chunks.every((chunk) => ((chunk.attributes ?? 0) & 8) === 0)).toBe(true)
  }
})

test("leaves non-link summaries unchanged", () => {
  const chunks = renderToolSummary({ primary: "Read", secondary: " file.ts" }).flat()
  expect(chunks.map((chunk) => chunk.text)).toEqual(["Read", " file.ts"])
  expect(chunks.every((chunk) => ((chunk.attributes ?? 0) & 8) === 0)).toBe(true)
})
