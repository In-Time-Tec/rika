import { expect, test } from "vitest"
import type { Block } from "../../src/schema/presentation"
import { cellBodyText } from "../../src/presentation/cell"
import { cellSourceLineCount, cellVisual, meaningfulSourceLines } from "../../src/presentation/cell-source"

type Cell = Extract<Block, { readonly _tag: "Cell" }>

const cell = (overrides: Partial<Cell> = {}): Cell => ({
  _tag: "Cell",
  id: "cell-1",
  status: "complete",
  visual: "ts",
  source: { text: "", lines: 0 },
  output: { stdout: "", stderr: "" },
  epoch: 0,
  notices: [],
  calls: [],
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

test("the body text joins every non-empty channel", () => {
  expect(
    cellBodyText(
      cell({
        source: { text: "const a = 1", lines: 1 },
        output: { stdout: "out", stderr: "err" },
        result: "1",
        error: { name: "Error", message: "boom", stack: "at cell" },
        notices: [{ kind: "restored", detail: "Restored a." }],
      }),
    ),
  ).toBe('const a = 1\nout\nerr\n"1"\nError: boom\nat cell\nRestored a.')
  expect(cellBodyText(cell())).toBe("")
})
