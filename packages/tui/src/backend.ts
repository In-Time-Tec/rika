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
}

export interface TurnRequest {
  readonly thread_id: Ids.ThreadId
  readonly workspace_path: string
  readonly content: string
  readonly content_parts?: ReadonlyArray<Message.ContentPart>
  readonly mode: Config.Mode
}

export interface CancelRequest {
  readonly thread_id: Ids.ThreadId
  readonly turn_id: Ids.TurnId
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
  readonly mode: Config.Mode
  readonly exit: boolean
}

export interface ThreadOption {
  readonly thread_id: Ids.ThreadId
  readonly label: string
}

export interface SessionBackend<E> {
  readonly loadInitial: (input: LoadInput) => Effect.Effect<LoadedThread, E>
  readonly streamTurn: (input: TurnRequest) => Stream.Stream<Event.Event, E>
  readonly cancelTurn: (input: CancelRequest) => Effect.Effect<void, E>
  readonly runCommand: (context: CommandContext, command: string) => Effect.Effect<CommandResult, E>
  readonly listThreads: (input: { readonly workspace_path: string }) => Effect.Effect<ReadonlyArray<ThreadOption>, E>
}

export const commandResult = (
  context: CommandContext,
  patch: { state?: ViewState.ViewState; thread_id?: Ids.ThreadId; mode?: Config.Mode; exit?: boolean } = {},
): CommandResult => ({
  state: patch.state ?? context.state,
  thread_id: patch.thread_id ?? context.thread_id,
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
