import { Config } from "@rika/core"
import { Event, Ids, Message } from "@rika/schema"
import { Effect, Stream } from "effect"
import * as ViewState from "./view-state"

export interface LoadInput {
  readonly thread_id?: Ids.ThreadId
  readonly workspace_path: string
  readonly mode: Config.Mode
}

export interface LoadedThread {
  readonly thread_id: Ids.ThreadId
  readonly state: ViewState.ViewState
  readonly last_sequence?: number
}

export interface TurnRequest {
  readonly thread_id: Ids.ThreadId
  readonly workspace_path: string
  readonly content: string
  readonly content_parts?: ReadonlyArray<Message.ContentPart>
  readonly mode: Config.Mode
  readonly fast_mode?: boolean
}

export interface ThreadEventsRequest {
  readonly thread_id: Ids.ThreadId
  readonly after_sequence?: number
}

export interface CancelRequest {
  readonly thread_id: Ids.ThreadId
  readonly turn_id: Ids.TurnId
}

export interface PreviewInput {
  readonly thread_id: Ids.ThreadId
  readonly workspace_path: string
  readonly mode: Config.Mode
}

export interface ThreadPreview {
  readonly thread_id: Ids.ThreadId
  readonly state: ViewState.ViewState
}

export interface CommandContext {
  readonly state: ViewState.ViewState
  readonly thread_id: Ids.ThreadId
  readonly workspace_path: string
  readonly mode: Config.Mode
}

export interface CommandResult {
  readonly state: ViewState.ViewState
  readonly thread_id: Ids.ThreadId
  readonly last_sequence?: number
  readonly mode: Config.Mode
  readonly exit: boolean
}

export interface ThreadOption {
  readonly thread_id: Ids.ThreadId
  readonly label: string
  readonly title: string
  readonly preview: string
  readonly updated_label: string
  readonly archived: boolean
  readonly diff?: ViewState.ThreadDiffStats
}

export interface ThreadOptionInput {
  readonly thread_id: Ids.ThreadId
  readonly title_text?: string
  readonly latest_message_text?: string
  readonly updated_at?: number
  readonly archived?: boolean
  readonly diff?: ViewState.ThreadDiffStats
}

export const threadOption = (input: ThreadOptionInput): ThreadOption => {
  const fallback = readableText(input.latest_message_text ?? "")
  const title = truncateTitle(oneLine(input.title_text ?? fallback ?? "(no messages)"))
  const preview = fallback ?? input.title_text ?? "(no messages)"
  return {
    thread_id: input.thread_id,
    label: title,
    title,
    preview,
    updated_label: input.updated_at === undefined ? "" : ageLabel(input.updated_at),
    archived: input.archived ?? false,
    ...(input.diff === undefined || isEmptyDiff(input.diff) ? {} : { diff: input.diff }),
  }
}

export interface SessionBackend<E> {
  readonly loadInitial: (input: LoadInput) => Effect.Effect<LoadedThread, E>
  readonly streamTurn: (input: TurnRequest) => Stream.Stream<Event.Event, E>
  readonly submitTurn?: (input: TurnRequest) => Effect.Effect<void, E>
  readonly subscribeThreadEvents?: (input: ThreadEventsRequest) => Stream.Stream<Event.Event, E>
  readonly cancelTurn: (input: CancelRequest) => Effect.Effect<void, E>
  readonly runCommand: (context: CommandContext, command: string) => Effect.Effect<CommandResult, E>
  readonly listThreads: (input: { readonly workspace_path: string }) => Effect.Effect<ReadonlyArray<ThreadOption>, E>
  readonly loadThreadPreview: (input: PreviewInput) => Effect.Effect<ThreadPreview, E>
}

export const commandResult = (
  context: CommandContext,
  patch: {
    state?: ViewState.ViewState
    thread_id?: Ids.ThreadId
    last_sequence?: number
    mode?: Config.Mode
    exit?: boolean
  } = {},
): CommandResult => ({
  state: patch.state ?? context.state,
  thread_id: patch.thread_id ?? context.thread_id,
  ...(patch.last_sequence === undefined ? {} : { last_sequence: patch.last_sequence }),
  mode: patch.mode ?? context.mode,
  exit: patch.exit ?? false,
})

export const splitCommand = (command: string): readonly [string, string | undefined] => {
  const [name, ...rest] = command.trim().split(/\s+/)
  return [name ?? command, rest.length === 0 ? undefined : rest.join(" ")]
}

export const splitFirst = (value: string): readonly [string, string | undefined] => {
  const [first, ...rest] = value.split(/\s+/)
  return [first ?? value, rest.length === 0 ? undefined : rest.join(" ")]
}

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim()

const readableText = (value: string): string | undefined => {
  const text = value.replace(/\r\n?/g, "\n").trim()
  if (text.length === 0) return undefined
  if (isRawToolPayload(text)) return undefined
  return text
}

const isRawToolPayload = (text: string): boolean => {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false
  if (trimmed.includes('"tool_call"') || trimmed.includes('"tool_result"')) return true
  return false
}

const truncateTitle = (value: string): string => {
  if (value.length === 0) return "(no messages)"
  if (value.length <= 96) return value
  return `${value.slice(0, 93)}...`
}

const ageLabel = (updatedAt: number): string => {
  const elapsed = Math.max(0, Date.now() - updatedAt)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

const isEmptyDiff = (diff: ViewState.ThreadDiffStats): boolean =>
  diff.additions === 0 && diff.modifications === 0 && diff.deletions === 0
