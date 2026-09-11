import { Function } from "effect"

const splitLines = (text: string): ReadonlyArray<string> => {
  if (text.length === 0) return []
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

type Op = { readonly tag: "equal" | "delete" | "insert"; readonly line: string }

const lcsMatrixLimit = 4_000_000

const diffMiddle = (oldLines: ReadonlyArray<string>, newLines: ReadonlyArray<string>): ReadonlyArray<Op> => {
  const rows = oldLines.length
  const cols = newLines.length
  if (rows === 0) return newLines.map((line) => ({ tag: "insert" as const, line }))
  if (cols === 0) return oldLines.map((line) => ({ tag: "delete" as const, line }))
  if (rows * cols > lcsMatrixLimit)
    return [
      ...oldLines.map((line) => ({ tag: "delete" as const, line })),
      ...newLines.map((line) => ({ tag: "insert" as const, line })),
    ]
  const table: Array<Int32Array> = Array.from({ length: rows + 1 }, () => new Int32Array(cols + 1))
  for (let row = rows - 1; row >= 0; row -= 1) {
    const current = table[row]!
    const below = table[row + 1]!
    for (let col = cols - 1; col >= 0; col -= 1)
      current[col] = oldLines[row] === newLines[col] ? below[col + 1]! + 1 : Math.max(below[col]!, current[col + 1]!)
  }
  const ops: Array<Op> = []
  let row = 0
  let col = 0
  while (row < rows && col < cols) {
    if (oldLines[row] === newLines[col]) {
      ops.push({ tag: "equal", line: oldLines[row]! })
      row += 1
      col += 1
    } else if (table[row + 1]![col]! >= table[row]![col + 1]!) {
      ops.push({ tag: "delete", line: oldLines[row]! })
      row += 1
    } else {
      ops.push({ tag: "insert", line: newLines[col]! })
      col += 1
    }
  }
  while (row < rows) ops.push({ tag: "delete", line: oldLines[row++]! })
  while (col < cols) ops.push({ tag: "insert", line: newLines[col++]! })
  return ops
}

const diffLines = (oldLines: ReadonlyArray<string>, newLines: ReadonlyArray<string>): ReadonlyArray<Op> => {
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  )
    suffix += 1
  return [
    ...oldLines.slice(0, prefix).map((line) => ({ tag: "equal" as const, line })),
    ...diffMiddle(oldLines.slice(prefix, oldLines.length - suffix), newLines.slice(prefix, newLines.length - suffix)),
    ...oldLines.slice(oldLines.length - suffix).map((line) => ({ tag: "equal" as const, line })),
  ]
}

type Annotated = { readonly tag: Op["tag"]; readonly oldNo: number; readonly newNo: number; readonly line: string }

const context = 3

const marker = (tag: Op["tag"]): string => {
  if (tag === "delete") return "-"
  if (tag === "insert") return "+"
  return " "
}

export const unifiedDiff: {
  (oldText: string, newText: string, created?: boolean): (path: string) => string | undefined
  (path: string, oldText: string, newText: string, created?: boolean): string | undefined
} = Function.dual(
  (args) => args.length >= 3,
  (path: string, oldText: string, newText: string, created = false): string | undefined => {
    if (oldText === newText) return undefined
    const ops = diffLines(splitLines(oldText), splitLines(newText))
    const annotated: Array<Annotated> = []
    let oldNo = 1
    let newNo = 1
    for (const op of ops) {
      if (op.tag === "equal") annotated.push({ tag: "equal", oldNo: oldNo++, newNo: newNo++, line: op.line })
      else if (op.tag === "delete") annotated.push({ tag: "delete", oldNo: oldNo++, newNo, line: op.line })
      else annotated.push({ tag: "insert", oldNo, newNo: newNo++, line: op.line })
    }
    const changes = annotated.flatMap((entry, index) => (entry.tag === "equal" ? [] : [index]))
    if (changes.length === 0) return undefined
    const clusters: Array<[number, number]> = []
    for (const index of changes) {
      const last = clusters.at(-1)
      if (last !== undefined && index - last[1] <= context * 2 + 1) last[1] = index
      else clusters.push([index, index])
    }
    const body = clusters.map(([firstChange, lastChange]) => {
      const start = Math.max(0, firstChange - context)
      const end = Math.min(annotated.length - 1, lastChange + context)
      const slice = annotated.slice(start, end + 1)
      const oldCount = slice.filter((entry) => entry.tag !== "insert").length
      const newCount = slice.filter((entry) => entry.tag !== "delete").length
      const first = slice[0]!
      const oldSpec = oldCount === 0 ? `${first.oldNo - 1},0` : `${first.oldNo},${oldCount}`
      const newSpec = newCount === 0 ? `${first.newNo - 1},0` : `${first.newNo},${newCount}`
      return [`@@ -${oldSpec} +${newSpec} @@`, ...slice.map((entry) => `${marker(entry.tag)}${entry.line}`)].join("\n")
    })
    const header = [
      `diff --git a/${path} b/${path}`,
      ...(created === true ? ["new file mode 100644"] : []),
      `--- ${created === true ? "/dev/null" : `a/${path}`}`,
      `+++ b/${path}`,
    ]
    return [...header, ...body].join("\n")
  },
)
