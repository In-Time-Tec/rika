import * as ViewState from "./view-state"

export interface RenderOptions {
  readonly width?: number
  readonly height?: number
}

const reset = "\u001b[0m"
const bold = (text: string) => `\u001b[1m${text}${reset}`
const dim = (text: string) => `\u001b[2m${text}${reset}`
const cyan = (text: string) => `\u001b[36m${text}${reset}`
const green = (text: string) => `\u001b[32m${text}${reset}`
const red = (text: string) => `\u001b[31m${text}${reset}`
const yellow = (text: string) => `\u001b[33m${text}${reset}`

export const render = (state: ViewState.ViewState, options: RenderOptions = {}) => {
  const width = clamp(options.width ?? 100, 50, 160)
  const height = options.height ?? 40
  const lines: Array<string> = []

  lines.push(header(state, width), "")
  if (state.notice !== undefined) lines.push(noticeLine(state.notice), "")
  if (state.palette_open) lines.push(...paletteLines(), "")

  for (const message of state.messages) lines.push(...messageLines(message), "")
  for (const card of state.cards) lines.push(...cardLines(card), "")

  if (state.streaming_text.length > 0) {
    lines.push(`${spinner(state)} ${cyan("Streaming")}`, block(state.streaming_text), "")
  }

  if (state.messages.length === 0 && state.cards.length === 0 && state.streaming_text.length === 0) {
    lines.push(dim("Start a thread by typing a prompt. Open the command palette with /help."), "")
  }

  const reserved = 2
  const body = lines.slice(Math.max(0, lines.length - Math.max(1, height - reserved)))
  body.push(statusLine(state, width))
  return body.join("\n")
}

export const stripAnsi = (text: string) => {
  let output = ""
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 27 && text[index + 1] === "[") {
      index += 2
      while (index < text.length && text[index] !== "m") index += 1
      continue
    }
    output += text[index] ?? ""
  }
  return output
}

const header = (state: ViewState.ViewState, width: number) =>
  twoColumn(bold("Rika"), dim(`$${state.cost_usd.toFixed(4)} · ${state.mode}`), width)

const statusLine = (state: ViewState.ViewState, width: number) =>
  twoColumn(`${spinner(state)} ${activityText(state.activity)}`, state.workspace_path, width)

const twoColumn = (left: string, right: string, width: number) => {
  const gap = Math.max(1, width - visibleLength(left) - visibleLength(right))
  return `${left}${" ".repeat(gap)}${right}`
}

const messageLines = (message: ViewState.ThreadMessage) => {
  const title =
    message.role === "user" ? green("You") : message.role === "assistant" ? cyan("Rika") : yellow(message.role)
  return [`╭─ ${title}`, ...message.text.split("\n").map((line) => `│ ${line}`), "╰─"]
}

const cardLines = (card: ViewState.Card) => {
  const icon = cardIcon(card)
  const status = statusText(card.status)
  const first = `╭─ ${icon} ${card.title}${card.subtitle.length === 0 ? "" : ` · ${card.subtitle}`} · ${status}${
    card.collapsed ? " · collapsed" : ""
  }`
  if (card.collapsed || card.body === undefined || card.body.length === 0) return [first, "╰─"]
  return [first, ...card.body.split("\n").map((line) => `│ ${line}`), "╰─"]
}

const paletteLines = () => [
  "╭─ Command Palette",
  "│ /mode rush|smart|deep    switch agent mode",
  "│ /threads                 list active threads",
  "│ /search <query>          search local threads",
  "│ /new                     start a new durable thread",
  "│ /thread <id>             resume a durable thread",
  "│ /archive [id]            archive a thread",
  "│ /unarchive [id]          restore an archived thread",
  "│ /share [id]              show local thread export JSON",
  "│ /reference <id> [query]  show compact thread reference context",
  "│ /help                    show this palette",
  "│ /exit                    leave Rika",
  "╰─",
]

const noticeLine = (notice: string) => yellow(`◇ ${notice}`)

const block = (text: string) =>
  text
    .split("\n")
    .map((line) => `│ ${line}`)
    .join("\n")

const spinner = (state: ViewState.ViewState) =>
  state.active ? ViewState.spinnerFrames[state.spinner_index % ViewState.spinnerFrames.length] : "·"

const activityText = (activity: ViewState.Activity) => {
  switch (activity) {
    case "thinking":
      return "Thinking"
    case "streaming":
      return "Streaming"
    case "running-tools":
      return "Running Tools"
    case "failed":
      return "Failed"
    case "idle":
      return "Idle"
  }
  return "Idle"
}

const cardIcon = (card: ViewState.Card) => {
  if (card.kind === "tool") return "◆"
  if (card.kind === "diff") return "△"
  if (card.kind === "error") return "✕"
  if (card.kind === "context") return "◇"
  return "○"
}

const statusText = (status: ViewState.CardStatus) => {
  if (status === "success") return green("done")
  if (status === "error") return red("error")
  if (status === "running") return yellow("running")
  return dim("info")
}

const visibleLength = (text: string) => stripAnsi(text).length
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(Math.floor(value), min), max)
