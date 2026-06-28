import { AgentLoop, ThreadService } from "@rika/agent"
import { Config, IdGenerator } from "@rika/core"
import { Ids } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import * as Renderer from "./renderer"
import * as Terminal from "./terminal"
import * as ViewState from "./view-state"

export interface RunInput extends Schema.Schema.Type<typeof RunInput> {}
export const RunInput = Schema.Struct({
  mode: Schema.optional(Config.Mode),
  workspace_root: Schema.optional(Schema.String),
  thread_id: Schema.optional(Ids.ThreadId),
}).annotate({ identifier: "Rika.Tui.Session.RunInput" })

export class SessionError extends Schema.TaggedErrorClass<SessionError>()("SessionError", {
  message: Schema.String,
  operation: Schema.String,
}) {}

export type RunError =
  | SessionError
  | AgentLoop.RunError
  | Config.ConfigError
  | Terminal.TerminalError
  | ThreadService.Error

export interface Interface {
  readonly run: (input: RunInput) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tui/Session") {}

interface Dependencies {
  readonly agentLoop: AgentLoop.Interface
  readonly config: Config.Interface
  readonly idGenerator: IdGenerator.Interface
  readonly terminal: Terminal.Interface
  readonly threadService: ThreadService.Interface
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agentLoop = yield* AgentLoop.Service
    const config = yield* Config.Service
    const idGenerator = yield* IdGenerator.Service
    const terminal = yield* Terminal.Service
    const threadService = yield* ThreadService.Service
    const dependencies: Dependencies = { agentLoop, config, idGenerator, terminal, threadService }

    return Service.of({
      run: Effect.fn("Tui.Session.run")(function* (input: RunInput) {
        return yield* runSession(dependencies, input)
      }),
    })
  }),
)

export const run = Effect.fn("Tui.Session.run.call")(function* (input: RunInput) {
  const session = yield* Service
  return yield* session.run(input)
})

const runSession = (dependencies: Dependencies, input: RunInput): Effect.Effect<number, RunError> =>
  Effect.gen(function* () {
    const config = yield* dependencies.config.get
    const workspacePath = input.workspace_root ?? config.workspace_root
    let mode = input.mode ?? config.default_mode
    let threadId = input.thread_id ?? Ids.ThreadId.make(yield* dependencies.idGenerator.next("thread"))
    let state = yield* loadThreadState(dependencies, threadId, workspacePath, mode)
    state = ViewState.withNotice(state, "Welcome to Rika. Type /help for the command palette.")
    yield* render(dependencies, state)

    while (true) {
      const line = yield* dependencies.terminal.readLine({ prompt: "› " })
      if (line === undefined) return 0
      const trimmed = line.trim()
      if (trimmed.length === 0) continue

      if (trimmed.startsWith("/")) {
        const command = yield* handleCommand(dependencies, state, threadId, mode, trimmed)
        state = command.state
        threadId = command.thread_id
        mode = command.mode
        yield* render(dependencies, state)
        if (command.exit) return 0
        continue
      }

      yield* dependencies.agentLoop
        .streamTurn({
          thread_id: threadId,
          workspace_id: Ids.WorkspaceId.make(workspacePath),
          content: line,
          mode,
        })
        .pipe(
          Stream.runForEach((event) => {
            state = ViewState.applyEvent(state, event)
            return render(dependencies, state)
          }),
        )
    }
  })

interface CommandResult {
  readonly state: ViewState.ViewState
  readonly thread_id: Ids.ThreadId
  readonly mode: Config.Mode
  readonly exit: boolean
}

const handleCommand = (
  dependencies: Dependencies,
  state: ViewState.ViewState,
  threadId: Ids.ThreadId,
  mode: Config.Mode,
  command: string,
): Effect.Effect<CommandResult, RunError> =>
  Effect.gen(function* () {
    const [name, argument] = splitCommand(command)
    if (name === "/exit" || name === "/quit")
      return { state: ViewState.withNotice(state, "Goodbye."), thread_id: threadId, mode, exit: true }
    if (name === "/help" || name === "/palette")
      return { state: ViewState.withPalette(state), thread_id: threadId, mode, exit: false }
    if (name === "/mode") return modeCommand(state, threadId, mode, argument)
    if (name === "/threads") {
      const summaries = yield* dependencies.threadService.list({})
      return { state: ViewState.withNotice(state, formatSummaries(summaries)), thread_id: threadId, mode, exit: false }
    }
    if (name === "/search") {
      if (argument === undefined || argument.length === 0) {
        return { state: ViewState.withNotice(state, "Usage: /search <query>"), thread_id: threadId, mode, exit: false }
      }
      const results = yield* dependencies.threadService.search({ query: argument })
      return {
        state: ViewState.withNotice(state, formatSearchResults(results)),
        thread_id: threadId,
        mode,
        exit: false,
      }
    }
    if (name === "/new") {
      const summary = yield* dependencies.threadService.create({})
      const nextThreadId = summary.thread_id
      const next = ViewState.withThread(state, {
        thread_id: nextThreadId,
        events: [],
        notice: `Started new thread ${nextThreadId}`,
      })
      return { state: next, thread_id: nextThreadId, mode, exit: false }
    }
    if (name === "/thread") {
      if (argument === undefined || argument.length === 0) {
        return {
          state: ViewState.withNotice(state, "Usage: /thread <thread-id>"),
          thread_id: threadId,
          mode,
          exit: false,
        }
      }
      const nextThreadId = Ids.ThreadId.make(argument)
      const record = yield* dependencies.threadService.open({ thread_id: nextThreadId })
      const next = ViewState.withThread(state, {
        thread_id: nextThreadId,
        events: record.events,
        notice: `Resumed thread ${nextThreadId}`,
      })
      return { state: next, thread_id: nextThreadId, mode, exit: false }
    }
    if (name === "/archive" || name === "/unarchive") {
      const target = argument === undefined || argument.length === 0 ? threadId : Ids.ThreadId.make(argument)
      const summary =
        name === "/archive"
          ? yield* dependencies.threadService.archive({ thread_id: target })
          : yield* dependencies.threadService.unarchive({ thread_id: target })
      const record = target === threadId ? yield* dependencies.threadService.open({ thread_id: target }) : undefined
      const nextState =
        record === undefined
          ? state
          : ViewState.withThread(state, {
              thread_id: target,
              events: record.events,
              notice: `${name.slice(1)}d ${target}`,
            })
      return {
        state: ViewState.withNotice(nextState, `${summary.archived ? "Archived" : "Unarchived"} ${target}`),
        thread_id: threadId,
        mode,
        exit: false,
      }
    }
    if (name === "/share") {
      const target = argument === undefined || argument.length === 0 ? threadId : Ids.ThreadId.make(argument)
      const exported = yield* dependencies.threadService.share({ thread_id: target })
      return {
        state: ViewState.withNotice(state, `Thread export JSON:\n${JSON.stringify(exported, null, 2)}`),
        thread_id: threadId,
        mode,
        exit: false,
      }
    }
    if (name === "/reference") {
      if (argument === undefined || argument.length === 0) {
        return {
          state: ViewState.withNotice(state, "Usage: /reference <thread-id> [query]"),
          thread_id: threadId,
          mode,
          exit: false,
        }
      }
      const [target, query] = splitFirst(argument)
      const reference = yield* dependencies.threadService.reference({
        thread_id: Ids.ThreadId.make(target),
        ...(query === undefined ? {} : { query }),
      })
      return { state: ViewState.withNotice(state, reference.rendered), thread_id: threadId, mode, exit: false }
    }
    return {
      state: ViewState.withNotice(state, `Unknown command ${name}. Type /help.`),
      thread_id: threadId,
      mode,
      exit: false,
    }
  })

const modeCommand = (
  state: ViewState.ViewState,
  threadId: Ids.ThreadId,
  mode: Config.Mode,
  argument: string | undefined,
): CommandResult => {
  const nextMode = argument === undefined || argument.length === 0 ? nextModeAfter(mode) : parseMode(argument)
  if (nextMode === undefined) {
    return {
      state: ViewState.withNotice(state, "Usage: /mode rush|smart|deep"),
      thread_id: threadId,
      mode,
      exit: false,
    }
  }
  return {
    state: ViewState.withNotice(ViewState.withMode(state, nextMode), `Mode switched to ${nextMode}`),
    thread_id: threadId,
    mode: nextMode,
    exit: false,
  }
}

const parseMode = (value: string): Config.Mode | undefined => {
  const decoded = Schema.decodeUnknownOption(Config.Mode)(value)
  return Option.isSome(decoded) ? decoded.value : undefined
}

const nextModeAfter = (mode: Config.Mode): Config.Mode => {
  if (mode === "rush") return "smart"
  if (mode === "smart") return "deep"
  return "rush"
}

const loadThreadState = (
  dependencies: Dependencies,
  threadId: Ids.ThreadId,
  workspacePath: string,
  mode: Config.Mode,
): Effect.Effect<ViewState.ViewState, RunError> =>
  Effect.gen(function* () {
    const events = yield* readThreadEvents(dependencies, threadId).pipe(Effect.catch(() => Effect.succeed([])))
    return ViewState.initial({ thread_id: threadId, workspace_path: workspacePath, mode, events })
  })

const readThreadEvents = (dependencies: Dependencies, threadId: Ids.ThreadId) =>
  dependencies.threadService.open({ thread_id: threadId }).pipe(Effect.map((record) => record.events))

const render = (dependencies: Dependencies, state: ViewState.ViewState) =>
  dependencies.terminal.writeFrame(Renderer.render(state))

const splitCommand = (command: string): readonly [string, string | undefined] => {
  const [name, ...rest] = command.split(/\s+/)
  return [name ?? command, rest.length === 0 ? undefined : rest.join(" ")]
}

const splitFirst = (value: string): readonly [string, string | undefined] => {
  const [first, ...rest] = value.split(/\s+/)
  return [first ?? value, rest.length === 0 ? undefined : rest.join(" ")]
}

const formatSummaries = (summaries: ReadonlyArray<ThreadService.ThreadRecord["summary"]>) => {
  if (summaries.length === 0) return "No active threads."
  return [`Active threads (${summaries.length})`, ...summaries.map(summaryLine)].join("\n")
}

const formatSearchResults = (results: ReadonlyArray<ThreadService.SearchResult>) => {
  if (results.length === 0) return "No matching threads."
  return [
    `Thread search results (${results.length})`,
    ...results.map((result) => `${summaryLine(result.summary)} · score ${result.score}`),
  ].join("\n")
}

const summaryLine = (summary: ThreadService.ThreadRecord["summary"]) =>
  `${summary.thread_id}${summary.archived ? " [archived]" : ""}: ${summary.latest_message_text ?? "(no messages)"}`
