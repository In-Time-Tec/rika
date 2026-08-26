export interface Invocation {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly home: string | undefined
}

export interface Refusal {
  readonly message: string
  readonly nextAction: string
}

const shellExecutables = new Set(["sh", "bash", "zsh", "dash", "ksh"])
const scriptFlags = new Set(["-c", "-lc", "-cl", "-ic", "-lic"])

const basename = (value: string) => value.slice(value.lastIndexOf("/") + 1)

const normalize = (value: string, cwd: string) => {
  const absolute = value.startsWith("/") ? value : `${cwd}/${value}`
  const parts: Array<string> = []
  for (const part of absolute.split("/")) {
    if (part.length === 0 || part === ".") continue
    if (part === "..") {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `/${parts.join("/")}`
}

interface Lexed {
  readonly commands: ReadonlyArray<ReadonlyArray<string>>
  readonly unquoted: string
}

const lex = (script: string, home: string | undefined): Lexed | undefined => {
  const commands: Array<Array<string>> = []
  let command: Array<string> = []
  let token = ""
  let started = false
  let unquoted = ""
  const pushToken = () => {
    if (started) command.push(token)
    token = ""
    started = false
  }
  const pushCommand = () => {
    pushToken()
    if (command.length > 0) commands.push(command)
    command = []
  }
  let index = 0
  while (index < script.length) {
    const character = script[index]!
    if (character === "\\") {
      if (index + 1 >= script.length) return undefined
      token += script[index + 1]!
      started = true
      index += 2
      continue
    }
    if (character === "'") {
      const end = script.indexOf("'", index + 1)
      if (end < 0) return undefined
      token += script.slice(index + 1, end)
      started = true
      index = end + 1
      continue
    }
    if (character === '"') {
      let cursor = index + 1
      let quoted = ""
      while (cursor < script.length && script[cursor] !== '"') {
        if (script[cursor] === "\\") {
          if (cursor + 1 >= script.length) return undefined
          quoted += script[cursor + 1]!
          cursor += 2
          continue
        }
        if (script[cursor] === "`" || (script[cursor] === "$" && script[cursor + 1] === "(")) return undefined
        quoted += script[cursor]!
        cursor += 1
      }
      if (cursor >= script.length) return undefined
      token += expandVariables(quoted, home)
      started = true
      index = cursor + 1
      continue
    }
    if (character === "`" || (character === "$" && script[index + 1] === "(")) return undefined
    if (character === "<" && script[index + 1] === "<") return undefined
    if (character === "#" && !started) {
      const end = script.indexOf("\n", index)
      if (end < 0) break
      index = end
      continue
    }
    if (character === " " || character === "\t") {
      unquoted += character
      pushToken()
      index += 1
      continue
    }
    if (character === "\n" || character === ";" || character === "&" || character === "|") {
      unquoted += character
      pushCommand()
      index += 1
      continue
    }
    if (character === "(" || character === ")") {
      unquoted += character
      pushCommand()
      index += 1
      continue
    }
    let word = ""
    while (index < script.length && !" \t\n;&|()'\"`\\".includes(script[index]!)) {
      word += script[index]!
      index += 1
    }
    unquoted += word
    token += expand(word, home)
    started = true
  }
  pushCommand()
  return { commands, unquoted }
}

const expandVariables = (value: string, home: string | undefined) =>
  home === undefined || home.length === 0 ? value : value.replaceAll("${HOME}", home).replaceAll("$HOME", home)

const expand = (value: string, home: string | undefined) => {
  if (home === undefined || home.length === 0) return value
  const withHome = expandVariables(value, home)
  if (withHome === "~") return home
  return withHome.startsWith("~/") ? `${home}${withHome.slice(1)}` : withHome
}

const deletionRoots = (words: ReadonlyArray<string>) => {
  let recursive = false
  let operandsOnly = false
  const operands: Array<string> = []
  for (const word of words.slice(1)) {
    if (operandsOnly) {
      operands.push(word)
      continue
    }
    if (word === "--") {
      operandsOnly = true
      continue
    }
    if (word.startsWith("--")) {
      if (word === "--recursive") recursive = true
      continue
    }
    if (word.startsWith("-") && word.length > 1) {
      if (word.includes("r") || word.includes("R")) recursive = true
      continue
    }
    operands.push(word)
  }
  return recursive ? operands : []
}

const forkBomb = /:\s*\(\s*\)\s*\{?\s*:\s*\|\s*:?\s*&?\s*\}?\s*;\s*:/

export const checkProcessInvocation = (invocation: Invocation): Refusal | undefined => {
  const isShellScript =
    shellExecutables.has(basename(invocation.executable)) &&
    invocation.args.length >= 2 &&
    scriptFlags.has(invocation.args[0]!)
  const lexed = isShellScript
    ? lex(invocation.args[1]!, invocation.home)
    : { commands: [[invocation.executable, ...invocation.args]], unquoted: "" }
  if (lexed === undefined) return undefined
  if (forkBomb.test(lexed.unquoted))
    return {
      message: "Rika refuses to run a fork bomb",
      nextAction: "Run a command that does not exhaust process resources",
    }
  const home = invocation.home === undefined ? undefined : normalize(invocation.home, invocation.cwd)
  for (const words of lexed.commands) {
    const name = words[0]
    if (name === undefined || basename(name) !== "rm") continue
    for (const operand of deletionRoots(words)) {
      let bare = operand
      if (operand.endsWith("/*")) bare = operand.slice(0, -2)
      else if (operand === "*") bare = "."
      const target = normalize(bare.length === 0 ? "/" : bare, invocation.cwd)
      if (target === "/")
        return {
          message: "Rika refuses to recursively delete the filesystem root",
          nextAction: "Delete a specific directory instead of the filesystem root",
        }
      if (home !== undefined && target === home)
        return {
          message: "Rika refuses to recursively delete the home directory",
          nextAction: "Delete a specific directory instead of the home directory",
        }
    }
  }
  return undefined
}
