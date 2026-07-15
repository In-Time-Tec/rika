import { Function } from "effect"
import Prism from "prismjs"
import "prismjs/components/prism-typescript.js"
import "prismjs/components/prism-jsx.js"
import "prismjs/components/prism-tsx.js"
import "prismjs/components/prism-json.js"
import "prismjs/components/prism-bash.js"
import "prismjs/components/prism-python.js"
import "prismjs/components/prism-rust.js"
import "prismjs/components/prism-go.js"
import "prismjs/components/prism-sql.js"
import "prismjs/components/prism-yaml.js"
import "prismjs/components/prism-diff.js"
import "prismjs/components/prism-toml.js"
import { fg, type TextChunk } from "@opentui/core"
import { colors } from "./theme"

const roleColors = {
  keyword: colors.blue,
  string: colors.green,
  number: colors.amber,
  comment: colors.muted,
  function: colors.teal,
  type: colors.purple,
} as const

type Role = keyof typeof roleColors | "plain"

const tokenRole = (type: string): Role => {
  switch (type) {
    case "keyword":
    case "boolean":
    case "important":
      return "keyword"
    case "string":
    case "char":
    case "template-string":
    case "attr-value":
    case "regex":
    case "inserted":
      return "string"
    case "number":
      return "number"
    case "comment":
    case "prolog":
    case "doctype":
    case "cdata":
    case "deleted":
      return "comment"
    case "function":
      return "function"
    case "class-name":
    case "builtin":
    case "type":
      return "type"
    default:
      return "plain"
  }
}

type Run = { readonly text: string; readonly role: Role }

const flatten = (tokens: ReadonlyArray<string | Prism.Token>, parent: Role, out: Array<Run>): void => {
  for (const token of tokens) {
    if (typeof token === "string") {
      out.push({ text: token, role: parent })
      continue
    }
    const role = tokenRole(token.type) === "plain" ? parent : tokenRole(token.type)
    if (typeof token.content === "string") out.push({ text: token.content, role })
    else if (Array.isArray(token.content)) flatten(token.content, role, out)
    else flatten([token.content], role, out)
  }
}

const grammarFor = (lang: string | undefined): Prism.Grammar | undefined =>
  lang === undefined || lang.length === 0 ? undefined : Prism.languages[lang.toLowerCase()]

export const highlightLines: {
  (lang: string | undefined): (code: string) => ReadonlyArray<ReadonlyArray<TextChunk>>
  (code: string, lang: string | undefined): ReadonlyArray<ReadonlyArray<TextChunk>>
} = Function.dual(2, (code: string, lang: string | undefined): ReadonlyArray<ReadonlyArray<TextChunk>> => {
  const grammar = grammarFor(lang)
  const runs: Array<Run> = []
  if (grammar === undefined) runs.push({ text: code, role: "plain" })
  else flatten(Prism.tokenize(code, grammar), "plain", runs)
  const lines: Array<Array<TextChunk>> = [[]]
  for (const run of runs) {
    run.text.split("\n").forEach((piece, index) => {
      if (index > 0) lines.push([])
      if (piece.length === 0) return
      lines[lines.length - 1]!.push(run.role === "plain" ? fg(colors.text)(piece) : fg(roleColors[run.role])(piece))
    })
  }
  return lines
})
