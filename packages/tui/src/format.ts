import { Function } from "effect"
import stringWidth from "string-width"

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export const formatTokens = (tokens: number): string => {
  if (tokens < 1_000) return `${tokens.toLocaleString("en-US")} tok`
  const divisor = tokens >= 1_000_000 ? 1_000_000 : 1_000
  const suffix = divisor === 1_000_000 ? "M" : "K"
  return `${(tokens / divisor).toFixed(1).replace(/\.0$/, "")}${suffix} tok`
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1).replace(/\.0$/, "")} KB`
  return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, "")} MB`
}

export const pluralWord = (singular: string): string => (singular.endsWith("ch") ? `${singular}es` : `${singular}s`)

export const plural: {
  (singular: string): (count: number) => string
  (count: number, singular: string): string
} = Function.dual(2, (count: number, singular: string): string =>
  count === 1 ? `${count} ${singular}` : `${count} ${pluralWord(singular)}`,
)

export const truncateToWidth: {
  (width: number): (text: string) => string
  (text: string, width: number): string
} = Function.dual(2, (text: string, width: number): string => {
  let truncated = ""
  let used = 0
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const cells = stringWidth(segment)
    if (used + cells > width) break
    truncated += segment
    used += cells
  }
  return truncated
})

export const clipToWidth: {
  (width: number): (text: string) => string
  (text: string, width: number): string
} = Function.dual(2, (text: string, width: number): string => {
  if (stringWidth(text) <= width) return text
  if (width <= 1) return "…"
  return `${truncateToWidth(text, width - 1)}…`
})

export const escapeControlCharacters = (text: string): string =>
  [...text]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      if (character === "\n") return "\\n"
      if (character === "\r") return "\\r"
      if (character === "\t") return "\\t"
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return `\\u{${code.toString(16)}}`
      return character
    })
    .join("")

const homeRoot = /^(?:\/Users|\/home|\/var\/home)\/[^/]+(?=\/|$)/

export const homeRelativePath = (path: string): string => path.replace(homeRoot, "~")
