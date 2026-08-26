import { Function, Schema } from "effect"
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
import "prismjs/components/prism-markdown.js"
import { bold, dim, fg } from "./styled-text-effects"
import type { TerminalTextChunk } from "./styled-text"
import { colors } from "../terminal/theme"

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
const isString = Schema.is(Schema.String)

const flatten = (tokens: ReadonlyArray<string | Prism.Token>, parent: Role, out: Array<Run>): void => {
  for (const token of tokens) {
    if (isString(token)) {
      out.push({ text: token, role: parent })
      continue
    }
    const role = tokenRole(token.type) === "plain" ? parent : tokenRole(token.type)
    if (isString(token.content)) out.push({ text: token.content, role })
    else if (Array.isArray(token.content)) flatten(token.content, role, out)
    else flatten([token.content], role, out)
  }
}

const grammarFor = (lang: string | undefined): Prism.Grammar | undefined =>
  lang === undefined || lang.length === 0 ? undefined : Prism.languages[lang.toLowerCase()]

const extensionLanguages = new Map<string, string>(
  Object.entries({
    ts: "typescript",
    mts: "typescript",
    cts: "typescript",
    tsx: "tsx",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "jsx",
    json: "json",
    jsonc: "json",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    py: "python",
    rs: "rust",
    go: "go",
    sql: "sql",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    md: "markdown",
    html: "markup",
    css: "css",
  }),
)

export const languageForPath = (path: string): string | undefined => {
  const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase()
  return extension === undefined ? undefined : extensionLanguages.get(extension)
}

const highlightCache = new Map<string, ReadonlyArray<ReadonlyArray<TerminalTextChunk>>>()
const highlightCacheLimit = 512

export const highlightLines: {
  (lang: string | undefined): (code: string) => ReadonlyArray<ReadonlyArray<TerminalTextChunk>>
  (code: string, lang: string | undefined): ReadonlyArray<ReadonlyArray<TerminalTextChunk>>
} = Function.dual(2, (code: string, lang: string | undefined): ReadonlyArray<ReadonlyArray<TerminalTextChunk>> => {
  const key = `${lang ?? ""}\u0000${code}`
  const cached = highlightCache.get(key)
  if (cached !== undefined) return cached
  const grammar = grammarFor(lang)
  const runs: Array<Run> = []
  if (grammar === undefined) runs.push({ text: code, role: "plain" })
  else flatten(Prism.tokenize(code, grammar), "plain", runs)
  const lines: Array<Array<TerminalTextChunk>> = [[]]
  for (const run of runs) {
    run.text.split("\n").forEach((piece, index) => {
      if (index > 0) lines.push([])
      if (piece.length === 0) return
      lines[lines.length - 1]!.push(run.role === "plain" ? fg(colors.text)(piece) : fg(roleColors[run.role])(piece))
    })
  }
  if (highlightCache.size >= highlightCacheLimit) highlightCache.delete(highlightCache.keys().next().value!)
  highlightCache.set(key, lines)
  return lines
})

type ShellKind =
  | "command"
  | "flag"
  | "string"
  | "operator"
  | "continuation"
  | "assignment"
  | "comment"
  | "heredoc"
  | "plain"

type ShellRun = { readonly text: string; readonly kind: ShellKind }

const shellWordDelimiters = new Set([" ", "\t", "\n", "'", '"', "|", "&", ";", "(", ")", "<", ">", "`"])

const shellAssignmentPattern = /^([A-Za-z_][A-Za-z0-9_]*=)(.*)$/

const shellHeredocPattern = /^<<-?[ \t]*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))/

const shellRedirectPattern = /^(?:\d+>>?(?:&\d+)?|&>>?|>>|>|<<<|<)/

const scanShellWord = (command: string, start: number): string => {
  let index = start
  while (index < command.length) {
    const current = command[index]!
    if (shellWordDelimiters.has(current)) break
    if (current === "\\" && command[index + 1] === "\n") break
    if (current === "$" && command[index + 1] === "(") break
    index += 1
  }
  return command.slice(start, index)
}

const scanShellCommand = (command: string): ReadonlyArray<ShellRun> => {
  const runs: Array<ShellRun> = []
  const push = (text: string, kind: ShellKind) => {
    if (text.length > 0) runs.push({ text, kind })
  }
  const pendingHeredocs: Array<{ readonly tag: string; readonly stripTabs: boolean }> = []
  let index = 0
  let commandPosition = true
  const consumeHeredocBodies = () => {
    while (pendingHeredocs.length > 0 && index < command.length) {
      const heredoc = pendingHeredocs[0]!
      const newline = command.indexOf("\n", index)
      const stop = newline === -1 ? command.length : newline
      const lineText = command.slice(index, stop)
      push(lineText, "heredoc")
      index = stop
      if (newline !== -1) {
        push("\n", "plain")
        index = newline + 1
      }
      const terminator = heredoc.stripTabs ? lineText.replace(/^\t+/, "") : lineText
      if (terminator === heredoc.tag) pendingHeredocs.shift()
    }
  }
  while (index < command.length) {
    const current = command[index]!
    if (current === "\n") {
      push("\n", "plain")
      index += 1
      commandPosition = true
      consumeHeredocBodies()
      continue
    }
    if (current === " " || current === "\t") {
      let stop = index
      while (stop < command.length && (command[stop] === " " || command[stop] === "\t")) stop += 1
      push(command.slice(index, stop), "plain")
      index = stop
      continue
    }
    if (current === "\\" && command[index + 1] === "\n") {
      push("\\", "continuation")
      index += 1
      continue
    }
    if (current === "#") {
      const newline = command.indexOf("\n", index)
      const stop = newline === -1 ? command.length : newline
      push(command.slice(index, stop), "comment")
      index = stop
      continue
    }
    if (current === "'" || current === '"') {
      const fromAssignment = runs[runs.length - 1]?.kind === "assignment"
      let stop = index + 1
      while (stop < command.length && command[stop] !== current) {
        if (current === '"' && command[stop] === "\\") stop += 1
        stop += 1
      }
      stop = Math.min(stop + 1, command.length)
      push(command.slice(index, stop), "string")
      index = stop
      if (!fromAssignment) commandPosition = false
      continue
    }
    if (command.startsWith("<<", index) && !command.startsWith("<<<", index)) {
      const heredoc = shellHeredocPattern.exec(command.slice(index))
      if (heredoc !== null) {
        const stripTabs = command[index + 2] === "-"
        const opLength = stripTabs ? 3 : 2
        push(command.slice(index, index + opLength), "operator")
        push(heredoc[0].slice(opLength), "heredoc")
        pendingHeredocs.push({ tag: heredoc[1] ?? heredoc[2] ?? heredoc[3]!, stripTabs })
        index += heredoc[0].length
        commandPosition = false
        continue
      }
    }
    const control = ["&&", "||", ";;"].find((op) => command.startsWith(op, index))
    if (control !== undefined) {
      push(control, "operator")
      index += control.length
      commandPosition = true
      continue
    }
    const redirect = shellRedirectPattern.exec(command.slice(index))
    if (redirect !== null) {
      push(redirect[0], "operator")
      index += redirect[0].length
      continue
    }
    if (current === "$" && command[index + 1] === "(") {
      push("$(", "operator")
      index += 2
      commandPosition = true
      continue
    }
    if (current === "|" || current === ";" || current === "&" || current === "(" || current === "`") {
      push(current, "operator")
      index += 1
      commandPosition = true
      continue
    }
    if (current === ")") {
      push(current, "operator")
      index += 1
      continue
    }
    const word = scanShellWord(command, index)
    if (word.length === 0) {
      push(current, "plain")
      index += 1
      continue
    }
    index += word.length
    if (commandPosition) {
      const assignment = shellAssignmentPattern.exec(word)
      if (assignment !== null) {
        push(assignment[1]!, "assignment")
        push(assignment[2]!, "plain")
        continue
      }
    }
    if (word.startsWith("-")) {
      const split = word.indexOf("=")
      if (split === -1) push(word, "flag")
      else {
        push(word.slice(0, split + 1), "flag")
        push(word.slice(split + 1), "plain")
      }
      commandPosition = false
      continue
    }
    if (commandPosition) {
      push(word, "command")
      commandPosition = false
      continue
    }
    push(word, "plain")
  }
  return runs
}

const shellRunChunk = (kind: ShellKind, piece: string): TerminalTextChunk => {
  switch (kind) {
    case "command":
      return bold(fg(colors.text)(piece))
    case "flag":
    case "assignment":
      return fg(colors.amber)(piece)
    case "string":
      return fg(colors.green)(piece)
    case "operator":
    case "continuation":
      return dim(fg(colors.text)(piece))
    case "comment":
    case "heredoc":
      return fg(colors.muted)(piece)
    case "plain":
      return fg(colors.text)(piece)
  }
}

const shellCommandCache = new Map<string, ReadonlyArray<ReadonlyArray<TerminalTextChunk>>>()

export const highlightShellCommand = (command: string): ReadonlyArray<ReadonlyArray<TerminalTextChunk>> => {
  const cached = shellCommandCache.get(command)
  if (cached !== undefined) return cached
  const lines: Array<Array<TerminalTextChunk>> = [[]]
  for (const run of scanShellCommand(command)) {
    run.text.split("\n").forEach((piece, pieceIndex) => {
      if (pieceIndex > 0) lines.push([])
      if (piece.length === 0) return
      lines[lines.length - 1]!.push(shellRunChunk(run.kind, piece))
    })
  }
  if (shellCommandCache.size >= highlightCacheLimit) shellCommandCache.delete(shellCommandCache.keys().next().value!)
  shellCommandCache.set(command, lines)
  return lines
}
