import { TournamentService } from "@rika/agent"
import { Config } from "@rika/core"
import { Client } from "@rika/sdk"
import { Ids, type Remote } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import * as Adapter from "./adapter"
import * as Backend from "./backend"
import * as Controller from "./controller"
import * as Keymap from "./keymap"
import * as Ticker from "./ticker"
import * as ViewState from "./view-state"

export type RunInput = Controller.RunInput
export const RunInput = Controller.RunInput

export class RemoteSessionError extends Schema.TaggedErrorClass<RemoteSessionError>()("RemoteSessionError", {
  message: Schema.String,
  operation: Schema.String,
}) {}

export type RunError = RemoteSessionError | Client.SdkError | TournamentService.RunError

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
  workspaceId?: Ids.WorkspaceId,
  runTournament?: Backend.SessionBackend<RunError>["runTournament"],
  keymap?: Keymap.EffectiveKeymap,
  userId?: Ids.UserId,
): Interface => {
  const backend = makeBackend(client, runTournament)
  return Service.of({
    run: Effect.fn("Tui.RemoteSession.run")(function* (input: RunInput) {
      const defaultWorkspace = input.workspace_root ?? process.cwd()
      const workspaceInput =
        workspaceId === undefined || input.workspace_id !== undefined ? input : { ...input, workspace_id: workspaceId }
      const runInput =
        userId === undefined || workspaceInput.user_id !== undefined
          ? workspaceInput
          : { ...workspaceInput, user_id: userId }
      return yield* Controller.run(
        {
          backend,
          renderer,
          ticks,
          defaultMode: input.mode ?? "smart",
          defaultWorkspace,
          ...(keymap === undefined ? {} : { keymap }),
        },
        runInput,
      )
    }),
  })
}

export const run = Effect.fn("Tui.RemoteSession.run.call")(function* (input: RunInput) {
  const session = yield* Service
  return yield* session.run(input)
})

const makeBackend = (
  client: Client.Interface,
  runTournament?: Backend.SessionBackend<RunError>["runTournament"],
): Backend.SessionBackend<RunError> => ({
  ...(runTournament === undefined ? {} : { runTournament }),
  loadInitial: ({ thread_id, workspace_path, workspace_id, mode, user_id }) =>
    Effect.gen(function* () {
      if (thread_id !== undefined) {
        const record = yield* client
          .openThread(thread_id, user_id)
          .pipe(
            Effect.catchTag("SdkError", () =>
              client
                .createThread({ thread_id, workspace_id, ...(user_id === undefined ? {} : { user_id }) })
                .pipe(Effect.map((summary): Remote.ThreadRecord => ({ summary, events: [] }))),
            ),
          )
        const activeOrb =
          record.summary.orb_status === undefined
            ? undefined
            : yield* activeOrbByThread(client, record.summary.thread_id)
        return {
          thread_id,
          last_sequence: record.events.at(-1)?.sequence ?? 0,
          ...(activeOrb === undefined ? {} : { active_orb: activeOrb }),
          state: ViewState.beginConnecting(
            ViewState.initial({
              thread_id,
              workspace_path,
              mode,
              ...(user_id === undefined ? {} : { user_id }),
              events: record.events,
              ...(activeOrb === undefined ? {} : { active_orb: activeOrb }),
              ...(record.summary.context_tokens === undefined ? {} : { context_tokens: record.summary.context_tokens }),
              ...(record.summary.context_window === undefined ? {} : { context_window: record.summary.context_window }),
            }),
          ),
        }
      }
      const summary = yield* client.createThread({ workspace_id, ...(user_id === undefined ? {} : { user_id }) })
      return {
        thread_id: summary.thread_id,
        last_sequence: 0,
        state: ViewState.beginConnecting(
          ViewState.initial({
            thread_id: summary.thread_id,
            workspace_path,
            mode,
            events: [],
            ...(user_id === undefined ? {} : { user_id }),
          }),
        ),
      }
    }),
  streamTurn: ({ thread_id, workspace_id, user_id, content, content_parts, mode, fast_mode, tool_access }) =>
    Stream.unwrap(
      client
        .startTurn({
          thread_id,
          workspace_id,
          ...(user_id === undefined ? {} : { user_id }),
          content,
          ...(content_parts === undefined ? {} : { content_parts }),
          mode,
          ...(fast_mode === undefined ? {} : { fast_mode }),
          ...(tool_access === undefined ? {} : { tool_access }),
        })
        .pipe(Effect.as(Stream.empty)),
    ),
  submitTurn: ({ thread_id, workspace_id, user_id, content, content_parts, mode, fast_mode, tool_access }) =>
    client
      .startTurn({
        thread_id,
        workspace_id,
        ...(user_id === undefined ? {} : { user_id }),
        content,
        ...(content_parts === undefined ? {} : { content_parts }),
        mode,
        ...(fast_mode === undefined ? {} : { fast_mode }),
        ...(tool_access === undefined ? {} : { tool_access }),
      })
      .pipe(Effect.asVoid),
  subscribeThreadEvents: ({ thread_id, after_sequence, user_id, onPresence }) =>
    client.subscribeThreadEvents({
      thread_id,
      ...(after_sequence === undefined ? {} : { after_sequence }),
      ...(user_id === undefined ? {} : { user_id }),
      ...(onPresence === undefined ? {} : { onPresence }),
    }),
  setThreadPresence: (input) => client.setThreadPresence(input).pipe(Effect.asVoid),
  cancelTurn: ({ thread_id, turn_id }) => client.interruptTurn({ thread_id, turn_id }).pipe(Effect.asVoid),
  runCommand: (context, command) => handleCommand(client, context, command, runTournament),
  listProjects: () => client.listProjects().pipe(Effect.map((projects) => projects.map(projectOptionFromRecord))),
  createProject: (input) => client.createProject(input).pipe(Effect.map(projectOptionFromRecord)),
  createOrbThread: ({ project_id, mode }) =>
    Effect.gen(function* () {
      const summary = yield* client.createOrbThread({ project_id, mode })
      const activeOrb =
        summary.orb_status === undefined ? undefined : yield* activeOrbByThread(client, summary.thread_id)
      return {
        thread_id: summary.thread_id,
        workspace_id: summary.workspace_id,
        ...(activeOrb === undefined ? {} : { active_orb: activeOrb }),
      }
    }),
  listThreads: ({ workspace_id }) =>
    client.listThreads({ workspace_id }).pipe(Effect.map((summaries) => summaries.map(threadOptionFromSummary))),
  loadThreadPreview: ({ thread_id, workspace_path, mode }) =>
    client.previewThread(thread_id).pipe(
      Effect.map((record) => ({
        thread_id,
        state: ViewState.initial({
          thread_id,
          workspace_path,
          mode,
          events: record.events,
          ...(record.summary.context_tokens === undefined ? {} : { context_tokens: record.summary.context_tokens }),
          ...(record.summary.context_window === undefined ? {} : { context_window: record.summary.context_window }),
        }),
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
    ...(summary.orb_status === undefined ? {} : { orb_status: summary.orb_status }),
    diff: summary.diff,
  })

const projectOptionFromRecord = (
  project: Pick<Remote.ProjectSummary, "name" | "project_id" | "repo_origin">,
): Backend.ProjectOption => ({
  project_id: project.project_id,
  name: project.name,
  repo_origin: project.repo_origin,
})

const activeOrbByThread = (client: Client.Interface, threadId: Ids.ThreadId) =>
  client.getOrbByThread(threadId).pipe(Effect.map(activeOrbFromSummary))

const activeOrbFromSummary = (summary: Remote.OrbSummary): ViewState.ActiveOrb => ({
  orb_id: summary.orb_id,
  status: summary.status,
})

const handleCommand = (
  client: Client.Interface,
  context: Backend.CommandContext,
  command: string,
  runTournament: Backend.SessionBackend<RunError>["runTournament"] | undefined,
): Effect.Effect<Backend.CommandResult, RunError> =>
  Effect.gen(function* () {
    const { state, thread_id: threadId, workspace_path: workspacePath, workspace_id: workspaceId } = context
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
    if (name === "/welcome") {
      if (ViewState.modeLocked(state))
        return Backend.commandResult(context, {
          state: ViewState.withNotice(state, "Welcome is only available before a thread is active."),
        })
      return Backend.commandResult(context, {
        state: ViewState.initial({ thread_id: threadId, workspace_path: workspacePath, mode: context.mode }),
      })
    }
    if (name === "/credits")
      return Backend.commandResult(context, { state: ViewState.withNotice(state, "Rika is Amp-compatible software.") })
    if (name === "/version") return Backend.commandResult(context, { state: ViewState.withNotice(state, "Rika 0.0.0") })
    if (name === "/ast-grep")
      return Backend.commandResult(context, { state: ViewState.withNotice(state, "ast-grep outline status: ready") })
    if (name === "/mcp")
      return Backend.commandResult(context, {
        state: ViewState.withNotice(
          state,
          argument === "authenticate" ? "MCP authentication requested." : "No MCP servers connected.",
        ),
      })
    if (name === "/orb") return yield* orbCommand(client, context, argument)
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
    if (name === "/compact") {
      const event = yield* client.compactThread(threadId)
      return Backend.commandResult(context, {
        state: ViewState.withNotice(ViewState.applyEvent(state, event), "Compacted thread context."),
        last_sequence: event.sequence,
      })
    }
    if (name === "/tournament") {
      if (runTournament === undefined) {
        return Backend.commandResult(context, { state: ViewState.withNotice(state, "Tournament runner unavailable.") })
      }
      const input = parseTournamentArgument(argument)
      if (input === undefined) {
        return Backend.commandResult(context, {
          state: ViewState.withNotice(state, "Usage: /tournament [-n 2..4] <message>"),
        })
      }
      const result = yield* runTournament({
        thread_id: threadId,
        message: input.message,
        branch_count: input.branch_count,
      })
      const summary = formatTournament(result)
      return Backend.commandResult(context, {
        state: ViewState.withNotice(
          ViewState.withSystemCard(state, {
            title: "Tournament",
            subtitle: summary,
            id: `tournament:${result.winner_thread_id}`,
          }),
          `Tournament winner: ${result.winner_thread_id}`,
        ),
      })
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
      const visibilityCommand = parseThreadVisibilityCommand(argument)
      if (visibilityCommand?.kind === "usage")
        return Backend.commandResult(context, {
          state: ViewState.withNotice(state, threadVisibilityUsage),
        })
      if (visibilityCommand?.kind === "set") {
        const summary = yield* client.setThreadVisibility(threadId, visibilityCommand.visibility)
        return Backend.commandResult(context, {
          state: ViewState.withNotice(state, `Thread visibility: ${summary.visibility}`),
        })
      }
      const nextThreadId = Ids.ThreadId.make(argument)
      const record = yield* client.openThread(nextThreadId)
      const activeOrb =
        record.summary.orb_status === undefined ? undefined : yield* activeOrbByThread(client, nextThreadId)
      const next = ViewState.beginConnecting(
        ViewState.withThread(state, {
          thread_id: nextThreadId,
          events: record.events,
          ...(activeOrb === undefined ? {} : { active_orb: activeOrb }),
          ...(record.summary.context_tokens === undefined ? {} : { context_tokens: record.summary.context_tokens }),
          ...(record.summary.context_window === undefined ? {} : { context_window: record.summary.context_window }),
        }),
      )
      return Backend.commandResult(context, {
        state: next,
        thread_id: nextThreadId,
        last_sequence: record.events.at(-1)?.sequence ?? 0,
      })
    }
    if (name === "/fork") {
      const target = argument === undefined || argument.length === 0 ? threadId : Ids.ThreadId.make(argument)
      const summary = yield* client.forkThread(target)
      const record = yield* client.openThread(summary.thread_id)
      const next = ViewState.withNotice(
        ViewState.beginConnecting(
          ViewState.withThread(state, {
            thread_id: summary.thread_id,
            events: record.events,
            ...(record.summary.context_tokens === undefined ? {} : { context_tokens: record.summary.context_tokens }),
            ...(record.summary.context_window === undefined ? {} : { context_window: record.summary.context_window }),
          }),
        ),
        `Forked thread ${target} into ${summary.thread_id}`,
      )
      return Backend.commandResult(context, {
        state: next,
        thread_id: summary.thread_id,
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
              ...(record.summary.context_tokens === undefined ? {} : { context_tokens: record.summary.context_tokens }),
              ...(record.summary.context_window === undefined ? {} : { context_window: record.summary.context_window }),
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

const orbCommand = (
  client: Client.Interface,
  context: Backend.CommandContext,
  argument: string | undefined,
): Effect.Effect<Backend.CommandResult, RunError> =>
  Effect.gen(function* () {
    const activeOrb = context.state.active_orb
    if (activeOrb === undefined)
      return Backend.commandResult(context, {
        state: ViewState.withNotice(context.state, "No orb is attached to the active thread."),
      })
    if (argument !== "pause" && argument !== "resume" && argument !== "kill")
      return Backend.commandResult(context, {
        state: ViewState.withNotice(context.state, "Usage: /orb pause|resume|kill"),
      })
    const summary =
      argument === "pause"
        ? yield* client.pauseOrb(activeOrb.orb_id)
        : argument === "resume"
          ? yield* client.resumeOrb(activeOrb.orb_id)
          : yield* client.killOrb(activeOrb.orb_id)
    const next = ViewState.withActiveOrb(context.state, activeOrbFromSummary(summary))
    return Backend.commandResult(context, { state: ViewState.withNotice(next, `Orb ${pastTense(argument)}.`) })
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
  if (ViewState.modeLocked(context.state))
    return Backend.commandResult(context, {
      state: ViewState.withNotice(context.state, "Mode is locked once a thread is active."),
    })
  return Backend.commandResult(context, {
    state: ViewState.withMode(context.state, nextMode),
    mode: nextMode,
  })
}

const parseTournamentArgument = (
  argument: string | undefined,
): Omit<Backend.TournamentRequest, "thread_id"> | undefined => {
  const tokens = (argument ?? "").trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return undefined
  let branchCount = 3
  const message: Array<string> = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    if ((token === "-n" || token === "--branches") && tokens[index + 1] !== undefined) {
      branchCount = Number(tokens[index + 1])
      index += 1
      continue
    }
    message.push(token)
  }
  const text = message.join(" ").trim()
  return text.length === 0 || !Number.isInteger(branchCount) ? undefined : { message: text, branch_count: branchCount }
}

const formatTournament = (result: TournamentService.TournamentResult) =>
  [
    ...result.ranking.map((row) => `${row.rank}. ${row.thread_id} ${row.mode} ${row.median_score} ${row.strengths}`),
    `Winner: ${result.winner_thread_id}`,
  ].join("\n")

const parseMode = (value: string): Config.Mode | undefined => {
  const decoded = Schema.decodeUnknownOption(Config.Mode)(value)
  return Option.isSome(decoded) ? decoded.value : undefined
}

const threadVisibilityUsage = "Usage: /thread visibility <private|workspace|unlisted>"

type ThreadVisibilityCommand =
  | { readonly kind: "set"; readonly visibility: Remote.ThreadVisibility }
  | { readonly kind: "usage" }

const parseThreadVisibilityCommand = (argument: string): ThreadVisibilityCommand | undefined => {
  const [subcommand, value] = Backend.splitFirst(argument)
  if (subcommand !== "visibility") return undefined
  if (value === "private" || value === "workspace" || value === "unlisted") {
    return { kind: "set" as const, visibility: value }
  }
  return { kind: "usage" as const }
}

const nextModeAfter = (mode: Config.Mode): Config.Mode => {
  if (mode === "rush") return "smart"
  if (mode === "smart") return "deep1"
  if (mode === "deep1") return "deep2"
  if (mode === "deep2") return "deep3"
  return "rush"
}

const pastTense = (action: "pause" | "resume" | "kill") => {
  if (action === "pause") return "paused"
  if (action === "resume") return "resumed"
  return "killed"
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

const summaryLine = (summary: Remote.ThreadSummary) => {
  const orbStatus = summary.orb_status === undefined ? "" : ` [orb:${summary.orb_status}]`
  return `${summary.thread_id}${orbStatus}${summary.archived ? " [archived]" : ""}: ${summary.latest_message_text ?? "(no messages)"}`
}
