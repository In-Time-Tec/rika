import { Config } from "@rika/core"
import { Common, Event, Ids, Message } from "@rika/schema"

export type Activity = "idle" | "thinking" | "streaming" | "running-tools" | "failed"
export type CardKind = "context" | "tool" | "diff" | "error" | "system"
export type CardStatus = "info" | "running" | "success" | "error"

export interface ThreadMessage {
  readonly id: string
  readonly role: Message.Role
  readonly text: string
}

export interface Card {
  readonly id: string
  readonly kind: CardKind
  readonly title: string
  readonly subtitle: string
  readonly status: CardStatus
  readonly collapsed: boolean
  readonly body?: string
}

export interface Input {
  readonly thread_id: Ids.ThreadId
  readonly workspace_path: string
  readonly mode: Config.Mode
  readonly events?: ReadonlyArray<Event.Event>
}

export interface ViewState {
  readonly thread_id: Ids.ThreadId
  readonly workspace_path: string
  readonly mode: Config.Mode
  readonly cost_usd: number
  readonly activity: Activity
  readonly active: boolean
  readonly spinner_index: number
  readonly messages: ReadonlyArray<ThreadMessage>
  readonly cards: ReadonlyArray<Card>
  readonly streaming_text: string
  readonly notice?: string
  readonly palette_open: boolean
}

export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

export const initial = (input: Input): ViewState => {
  const state: ViewState = {
    thread_id: input.thread_id,
    workspace_path: input.workspace_path,
    mode: input.mode,
    cost_usd: 0,
    activity: "idle",
    active: false,
    spinner_index: 0,
    messages: [],
    cards: [],
    streaming_text: "",
    palette_open: false,
  }
  return fromEvents({ ...input, events: input.events ?? [] }, state)
}

export const fromEvents = (input: Input, seed = initialSeed(input)): ViewState =>
  (input.events ?? []).reduce((state, event) => applyEvent(state, event), seed)

const initialSeed = (input: Input): ViewState => ({
  thread_id: input.thread_id,
  workspace_path: input.workspace_path,
  mode: input.mode,
  cost_usd: 0,
  activity: "idle",
  active: false,
  spinner_index: 0,
  messages: [],
  cards: [],
  streaming_text: "",
  palette_open: false,
})

export const applyEvent = (state: ViewState, event: Event.Event): ViewState => {
  switch (event.type) {
    case "thread.created":
      return withoutNotice({ ...state, thread_id: event.thread_id })
    case "turn.started":
      return tick(withoutNotice({ ...state, activity: "thinking", active: true, streaming_text: "" }))
    case "message.added":
      return applyMessage(state, event)
    case "context.resolved":
      return tick({ ...state, cards: [...state.cards, contextCard(event)], activity: "thinking", active: true })
    case "model.stream.chunk":
      return tick({
        ...state,
        activity: "streaming",
        active: true,
        streaming_text: `${state.streaming_text}${event.data.text}`,
      })
    case "tool.call.requested":
      return tick({
        ...state,
        activity: "running-tools",
        active: true,
        cards: upsertCard(state.cards, toolCard(event)),
      })
    case "tool.call.completed":
      return tick({ ...state, activity: "streaming", active: true, cards: applyToolResult(state.cards, event) })
    case "artifact.created":
      return { ...state, cards: [...state.cards, systemCard("Artifact created", event.data.artifact.kind, event.id)] }
    case "turn.completed":
      return { ...state, activity: "idle", active: false, streaming_text: "" }
    case "turn.failed":
      return {
        ...state,
        activity: "failed",
        active: false,
        streaming_text: "",
        cards: [...state.cards, errorCard(event)],
      }
    case "thread.archived":
      return {
        ...state,
        active: false,
        activity: "idle",
        cards: [...state.cards, systemCard("Thread archived", "", event.id)],
      }
  }
  return state
}

export const withMode = (state: ViewState, mode: Config.Mode): ViewState => ({ ...state, mode })

export const withThread = (
  state: ViewState,
  input: { readonly thread_id: Ids.ThreadId; readonly events: ReadonlyArray<Event.Event>; readonly notice?: string },
): ViewState => {
  const base = initialSeed({ thread_id: input.thread_id, workspace_path: state.workspace_path, mode: state.mode })
  const next = fromEvents(
    { thread_id: input.thread_id, workspace_path: state.workspace_path, mode: state.mode, events: input.events },
    base,
  )
  return input.notice === undefined ? next : withNotice(next, input.notice)
}

export const withNotice = (state: ViewState, notice: string): ViewState => ({ ...state, notice, palette_open: false })

export const withPalette = (state: ViewState): ViewState => ({
  ...state,
  palette_open: true,
  notice: "Command palette: /mode <rush|smart|deep>, /new, /thread <id>, /help, /exit",
})

const withoutNotice = (state: ViewState): ViewState => {
  const { notice: _notice, ...rest } = state
  return rest
}

const tick = (state: ViewState): ViewState => ({
  ...state,
  spinner_index: (state.spinner_index + 1) % spinnerFrames.length,
})

const applyMessage = (state: ViewState, event: Event.MessageAdded): ViewState => {
  const message = event.data.message
  const text = messageText(message)
  if (text.length === 0) return state
  return {
    ...state,
    streaming_text: message.role === "assistant" ? "" : state.streaming_text,
    messages: [
      ...state.messages,
      {
        id: message.id,
        role: message.role,
        text,
      },
    ],
  }
}

const contextCard = (event: Event.ContextResolved): Card => ({
  id: event.id,
  kind: "context",
  title: "Context resolved",
  subtitle: `${event.data.entries.length} entries · ${event.data.total_chars} chars`,
  status: "info",
  collapsed: true,
  body: event.data.entries
    .map((entry) => `${entry.kind}: ${entry.path ?? entry.thread_reference ?? entry.source}`)
    .join("\n"),
})

const toolCard = (event: Event.ToolCallRequested): Card => ({
  id: event.data.call.id,
  kind: "tool",
  title: event.data.call.name,
  subtitle: "running",
  status: "running",
  collapsed: true,
  body: jsonSummary(event.data.call.input),
})

const applyToolResult = (cards: ReadonlyArray<Card>, event: Event.ToolCallCompleted): ReadonlyArray<Card> => {
  const result = event.data.result
  const updated = upsertCard(cards, {
    id: result.id,
    kind: "tool",
    title: result.name,
    subtitle: result.status,
    status: result.status === "success" ? "success" : "error",
    collapsed: true,
    body: result.status === "success" ? jsonSummary(result.output) : (result.error?.message ?? "Tool failed"),
  })
  const diff = extractDiff(result.output)
  if (diff === undefined) return updated
  return [
    ...updated,
    {
      id: `${result.id}:diff`,
      kind: "diff",
      title: "File diff",
      subtitle: diff,
      status: result.status === "success" ? "success" : "error",
      collapsed: true,
      body: "PIERE diff metadata is available for expansion.",
    },
  ]
}

const errorCard = (event: Event.TurnFailed): Card => ({
  id: event.id,
  kind: "error",
  title: "Turn failed",
  subtitle: event.data.error.kind,
  status: "error",
  collapsed: false,
  body: event.data.error.message,
})

const systemCard = (title: string, subtitle: string, id: string): Card => ({
  id,
  kind: "system",
  title,
  subtitle,
  status: "info",
  collapsed: true,
})

const upsertCard = (cards: ReadonlyArray<Card>, card: Card): ReadonlyArray<Card> => {
  const index = cards.findIndex((existing) => existing.id === card.id)
  if (index < 0) return [...cards, card]
  return cards.map((existing, current) => (current === index ? card : existing))
}

const messageText = (message: Message.Message) =>
  message.content
    .filter((part): part is Message.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

const jsonSummary = (value: Common.JsonValue | undefined) => {
  if (value === undefined) return ""
  const text = JSON.stringify(value, undefined, 2)
  if (text.length <= 800) return text
  return `${text.slice(0, 800)}\n… truncated`
}

const extractDiff = (value: Common.JsonValue | undefined): string | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractDiff(item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!isJsonObject(value)) return undefined
  if (isPierreDiff(value)) return diffSubtitle(value)
  for (const child of Object.values(value)) {
    const found = extractDiff(child)
    if (found !== undefined) return found
  }
  return undefined
}

const isPierreDiff = (value: Record<string, Common.JsonValue>) =>
  value.kind === "diff" && value.renderer === "@pierre/diffs"

const diffSubtitle = (value: Record<string, Common.JsonValue>) => {
  const fileDiff = value.file_diff
  if (isJsonObject(fileDiff)) {
    const name = fileDiff.name
    if (typeof name === "string") return `${name} · collapsed`
  }
  return "collapsed"
}

const isJsonObject = (value: Common.JsonValue | undefined): value is Record<string, Common.JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
