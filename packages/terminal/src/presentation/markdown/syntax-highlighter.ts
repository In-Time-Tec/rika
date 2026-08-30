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

const tokenRoles = new Map<string, Role>([
  ["keyword", "keyword"],
  ["boolean", "keyword"],
  ["important", "keyword"],
  ["string", "string"],
  ["char", "string"],
  ["template-string", "string"],
  ["attr-value", "string"],
  ["regex", "string"],
  ["inserted", "string"],
  ["number", "number"],
  ["comment", "comment"],
  ["prolog", "comment"],
  ["doctype", "comment"],
  ["cdata", "comment"],
  ["deleted", "comment"],
  ["function", "function"],
  ["class-name", "type"],
  ["builtin", "type"],
  ["type", "type"],
])
const tokenRole = (type: string): Role => tokenRoles.get(type) ?? "plain"

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

interface ShellScanState {
  index: number
  commandPosition: boolean
}

const scanShellSpecial = (
  command: string,
  state: ShellScanState,
  runs: Array<ShellRun>,
  pendingHeredocs: Array<{ readonly tag: string; readonly stripTabs: boolean }>,
): boolean => {
  const push = (text: string, kind: ShellKind) => {
    if (text.length > 0) runs.push({ text, kind })
  }
  const current = command[state.index]!
  const scanWhitespace = (): boolean => {
    if (current !== " " && current !== "\t") return false
    let stop = state.index
    while (stop < command.length && (command[stop] === " " || command[stop] === "\t")) stop += 1
    push(command.slice(state.index, stop), "plain")
    state.index = stop
    return true
  }
  const scanQuoted = (): boolean => {
    if (current !== "'" && current !== '"') return false
    const fromAssignment = runs[runs.length - 1]?.kind === "assignment"
    let stop = state.index + 1
    while (stop < command.length && command[stop] !== current) {
      if (current === '"' && command[stop] === "\\") stop += 1
      stop += 1
    }
    stop = Math.min(stop + 1, command.length)
    push(command.slice(state.index, stop), "string")
    state.index = stop
    if (!fromAssignment) state.commandPosition = false
    return true
  }
  const scanHeredoc = (): boolean => {
    if (!command.startsWith("<<", state.index) || command.startsWith("<<<", state.index)) return false
    const heredoc = shellHeredocPattern.exec(command.slice(state.index))
    if (heredoc === null) return false
    const stripTabs = command[state.index + 2] === "-"
    const opLength = stripTabs ? 3 : 2
    push(command.slice(state.index, state.index + opLength), "operator")
    push(heredoc[0].slice(opLength), "heredoc")
    pendingHeredocs.push({ tag: heredoc[1] ?? heredoc[2] ?? heredoc[3]!, stripTabs })
    state.index += heredoc[0].length
    state.commandPosition = false
    return true
  }
  if (scanWhitespace()) return true
  if (current === "\\" && command[state.index + 1] === "\n") {
    push("\\", "continuation")
    state.index += 1
    return true
  }
  if (current === "#") {
    const newline = command.indexOf("\n", state.index)
    const stop = newline === -1 ? command.length : newline
    push(command.slice(state.index, stop), "comment")
    state.index = stop
    return true
  }
  return scanQuoted() || scanHeredoc()
}

const scanShellOperator = (command: string, state: ShellScanState, runs: Array<ShellRun>): boolean => {
  const push = (text: string) => runs.push({ text, kind: "operator" })
  const current = command[state.index]!
  const control = ["&&", "||", ";;"].find((operator) => command.startsWith(operator, state.index))
  if (control !== undefined) {
    push(control)
    state.index += control.length
    state.commandPosition = true
    return true
  }
  const redirect = shellRedirectPattern.exec(command.slice(state.index))
  if (redirect !== null) {
    push(redirect[0])
    state.index += redirect[0].length
    return true
  }
  if (current === "$" && command[state.index + 1] === "(") {
    push("$(")
    state.index += 2
    state.commandPosition = true
    return true
  }
  if (current === "|" || current === ";" || current === "&" || current === "(" || current === "`") {
    push(current)
    state.index += 1
    state.commandPosition = true
    return true
  }
  if (current !== ")") return false
  push(current)
  state.index += 1
  return true
}

const scanShellCommandWord = (command: string, state: ShellScanState, runs: Array<ShellRun>): void => {
  const push = (text: string, kind: ShellKind) => {
    if (text.length > 0) runs.push({ text, kind })
  }
  const current = command[state.index]!
  const word = scanShellWord(command, state.index)
  if (word.length === 0) {
    push(current, "plain")
    state.index += 1
    return
  }
  state.index += word.length
  const assignment = state.commandPosition ? shellAssignmentPattern.exec(word) : null
  if (assignment !== null) {
    push(assignment[1]!, "assignment")
    push(assignment[2]!, "plain")
    return
  }
  if (word.startsWith("-")) {
    const split = word.indexOf("=")
    if (split === -1) push(word, "flag")
    else {
      push(word.slice(0, split + 1), "flag")
      push(word.slice(split + 1), "plain")
    }
    state.commandPosition = false
    return
  }
  push(word, state.commandPosition ? "command" : "plain")
  state.commandPosition = false
}

const scanShellCommand = (command: string): ReadonlyArray<ShellRun> => {
  const runs: Array<ShellRun> = []
  const push = (text: string, kind: ShellKind) => {
    if (text.length > 0) runs.push({ text, kind })
  }
  const pendingHeredocs: Array<{ readonly tag: string; readonly stripTabs: boolean }> = []
  const state: ShellScanState = { index: 0, commandPosition: true }
  const consumeHeredocBodies = () => {
    while (pendingHeredocs.length > 0 && state.index < command.length) {
      const heredoc = pendingHeredocs[0]!
      const newline = command.indexOf("\n", state.index)
      const stop = newline === -1 ? command.length : newline
      const lineText = command.slice(state.index, stop)
      push(lineText, "heredoc")
      state.index = stop
      if (newline !== -1) {
        push("\n", "plain")
        state.index = newline + 1
      }
      const terminator = heredoc.stripTabs ? lineText.replace(/^\t+/, "") : lineText
      if (terminator === heredoc.tag) pendingHeredocs.shift()
    }
  }
  while (state.index < command.length) {
    const current = command[state.index]!
    if (current === "\n") {
      push("\n", "plain")
      state.index += 1
      state.commandPosition = true
      consumeHeredocBodies()
      continue
    }
    if (scanShellSpecial(command, state, runs, pendingHeredocs)) continue
    if (scanShellOperator(command, state, runs)) continue
    scanShellCommandWord(command, state, runs)
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
