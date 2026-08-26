import { Function } from "effect"
import { clipToWidth } from "../terminal/format"

const clip = clipToWidth

const renderDiffCache = new Map<string, string>()
const styledDiffCache = new Map<string, ReadonlyArray<TerminalTextChunk> | null>()
const diffCacheLimit = 256

const cachedDiff = <A>(cache: Map<string, A>, key: string, compute: () => A): A => {
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const value = compute()
  if (cache.size >= diffCacheLimit) cache.delete(cache.keys().next().value!)
  cache.set(key, value)
  return value
}

export const renderDiff: {
  (width: number): (patch: string) => string
  (patch: string, width: number): string
} = Function.dual(2, (patch: string, width: number): string =>
  cachedDiff(renderDiffCache, `${width}:${patch}`, () => renderDiffUncached(patch, width)),
)

const renderDiffUncached = (patch: string, width: number): string => {
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
}

export type DiffStyleOptions = { readonly width: number; readonly indent?: number }

export const renderDiffStyled: {
  (options: DiffStyleOptions): (patch: string) => TerminalStyledText
  (patch: string, options: DiffStyleOptions): TerminalStyledText
} = Function.dual(2, (patch: string, options: DiffStyleOptions): TerminalStyledText => {
  const indent = " ".repeat(options.indent ?? 2)
  const chunks = cachedDiff(styledDiffCache, `s:${indent.length}:${options.width}:${patch}`, () => {
    const lines = renderDiff(patch, Math.max(1, options.width - indent.length)).split("\n")
    const built: Array<TerminalTextChunk> = []
    lines.forEach((line, index) => {
      let color = colors.muted
      if (/^\s*\d*\s+\+/.test(line)) color = colors.green
      else if (/^\s*\d+\s+\s*-/.test(line)) color = colors.red
      built.push(line.startsWith("@@") ? bold(fg(colors.blue)(`${indent}${line}`)) : fg(color)(`${indent}${line}`))
      if (index < lines.length - 1) built.push(fg(colors.text)("\n"))
    })
    return built
  })
  return new TerminalStyledText([...(chunks ?? [])])
})

export const renderPartialDiffStyled: {
  (options: DiffStyleOptions): (patch: string) => TerminalStyledText | undefined
  (patch: string, options: DiffStyleOptions): TerminalStyledText | undefined
} = Function.dual(2, (patch: string, options: DiffStyleOptions): TerminalStyledText | undefined => {
  const indent = " ".repeat(options.indent ?? 2)
  const chunks = cachedDiff(styledDiffCache, `t:${indent.length}:${options.width}:${patch}`, () => {
    const lines = patch
      .split("\n")
      .filter(
        (line): line is `${"+" | "-"}${string}` =>
          (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")),
      )
    if (lines.length === 0) return null
    const built: Array<TerminalTextChunk> = []
    lines.forEach((line, index) => {
      const marker = line[0]!
      built.push(
        fg(marker === "+" ? colors.green : colors.red)(
          `${indent}${clip(`${marker} ${line.slice(1)}`, Math.max(1, options.width - indent.length))}`,
        ),
      )
      if (index < lines.length - 1) built.push(fg(colors.text)("\n"))
    })
    return built
  })
  return chunks === null ? undefined : new TerminalStyledText([...chunks])
})
import { TerminalStyledText, type TerminalTextChunk } from "../markdown/styled-text"
import { bold, fg } from "../markdown/styled-text-effects"
import { colors } from "../terminal/theme"
