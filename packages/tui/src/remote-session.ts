import { Config } from "@rika/core"
import { Client } from "@rika/sdk"
import { Ids, type Remote } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import * as Adapter from "./adapter"
import * as Backend from "./backend"
import * as Controller from "./controller"
import * as Ticker from "./ticker"
import * as ViewState from "./view-state"

export type RunInput = Controller.RunInput
export const RunInput = Controller.RunInput

export class RemoteSessionError extends Schema.TaggedErrorClass<RemoteSessionError>()("RemoteSessionError", {
  message: Schema.String,
  operation: Schema.String,
}) {}

export type RunError = RemoteSessionError | Client.SdkError

export interface Interface {
  readonly run: (input: RunInput) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tui/RemoteSession") {}

export const layerFromClient = (client: Client.Interface) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const renderer = yield* Adapter.Service
      const ticker = yield* Ticker.Service
      return make(client, renderer, ticker.ticks)
    }),
  )

export const make = (
  client: Client.Interface,
  renderer: Adapter.Adapter,
  ticks: Controller.Dependencies<RunError>["ticks"],
): Interface => {
  const backend = makeBackend(client)
  return Service.of({
    run: Effect.fn("Tui.RemoteSession.run")(function* (input: RunInput) {
      const defaultWorkspace = input.workspace_root ?? process.cwd()
      return yield* Controller.run(
        { backend, renderer, ticks, defaultMode: input.mode ?? "smart", defaultWorkspace },
        input,
      )
    }),
  })
}

export const run = Effect.fn("Tui.RemoteSession.run.call")(function* (input: RunInput) {
  const session = yield* Service
  return yield* session.run(input)
})

const makeBackend = (client: Client.Interface): Backend.SessionBackend<RunError> => ({
  loadInitial: ({ thread_id, workspace_path, mode }) =>
    Effect.gen(function* () {
      const workspaceId = Ids.WorkspaceId.make(workspace_path)
      if (thread_id !== undefined) {
        const record = yield* client
          .openThread(thread_id)
          .pipe(
            Effect.catchTag("SdkError", () =>
              client
                .createThread({ thread_id, workspace_id: workspaceId })
                .pipe(Effect.map((summary): Remote.ThreadRecord => ({ summary, events: [] }))),
            ),
          )
        return {
          thread_id,
          last_sequence: record.events.at(-1)?.sequence ?? 0,
          state: ViewState.beginConnecting(
            ViewState.initial({ thread_id, workspace_path, mode, events: record.events }),
          ),
        }
      }
      const summary = yield* client.createThread({ workspace_id: workspaceId })
      return {
        thread_id: summary.thread_id,
        last_sequence: 0,
        state: ViewState.beginConnecting(
          ViewState.initial({ thread_id: summary.thread_id, workspace_path, mode, events: [] }),
        ),
      }
    }),
  streamTurn: ({ thread_id, workspace_path, content, content_parts, mode, fast_mode }) =>
    Stream.unwrap(
      client
        .startTurn({
          thread_id,
          workspace_id: Ids.WorkspaceId.make(workspace_path),
          content,
          ...(content_parts === undefined ? {} : { content_parts }),
          mode,
          ...(fast_mode === undefined ? {} : { fast_mode }),
        })
        .pipe(Effect.as(Stream.empty)),
    ),
  submitTurn: ({ thread_id, workspace_path, content, content_parts, mode, fast_mode }) =>
    client
      .startTurn({
        thread_id,
        workspace_id: Ids.WorkspaceId.make(workspace_path),
        content,
        ...(content_parts === undefined ? {} : { content_parts }),
        mode,
        ...(fast_mode === undefined ? {} : { fast_mode }),
      })
      .pipe(Effect.asVoid),
  subscribeThreadEvents: ({ thread_id, after_sequence }) =>
    client.subscribeThreadEvents({ thread_id, ...(after_sequence === undefined ? {} : { after_sequence }) }),
  cancelTurn: ({ thread_id, turn_id }) => client.interruptTurn({ thread_id, turn_id }).pipe(Effect.asVoid),
  runCommand: (context, command) => handleCommand(client, context, command),
  listThreads: ({ workspace_path }) =>
    client
      .listThreads({ workspace_id: Ids.WorkspaceId.make(workspace_path) })
      .pipe(Effect.map((summaries) => summaries.map(threadOptionFromSummary))),
  loadThreadPreview: ({ thread_id, workspace_path, mode }) =>
    client.previewThread(thread_id).pipe(
      Effect.map((record) => ({
        thread_id,
        state: ViewState.initial({ thread_id, workspace_path, mode, events: record.events }),
      })),
      Effect.mapError(previewError),
    ),
})

const previewError = (error: Client.SdkError): RunError => {
  if (error.status !== undefined) return error
  return new RemoteSessionError({
    message: "Preview unavailable while reconnecting to the shared backend.",
    operation: "loadThreadPreview",
  })
}

const threadOptionFromSummary = (summary: Remote.ThreadSummary): Backend.ThreadOption =>
  Backend.threadOption({
    thread_id: summary.thread_id,
    ...(summary.title_text === undefined ? {} : { title_text: summary.title_text }),
    ...(summary.latest_message_text === undefined ? {} : { latest_message_text: summary.latest_message_text }),
    updated_at: summary.updated_at,
    archived: summary.archived,
    diff: summary.diff,
  })

const handleCommand = (
  client: Client.Interface,
  context: Backend.CommandContext,
  command: string,
): Effect.Effect<Backend.CommandResult, RunError> =>
  Effect.gen(function* () {
    const { state, thread_id: threadId, workspace_path: workspacePath } = context
    const workspaceId = Ids.WorkspaceId.make(workspacePath)
    const [name, argument] = Backend.splitCommand(command)
    if (name === "/exit" || name === "/quit")
      return Backend.commandResult(context, { state: ViewState.withNotice(state, "Goodbye."), exit: true })
    if (name === "/help" || name === "/palette")
      return Backend.commandResult(context, { state: ViewState.withPalette(state) })
    if (name === "/mode") return modeCommand(context, argument)
    if (name === "/fast") return fastCommand(context)
    if (name === "/relaunch")
      return Backend.commandResult(context, {
        state: ViewState.withNotice(state, "Relaunch requested. Start Rika again after this session exits."),
        exit: true,
      })
    if (name === "/welcome")
      return Backend.commandResult(context, {
        state: ViewState.initial({ thread_id: threadId, workspace_path: workspacePath, mode: context.mode }),
      })
    if (name === "/credits")
      return Backend.commandResult(context, { state: ViewState.withNotice(state, "Rika is Amp-compatible software.") })
    if (name === "/version") return Backend.commandResult(context, { state: ViewState.withNotice(state, "Rika 0.0.0") })
    if (name === "/ast-grep")
      return Backend.commandResult(context, { state: ViewState.withNotice(state, "ast-grep outline status: ready") })
    if (name === "/debug")
      return Backend.commandResult(context, {
        state: ViewState.withNotice(
          state,
          argument === "copy command" ? "Debug command copied." : "Debug page logs are empty.",
        ),
      })
    if (name === "/mcp")
      return Backend.commandResult(context, {
        state: ViewState.withNotice(
          state,
          argument === "authenticate" ? "MCP authentication requested." : "No MCP servers connected.",
        ),
      })
    if (name === "/skills" || name === "/skill")
      return Backend.commandResult(context, {
        state: ViewState.withNotice(state, "Skills are loaded by the shared backend during agent turns."),
      })
    if (name === "/review")
      return Backend.commandResult(context, {
        state: ViewState.withNotice(
          state,
          "Use `rika review` for review runs; interactive review will be backend-routed next.",
        ),
      })
    if (name === "/threads") {
      const summaries = yield* client.listThreads({ workspace_id: workspaceId })
      return Backend.commandResult(context, { state: ViewState.withNotice(state, formatSummaries(summaries)) })
    }
    if (name === "/search") {
      if (argument === undefined || argument.length === 0)
        return Backend.commandResult(context, { state: ViewState.withNotice(state, "Usage: /search <query>") })
      const results = yield* client.searchThreads({ query: argument, workspace_id: workspaceId })
      return Backend.commandResult(context, { state: ViewState.withNotice(state, formatSearchResults(results)) })
    }
    if (name === "/new") {
      const summary = yield* client.createThread({ workspace_id: workspaceId })
      const next = ViewState.withThread(state, {
        thread_id: summary.thread_id,
        events: [],
        notice: `Started new thread ${summary.thread_id}`,
      })
      return Backend.commandResult(context, { state: next, thread_id: summary.thread_id, last_sequence: 0 })
    }
    if (name === "/thread") {
      if (argument === undefined || argument.length === 0)
        return Backend.commandResult(context, { state: ViewState.withNotice(state, "Usage: /thread <thread-id>") })
      const nextThreadId = Ids.ThreadId.make(argument)
      const record = yield* client.openThread(nextThreadId)
      const next = ViewState.beginConnecting(
        ViewState.withThread(state, {
          thread_id: nextThreadId,
          events: record.events,
        }),
      )
      return Backend.commandResult(context, {
        state: next,
        thread_id: nextThreadId,
        last_sequence: record.events.at(-1)?.sequence ?? 0,
      })
    }
    if (name === "/archive" || name === "/unarchive") {
      const target = argument === undefined || argument.length === 0 ? threadId : Ids.ThreadId.make(argument)
      const summary = name === "/archive" ? yield* client.archiveThread(target) : yield* client.unarchiveThread(target)
      const record = target === threadId ? yield* client.openThread(target) : undefined
      const nextState =
        record === undefined
          ? state
          : ViewState.withThread(state, {
              thread_id: target,
              events: record.events,
              notice: `${name.slice(1)}d ${target}`,
            })
      return Backend.commandResult(context, {
        state: ViewState.withNotice(nextState, `${summary.archived ? "Archived" : "Unarchived"} ${target}`),
        ...(record === undefined ? {} : { last_sequence: record.events.at(-1)?.sequence ?? 0 }),
      })
    }
    if (name === "/share") {
      const target = argument === undefined || argument.length === 0 ? threadId : Ids.ThreadId.make(argument)
      const exported = yield* client.shareThread(target)
      return Backend.commandResult(context, {
        state: ViewState.withNotice(state, `Thread export JSON:\n${JSON.stringify(exported, null, 2)}`),
      })
    }
    if (name === "/reference") {
      if (argument === undefined || argument.length === 0)
        return Backend.commandResult(context, {
          state: ViewState.withNotice(state, "Usage: /reference <thread-id> [query]"),
        })
      const [target, query] = Backend.splitFirst(argument)
      const reference = yield* client.referenceThread({
        thread_id: Ids.ThreadId.make(target),
        ...(query === undefined ? {} : { query }),
      })
      return Backend.commandResult(context, { state: ViewState.withNotice(state, reference.rendered) })
    }
    return Backend.commandResult(context, {
      state: ViewState.withNotice(state, `Unknown command ${name}. Type /help.`),
    })
  })

const fastCommand = (context: Backend.CommandContext): Backend.CommandResult => {
  if (!ViewState.isFastEligible(context.mode))
    return Backend.commandResult(context, {
      state: ViewState.withNotice(context.state, "Fast speed is only available in rush and deep modes."),
    })
  const next = ViewState.toggleFastMode(context.state)
  return Backend.commandResult(context, {
    state: ViewState.withNotice(next, next.fast_mode ? "Fast speed on ↯ (priority processing)" : "Standard speed"),
  })
}

const modeCommand = (context: Backend.CommandContext, argument: string | undefined): Backend.CommandResult => {
  const nextMode = argument === undefined || argument.length === 0 ? nextModeAfter(context.mode) : parseMode(argument)
  if (nextMode === undefined)
    return Backend.commandResult(context, {
      state: ViewState.withNotice(context.state, "Usage: /mode rush|smart|deep1|deep2|deep3"),
    })
  return Backend.commandResult(context, {
    state: ViewState.withMode(context.state, nextMode),
    mode: nextMode,
  })
}

const parseMode = (value: string): Config.Mode | undefined => {
  const decoded = Schema.decodeUnknownOption(Config.Mode)(value)
  return Option.isSome(decoded) ? decoded.value : undefined
}

const nextModeAfter = (mode: Config.Mode): Config.Mode => {
  if (mode === "rush") return "smart"
  if (mode === "smart") return "deep1"
  if (mode === "deep1") return "deep2"
  if (mode === "deep2") return "deep3"
  return "rush"
}

const formatSummaries = (summaries: ReadonlyArray<Remote.ThreadSummary>) => {
  if (summaries.length === 0) return "No active threads."
  return [`Active threads (${summaries.length})`, ...summaries.map(summaryLine)].join("\n")
}

const formatSearchResults = (results: ReadonlyArray<Remote.ThreadSearchResult>) => {
  if (results.length === 0) return "No matching threads."
  return [
    `Thread search results (${results.length})`,
    ...results.map((result) => `${summaryLine(result.summary)} · score ${result.score}`),
  ].join("\n")
}

const summaryLine = (summary: Remote.ThreadSummary) =>
  `${summary.thread_id}${summary.archived ? " [archived]" : ""}: ${summary.latest_message_text ?? "(no messages)"}`
