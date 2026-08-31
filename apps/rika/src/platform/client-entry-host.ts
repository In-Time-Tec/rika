const valueFlags = new Set(["--mode", "-m", "--workspace", "--thread", "--log-level"])
const nonInteractiveFlags = new Set([
  "--execute",
  "-x",
  "--no-tui",
  "--stream-json",
  "--stream-json-input",
  "--stream-json-thinking",
  "--help",
  "-h",
  "--version",
  "-v",
  "--completions",
])
const nonInteractiveCommands = new Set([
  "run",
  "auth",
  "org",
  "project",
  "secret",
  "credential",
  "provider",
  "diagnostics",
  "update",
  "version",
])

export interface StartupPreview {
  readonly restore: () => void
}

export const isInteractiveInvocation = (arguments_: ReadonlyArray<string>): boolean => {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!
    if (argument === "--") return true
    if (argument.startsWith("--completions=")) return false
    if (nonInteractiveFlags.has(argument)) return false
    if (valueFlags.has(argument)) {
      index += 1
      continue
    }
    if (argument.startsWith("-")) continue
    if (argument === "thread") return arguments_[index + 1] === "continue"
    return !nonInteractiveCommands.has(argument)
  }
  return true
}

export const startupFrame = (dimensions: { readonly columns: number; readonly rows: number }): string => {
  const { columns, rows } = dimensions
  const title = "Welcome to Rika"
  const status = "Starting…"
  const titleColumn = Math.max(1, Math.floor((columns - title.length) / 2) + 1)
  const statusColumn = Math.max(1, Math.floor((columns - status.length) / 2) + 1)
  const titleRow = Math.max(1, Math.floor(rows / 2))
  return [
    "\u001b[?1049h",
    "\u001b[?2026h",
    "\u001b[?25l",
    "\u001b[2J",
    `\u001b[${titleRow};${titleColumn}H`,
    "\u001b[1;38;2;61;255;166m",
    title,
    "\u001b[0m",
    `\u001b[${Math.min(rows, titleRow + 2)};${statusColumn}H`,
    "\u001b[2;38;5;7m",
    status,
    "\u001b[0m",
    "\u001b[?2026l",
  ].join("")
}

export const openStartupPreview = (): StartupPreview | undefined => {
  const inherited = process.env.RIKA_STARTUP_PREVIEW === "native-v1"
  if (inherited) delete process.env.RIKA_STARTUP_PREVIEW
  if (!inherited && (!process.stdin.isTTY || !process.stdout.isTTY || !isInteractiveInvocation(process.argv.slice(2))))
    return undefined
  let restored = false
  if (!inherited)
    process.stdout.write(startupFrame({ columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }))
  const restore = () => {
    if (restored) return
    restored = true
    process.stdout.write("\u001b[?2026l\u001b[?25h\u001b[?1049l")
  }
  process.once("exit", restore)
  return { restore }
}
