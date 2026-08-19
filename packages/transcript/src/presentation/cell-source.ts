const shellStatement = /Bun\.(?:\$`|spawn(?:Sync)?\s*\()/u
const commentOnly = /^(?:\/\/|\/\*|\*)/u

export const meaningfulSourceLines = (source: string): ReadonlyArray<string> =>
  source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !commentOnly.test(line))

export const cellSourceLineCount = (source: string): number => (source.length === 0 ? 0 : source.split("\n").length)

export const cellSummary = (source: string): string => meaningfulSourceLines(source)[0] ?? ""

export const cellVisual = (source: string): "shell" | "ts" => {
  const lines = meaningfulSourceLines(source)
  return lines.length === 1 && shellStatement.test(lines[0]!) ? "shell" : "ts"
}
