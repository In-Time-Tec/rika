import { AgentLoop, ReviewService, SkillRegistry, ThreadService } from "@rika/agent"
import { Config, IdGenerator } from "@rika/core"
import { Ids } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as Adapter from "./adapter"
import * as Backend from "./backend"
import * as Controller from "./controller"
import * as Ticker from "./ticker"
import * as ViewState from "./view-state"

export interface RunInput extends Controller.RunInput {}
export const RunInput = Controller.RunInput

export class SessionError extends Schema.TaggedErrorClass<SessionError>()("SessionError", {
  message: Schema.String,
  operation: Schema.String,
}) {}

export type RunError =
  | SessionError
  | AgentLoop.RunError
  | ReviewService.RunError
  | Config.ConfigError
  | SkillRegistry.SkillRegistryError
  | ThreadService.Error

export interface Interface {
  readonly run: (input: RunInput) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tui/Session") {}

interface Dependencies {
  readonly agentLoop: AgentLoop.Interface
  readonly idGenerator: IdGenerator.Interface
  readonly reviewService: ReviewService.Interface
  readonly skillRegistry: SkillRegistry.Interface
  readonly threadService: ThreadService.Interface
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const agentLoop = yield* AgentLoop.Service
    const idGenerator = yield* IdGenerator.Service
    const reviewService = yield* ReviewService.Service
    const skillRegistry = yield* SkillRegistry.Service
    const threadService = yield* ThreadService.Service
    const renderer = yield* Adapter.Service
    const ticker = yield* Ticker.Service
    const configValues = yield* config.get

    const dependencies: Dependencies = { agentLoop, idGenerator, reviewService, skillRegistry, threadService }
    const backend = makeBackend(dependencies)

    return Service.of({
      run: Effect.fn("Tui.Session.run")(function* (input: RunInput) {
        return yield* Controller.run(
          {
            backend,
            renderer,
            ticks: ticker.ticks,
            defaultMode: configValues.default_mode,
            defaultWorkspace: configValues.workspace_root,
          },
          input,
        )
      }),
    })
  }),
)

export const run = Effect.fn("Tui.Session.run.call")(function* (input: RunInput) {
  const session = yield* Service
  return yield* session.run(input)
})

const makeBackend = (dependencies: Dependencies): Backend.SessionBackend<RunError> => ({
  loadInitial: ({ thread_id, workspace_path, mode }) =>
    Effect.gen(function* () {
      const threadId = thread_id ?? Ids.ThreadId.make(yield* dependencies.idGenerator.next("thread"))
      const events = yield* readThreadEvents(dependencies, threadId).pipe(Effect.catch(() => Effect.succeed([])))
      return {
        thread_id: threadId,
        state: ViewState.beginConnecting(ViewState.initial({ thread_id: threadId, workspace_path, mode, events })),
        last_sequence: events.at(-1)?.sequence ?? 0,
      }
    }),
  streamTurn: ({ thread_id, workspace_path, content, content_parts, mode, fast_mode }) =>
    dependencies.agentLoop.streamTurn({
      thread_id,
      workspace_id: Ids.WorkspaceId.make(workspace_path),
      content,
      ...(content_parts === undefined ? {} : { content_parts }),
      mode,
      ...(fast_mode === undefined ? {} : { fast_mode }),
    }),
  cancelTurn: ({ thread_id, turn_id }) => dependencies.agentLoop.cancelTurn({ thread_id, turn_id }).pipe(Effect.asVoid),
  runCommand: (context, command) => handleCommand(dependencies, context, command),
  listThreads: () =>
    dependencies.threadService.list({}).pipe(Effect.map((summaries) => summaries.map(threadOptionFromSummary))),
  loadThreadPreview: ({ thread_id, workspace_path, mode }) =>
    dependencies.threadService.preview({ thread_id }).pipe(
      Effect.map((record) => ({
        thread_id,
        state: ViewState.initial({ thread_id, workspace_path, mode, events: record.events }),
      })),
    ),
})

const threadOptionFromSummary = (summary: ThreadService.ThreadRecord["summary"]): Backend.ThreadOption =>
  Backend.threadOption({
    thread_id: summary.thread_id,
    ...(summary.title_text === undefined ? {} : { title_text: summary.title_text }),
    ...(summary.latest_message_text === undefined ? {} : { latest_message_text: summary.latest_message_text }),
    updated_at: summary.updated_at,
    archived: summary.archived,
    diff: summary.diff,
  })

const readThreadEvents = (dependencies: Dependencies, threadId: Ids.ThreadId) =>
  dependencies.threadService.open({ thread_id: threadId }).pipe(Effect.map((record) => record.events))

const handleCommand = (
  dependencies: Dependencies,
  context: Backend.CommandContext,
  command: string,
): Effect.Effect<Backend.CommandResult, RunError> =>
  Effect.gen(function* () {
    const { state, thread_id: threadId } = context
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
        state: ViewState.initial({ thread_id: threadId, workspace_path: context.workspace_path, mode: context.mode }),
      })
    if (name === "/credits")
      return Backend.commandResult(context, { state: ViewState.withNotice(state, "Rika is Amp-compatible software.") })
    if (name === "/version") return Backend.commandResult(context, { state: ViewState.withNotice(state, "Rika 0.0.0") })
    if (name === "/ast-grep")
      return Backend.commandResult(context, { state: ViewState.withNotice(state, "ast-grep outline status: ready") })
    if (name === "/debug") {
      const target = Backend.debugTargetFor(context, argument)
      if (target === undefined) {
        return Backend.commandResult(context, {
          state: ViewState.withNotice(state, "Usage: /debug [all|thread [thread-id]]"),
        })
      }
      return Backend.commandResult(context, {
        state: ViewState.withNotice(state, Backend.debugNotice(target)),
        debug: target,
      })
    }
    if (name === "/mcp")
      return Backend.commandResult(context, {
        state: ViewState.withNotice(
          state,
          argument === "authenticate" ? "MCP authentication requested." : "No MCP servers connected.",
        ),
      })
    if (name === "/skills") {
      const skills = yield* dependencies.skillRegistry.list()
      return Backend.commandResult(context, { state: ViewState.withNotice(state, formatSkills(skills)) })
    }
    if (name === "/skill") {
      if (argument === undefined || argument.length === 0)
        return Backend.commandResult(context, { state: ViewState.withNotice(state, "Usage: /skill <name>") })
      const skill = yield* dependencies.skillRegistry.inspect(argument)
      return Backend.commandResult(context, { state: ViewState.withNotice(state, formatSkill(skill)) })
    }
    if (name === "/threads") {
      const summaries = yield* dependencies.threadService.list({})
      return Backend.commandResult(context, { state: ViewState.withNotice(state, formatSummaries(summaries)) })
    }
    if (name === "/search") {
      if (argument === undefined || argument.length === 0)
        return Backend.commandResult(context, { state: ViewState.withNotice(state, "Usage: /search <query>") })
      const results = yield* dependencies.threadService.search({ query: argument })
      return Backend.commandResult(context, { state: ViewState.withNotice(state, formatSearchResults(results)) })
    }
    if (name === "/new") {
      const summary = yield* dependencies.threadService.create({})
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
      const record = yield* dependencies.threadService.open({ thread_id: nextThreadId })
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
      return Backend.commandResult(context, {
        state: ViewState.withNotice(nextState, `${summary.archived ? "Archived" : "Unarchived"} ${target}`),
        ...(record === undefined ? {} : { last_sequence: record.events.at(-1)?.sequence ?? 0 }),
      })
    }
    if (name === "/share") {
      const target = argument === undefined || argument.length === 0 ? threadId : Ids.ThreadId.make(argument)
      const exported = yield* dependencies.threadService.share({ thread_id: target })
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
      const reference = yield* dependencies.threadService.reference({
        thread_id: Ids.ThreadId.make(target),
        ...(query === undefined ? {} : { query }),
      })
      return Backend.commandResult(context, { state: ViewState.withNotice(state, reference.rendered) })
    }
    if (name === "/review") {
      const reviewInput = parseReviewArgument(argument)
      if (reviewInput === undefined)
        return Backend.commandResult(context, {
          state: ViewState.withNotice(state, "Usage: /review [--staged] [--base <ref>] [paths...]"),
        })
      const result = yield* dependencies.reviewService.run(reviewInput)
      return Backend.commandResult(context, { state: ViewState.withNotice(state, formatReview(result.run)) })
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

const formatSkills = (skills: ReadonlyArray<SkillRegistry.SkillSummary>) => {
  if (skills.length === 0) return "No skills installed."
  return [`Installed skills (${skills.length})`, ...skills.map((skill) => `${skill.name}: ${skill.description}`)].join(
    "\n",
  )
}

const formatSkill = (skill: SkillRegistry.Skill) =>
  [
    `${skill.summary.name}: ${skill.summary.description}`,
    `Source: ${skill.summary.source}`,
    `File: ${skill.summary.skill_file}`,
    `Resources: ${skill.resources.length === 0 ? "none" : skill.resources.map((resource) => resource.relative_path).join(", ")}`,
    "",
    skill.instructions,
  ].join("\n")

const parseReviewArgument = (argument: string | undefined): ReviewService.ReviewInput | undefined => {
  const tokens = argument === undefined || argument.trim().length === 0 ? [] : argument.trim().split(/\s+/)
  let staged = false
  let baseRef: string | undefined
  const paths: Array<string> = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    if (token === "--staged") {
      staged = true
      continue
    }
    if (token === "--base") {
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith("--")) return undefined
      baseRef = value
      index += 1
      continue
    }
    if (token.startsWith("--")) return undefined
    paths.push(token)
  }

  return {
    staged,
    ...(baseRef === undefined ? {} : { base_ref: baseRef }),
    ...(paths.length === 0 ? {} : { paths }),
  }
}

const formatReview = (reviewRun: ReviewService.ReviewRun) =>
  [
    `Review ${reviewRun.status}: ${reviewRun.findings.length} findings across ${reviewRun.changed_files.length} files`,
    `Artifact: ${reviewRun.artifact_id}`,
    ...reviewRun.findings.map(
      (finding) =>
        `- ${finding.severity} ${finding.path}:${finding.range.start_line}-${finding.range.end_line} ${finding.title}`,
    ),
  ].join("\n")

const summaryLine = (summary: ThreadService.ThreadRecord["summary"]) =>
  `${summary.thread_id}${summary.archived ? " [archived]" : ""}: ${summary.latest_message_text ?? "(no messages)"}`
