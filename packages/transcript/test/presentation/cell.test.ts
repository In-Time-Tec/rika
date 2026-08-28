import { expect, test } from "vitest"
import type { Block } from "../../src/schema/presentation"
import { cellBodyText, cellOutputTruncated, formatCellDuration } from "../../src/presentation/cell"
import { cellSourceLineCount, cellVisual, meaningfulSourceLines } from "../../src/presentation/cell-source"

type Cell = Extract<Block, { readonly _tag: "Cell" }>

const cell = (overrides: Partial<Cell> = {}): Cell => ({
  _tag: "Cell",
  id: "cell-1",
  status: "complete",
  visual: "ts",
  source: { text: "", lines: 0, truncated: false },
  output: { stdout: "", stderr: "", droppedBytes: 0, droppedEvents: 0 },
  epoch: 0,
  notices: [],
  files: [],
  ...overrides,
})

test("meaningful source lines drop blank lines and comments", () => {
  expect(meaningfulSourceLines("\n// a comment\n/* block */\n* continued\nconst a = 1\n")).toEqual(["const a = 1"])
})

test("a single Bun shell statement reads as the shell visual", () => {
  expect(cellVisual("await Bun.$`bun test`")).toBe("shell")
  expect(cellVisual("// run it\nBun.spawn(['bun', 'test'])")).toBe("shell")
  expect(cellVisual("Bun.spawnSync(['ls'])")).toBe("shell")
  expect(cellVisual("await Bun.$`bun test`\nconst extra = 1")).toBe("ts")
  expect(cellVisual("const a = 1")).toBe("ts")
  expect(cellVisual("")).toBe("ts")
})

test("source line counts are exact", () => {
  expect(cellSourceLineCount("")).toBe(0)
  expect(cellSourceLineCount("a")).toBe(1)
  expect(cellSourceLineCount("a\nb\n")).toBe(3)
})

test("durations format by magnitude", () => {
  expect(formatCellDuration(0)).toBe("0ms")
  expect(formatCellDuration(940)).toBe("940ms")
  expect(formatCellDuration(1_240)).toBe("1.2s")
  expect(formatCellDuration(95_000)).toBe("1m 35s")
  expect(formatCellDuration(-1)).toBe("")
  expect(formatCellDuration(Number.NaN)).toBe("")
})

test("truncation is either source or output loss", () => {
  expect(cellOutputTruncated(cell())).toBe(false)
  expect(cellOutputTruncated(cell({ source: { text: "a", lines: 1, truncated: true } }))).toBe(true)
  expect(cellOutputTruncated(cell({ output: { stdout: "", stderr: "", droppedBytes: 12, droppedEvents: 0 } }))).toBe(
    true,
  )
  expect(cellOutputTruncated(cell({ output: { stdout: "", stderr: "", droppedBytes: 0, droppedEvents: 3 } }))).toBe(
    true,
  )
})

test("the body text joins every non-empty channel", () => {
  expect(
    cellBodyText(
      cell({
        source: { text: "const a = 1", lines: 1, truncated: false },
        output: { stdout: "out", stderr: "err", droppedBytes: 0, droppedEvents: 0 },
        result: "1",
        error: { name: "Error", message: "boom", stack: "at cell" },
        notices: [{ kind: "restored", detail: "Restored a." }],
      }),
    ),
  ).toBe("const a = 1\nout\nerr\n1\nError: boom\nat cell\nRestored a.")
  expect(cellBodyText(cell())).toBe("")
})
