import { Function } from "effect"

const clip = (text: string, width: number): string =>
  text.length <= width ? text : width <= 1 ? "…" : `${text.slice(0, width - 1)}…`

export const renderDiff: {
  (width: number): (patch: string) => string
  (patch: string, width: number): string
} = Function.dual(2, (patch: string, width: number): string => {
  const lines = patch.split("\n")
  const rendered: Array<string> = []
  let oldLine = 0
  let newLine = 0
  const numberWidth = Math.max(
    1,
    ...lines.flatMap((line) => {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      return match !== null ? [match[1]?.length ?? 1, match[2]?.length ?? 1] : []
    }),
  )
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (hunk !== null) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      rendered.push(clip(line, width))
    } else if (/^(---|\+\+\+) /.test(line)) continue
    else {
      const marker = line[0] === "+" || line[0] === "-" ? line[0] : " "
      const oldLabel = marker === "+" ? "" : String(oldLine++)
      const newLabel = marker === "-" ? "" : String(newLine++)
      const prefix = `${oldLabel.padStart(numberWidth)} ${newLabel.padStart(numberWidth)} ${marker}`
      rendered.push(
        `${prefix}${clip(marker === " " ? line.replace(/^ /, "") : line.slice(1), Math.max(1, width - prefix.length))}`,
      )
    }
  }
  return rendered.length === 0 ? "(empty diff)" : rendered.join("\n")
})

export const renderDiffStyled: {
  (width: number): (patch: string) => StyledText
  (patch: string, width: number): StyledText
} = Function.dual(2, (patch: string, width: number): StyledText => {
  const lines = renderDiff(patch, width).split("\n")
  const chunks: Array<TextChunk> = []
  lines.forEach((line, index) => {
    const color = /^\s*\d*\s+\+/.test(line) ? colors.green : /^\s*\d+\s+\s*-/.test(line) ? colors.red : colors.muted
    chunks.push(line.startsWith("@@") ? bold(fg(colors.blue)(line)) : fg(color)(line))
    if (index < lines.length - 1) chunks.push(fg(colors.text)("\n"))
  })
  return new StyledText(chunks)
})

export const renderPartialDiffStyled: {
  (width: number): (patch: string) => StyledText | undefined
  (patch: string, width: number): StyledText | undefined
} = Function.dual(2, (patch: string, width: number): StyledText | undefined => {
  const lines = patch
    .split("\n")
    .filter(
      (line): line is `${"+" | "-"}${string}` =>
        (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")),
    )
  if (lines.length === 0) return undefined
  const chunks: Array<TextChunk> = []
  lines.forEach((line, index) => {
    const marker = line[0]!
    chunks.push(fg(marker === "+" ? colors.green : colors.red)(clip(`${marker} ${line.slice(1)}`, width)))
    if (index < lines.length - 1) chunks.push(fg(colors.text)("\n"))
  })
  return new StyledText(chunks)
})
import { StyledText, bold, fg, type TextChunk } from "@opentui/core"
import { colors } from "./theme"
