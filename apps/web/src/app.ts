import { Event, Ids, Message as RikaMessage, Remote } from "@rika/schema"
import { Client } from "@rika/sdk"
import { ModelInfo } from "@rika/llm"
import * as Command from "foldkit/command"
import { m } from "foldkit/message"
import * as Subscription from "foldkit/subscription"
import { Effect, Option, Schema as S, Stream } from "effect"
import * as Tabs from "./components/ui/tabs-state"

export const Connection = S.Literals(["idle", "loading", "connected", "failed"])
export type Connection = typeof Connection.Type
export const OrbTab = S.Literals(["transcript", "files", "changes", "terminal"])
export type OrbTab = typeof OrbTab.Type

export const OrbTabItems: ReadonlyArray<Tabs.TabItem<OrbTab>> = [
  { value: "transcript", label: "Transcript" },
  { value: "files", label: "Files" },
  { value: "changes", label: "Changes" },
  { value: "terminal", label: "Terminal" },
]

export const OrbTabs = Tabs.create()

export const Model = S.Struct({
  api_base_url: S.String,
  connection: Connection,
  threads: S.Array(Remote.ThreadSummary),
  events: S.Array(Event.Event),
  last_sequence: S.Int,
  subscription_after_sequence: S.Int,
  draft: S.String,
  pending_turn: S.Boolean,
  selected_thread_id: S.optional(Ids.ThreadId),
  subscribed_thread_id: S.optional(Ids.ThreadId),
  selected_orb: S.optional(Remote.OrbSummary),
  selected_orb_tab: OrbTab,
  orb_tabs: Tabs.Model,
  confirm_kill_orb_id: S.optional(Ids.OrbId),
  backend: S.optional(Remote.BackendHealth),
  notice: S.optional(S.String),
  pending_submit: S.optional(S.String),
})
export type Model = typeof Model.Type

export interface RuntimeConfig {
  readonly api_base_url: string
  readonly thread_id?: Ids.ThreadId
}

export interface TranscriptRow {
  readonly id: string
  readonly sequence: number
  readonly kind: "message" | "event" | "tool" | "error"
  readonly title: string
  readonly body: string
}

export type ContextUsageTone = "normal" | "warning" | "danger"

export interface ContextUsage {
  readonly tokens: number
  readonly window: number
  readonly percent: number
  readonly tone: ContextUsageTone
}

export const LoadedBackendHealth = m("LoadedBackendHealth", { health: Remote.BackendHealth })
export const FailedBackendHealth = m("FailedBackendHealth", { message: S.String })
export const LoadedThreads = m("LoadedThreads", { threads: S.Array(Remote.ThreadSummary) })
export const FailedLoadThreads = m("FailedLoadThreads", { message: S.String })
export const ClickedThread = m("ClickedThread", { thread_id: Ids.ThreadId })
export const ClickedNewThread = m("ClickedNewThread")
export const CreatedThread = m("CreatedThread", { summary: Remote.ThreadSummary })
export const FailedCreateThread = m("FailedCreateThread", { message: S.String })
export const OpenedThread = m("OpenedThread", { record: Remote.ThreadRecord })
export const FailedOpenThread = m("FailedOpenThread", { message: S.String })
export const LoadedSelectedOrb = m("LoadedSelectedOrb", { orb: Remote.OrbSummary })
export const FailedLoadSelectedOrb = m("FailedLoadSelectedOrb", { message: S.String })
export const GotOrbTabsMessage = m("GotOrbTabsMessage", { message: Tabs.Message })
export const ClickedPauseOrb = m("ClickedPauseOrb")
export const ClickedResumeOrb = m("ClickedResumeOrb")
export const ClickedKillOrb = m("ClickedKillOrb")
export const CancelledKillOrb = m("CancelledKillOrb")
export const ConfirmedKillOrb = m("ConfirmedKillOrb")
export const UpdatedSelectedOrb = m("UpdatedSelectedOrb", { orb: Remote.OrbSummary })
export const FailedOrbAction = m("FailedOrbAction", { message: S.String })
export const ChangedDraft = m("ChangedDraft", { value: S.String })
export const SubmittedDraft = m("SubmittedDraft")
export const AcceptedTurn = m("AcceptedTurn", { response: Remote.StartTurnResponse })
export const FailedStartTurn = m("FailedStartTurn", { message: S.String })
export const ReceivedThreadEvent = m("ReceivedThreadEvent", { event: Event.Event })
export const ThreadSubscriptionFailed = m("ThreadSubscriptionFailed", { message: S.String })

export const AppMessage = S.Union([
  LoadedBackendHealth,
  FailedBackendHealth,
  LoadedThreads,
  FailedLoadThreads,
  ClickedThread,
  ClickedNewThread,
  CreatedThread,
  FailedCreateThread,
  OpenedThread,
  FailedOpenThread,
  LoadedSelectedOrb,
  FailedLoadSelectedOrb,
  GotOrbTabsMessage,
  ClickedPauseOrb,
  ClickedResumeOrb,
  ClickedKillOrb,
  CancelledKillOrb,
  ConfirmedKillOrb,
  UpdatedSelectedOrb,
  FailedOrbAction,
  ChangedDraft,
  SubmittedDraft,
  AcceptedTurn,
  FailedStartTurn,
  ReceivedThreadEvent,
  ThreadSubscriptionFailed,
]).pipe(S.toTaggedUnion("_tag"))
export type AppMessage = typeof AppMessage.Type

export type AppCommand = Command.Command<AppMessage>

export const LoadBackendHealth = Command.define(
  "LoadBackendHealth",
  { api_base_url: S.String },
  LoadedBackendHealth,
  FailedBackendHealth,
)(({ api_base_url }) =>
  sdk(api_base_url)
    .backendHealth()
    .pipe(
      Effect.map((health) => LoadedBackendHealth({ health })),
      Effect.catch((error) => Effect.succeed(FailedBackendHealth({ message: error.message }))),
    ),
)

export const LoadThreads = Command.define(
  "LoadThreads",
  { api_base_url: S.String },
  LoadedThreads,
  FailedLoadThreads,
)(({ api_base_url }) =>
  sdk(api_base_url)
    .listThreads({ include_archived: false })
    .pipe(
      Effect.map((threads) => LoadedThreads({ threads })),
      Effect.catch((error) => Effect.succeed(FailedLoadThreads({ message: error.message }))),
    ),
)

export const CreateThread = Command.define(
  "CreateThread",
  { api_base_url: S.String },
  CreatedThread,
  FailedCreateThread,
)(({ api_base_url }) =>
  sdk(api_base_url)
    .createThread()
    .pipe(
      Effect.map((summary) => CreatedThread({ summary })),
      Effect.catch((error) => Effect.succeed(FailedCreateThread({ message: error.message }))),
    ),
)

export const OpenThread = Command.define(
  "OpenThread",
  { api_base_url: S.String, thread_id: Ids.ThreadId },
  OpenedThread,
  FailedOpenThread,
)(({ api_base_url, thread_id }) =>
  sdk(api_base_url)
    .openThread(thread_id)
    .pipe(
      Effect.map((record) => OpenedThread({ record })),
      Effect.catch((error) => Effect.succeed(FailedOpenThread({ message: error.message }))),
    ),
)

export const LoadSelectedOrb = Command.define(
  "LoadSelectedOrb",
  { api_base_url: S.String, thread_id: Ids.ThreadId },
  LoadedSelectedOrb,
  FailedLoadSelectedOrb,
)(({ api_base_url, thread_id }) =>
  sdk(api_base_url)
    .getOrbByThread(thread_id)
    .pipe(
      Effect.map((orb) => LoadedSelectedOrb({ orb })),
      Effect.catch((error) => Effect.succeed(FailedLoadSelectedOrb({ message: error.message }))),
    ),
)

export const PauseSelectedOrb = Command.define(
  "PauseSelectedOrb",
  { api_base_url: S.String, orb_id: Ids.OrbId },
  UpdatedSelectedOrb,
  FailedOrbAction,
)(({ api_base_url, orb_id }) =>
  sdk(api_base_url)
    .pauseOrb(orb_id)
    .pipe(
      Effect.map((orb) => UpdatedSelectedOrb({ orb })),
      Effect.catch((error) => Effect.succeed(FailedOrbAction({ message: error.message }))),
    ),
)

export const ResumeSelectedOrb = Command.define(
  "ResumeSelectedOrb",
  { api_base_url: S.String, orb_id: Ids.OrbId },
  UpdatedSelectedOrb,
  FailedOrbAction,
)(({ api_base_url, orb_id }) =>
  sdk(api_base_url)
    .resumeOrb(orb_id)
    .pipe(
      Effect.map((orb) => UpdatedSelectedOrb({ orb })),
      Effect.catch((error) => Effect.succeed(FailedOrbAction({ message: error.message }))),
    ),
)

export const KillSelectedOrb = Command.define(
  "KillSelectedOrb",
  { api_base_url: S.String, orb_id: Ids.OrbId },
  UpdatedSelectedOrb,
  FailedOrbAction,
)(({ api_base_url, orb_id }) =>
  sdk(api_base_url)
    .killOrb(orb_id)
    .pipe(
      Effect.map((orb) => UpdatedSelectedOrb({ orb })),
      Effect.catch((error) => Effect.succeed(FailedOrbAction({ message: error.message }))),
    ),
)

export const StartTurn = Command.define(
  "StartTurn",
  { api_base_url: S.String, thread_id: Ids.ThreadId, content: S.String },
  AcceptedTurn,
  FailedStartTurn,
)(({ api_base_url, thread_id, content }) =>
  sdk(api_base_url)
    .startTurn({ thread_id, content })
    .pipe(
      Effect.map((response) => AcceptedTurn({ response })),
      Effect.catch((error) => Effect.succeed(FailedStartTurn({ message: error.message }))),
    ),
)

export const initialModel = (config: RuntimeConfig): Model => ({
  api_base_url: config.api_base_url,
  connection: "idle",
  threads: [],
  events: [],
  last_sequence: 0,
  subscription_after_sequence: 0,
  draft: "",
  pending_turn: false,
  ...initialOrbTabs(),
  ...(config.thread_id === undefined ? {} : { selected_thread_id: config.thread_id }),
})

export const init = (config: RuntimeConfig): readonly [Model, ReadonlyArray<AppCommand>] => {
  const model = initialModel(config)
  return [
    { ...model, connection: "loading" },
    [
      LoadBackendHealth({ api_base_url: config.api_base_url }),
      LoadThreads({ api_base_url: config.api_base_url }),
      ...(config.thread_id === undefined
        ? []
        : [OpenThread({ api_base_url: config.api_base_url, thread_id: config.thread_id })]),
    ],
  ]
}

export const update = (model: Model, message: AppMessage): readonly [Model, ReadonlyArray<AppCommand>] => {
  switch (message._tag) {
    case "LoadedBackendHealth":
      return [{ ...model, backend: message.health }, []]
    case "FailedBackendHealth":
      return [{ ...model, connection: "failed", notice: message.message }, []]
    case "LoadedThreads": {
      const threads = newestFirst(message.threads)
      const next = { ...model, threads }
      if (model.selected_thread_id !== undefined || threads[0] === undefined) return [next, []]
      return openThreadModel(next, threads[0].thread_id)
    }
    case "FailedLoadThreads":
      return [{ ...model, connection: "failed", notice: message.message }, []]
    case "ClickedThread":
      return openThreadModel(model, message.thread_id)
    case "ClickedNewThread":
      return [
        {
          ...model,
          selected_thread_id: undefined,
          subscribed_thread_id: undefined,
          selected_orb: undefined,
          ...initialOrbTabs(),
          confirm_kill_orb_id: undefined,
          events: [],
          last_sequence: 0,
          subscription_after_sequence: 0,
          connection: "loading",
          notice: undefined,
        },
        [CreateThread({ api_base_url: model.api_base_url })],
      ]
    case "CreatedThread":
      return createdThreadModel(model, message.summary)
    case "FailedCreateThread":
      return [
        { ...model, connection: "failed", pending_turn: false, pending_submit: undefined, notice: message.message },
        [],
      ]
    case "OpenedThread":
      return openedThreadModel(model, message.record)
    case "FailedOpenThread":
      return [{ ...model, connection: "failed", notice: message.message }, []]
    case "LoadedSelectedOrb":
      return selectedOrbLoadedModel(model, message.orb)
    case "FailedLoadSelectedOrb":
      return [{ ...model, notice: message.message }, []]
    case "GotOrbTabsMessage":
      return orbTabsModel(model, message.message)
    case "ClickedPauseOrb":
      return selectedOrbActionModel(model, "pause")
    case "ClickedResumeOrb":
      return selectedOrbActionModel(model, "resume")
    case "ClickedKillOrb":
      return model.selected_orb === undefined
        ? [model, []]
        : [{ ...model, confirm_kill_orb_id: model.selected_orb.orb_id, notice: undefined }, []]
    case "CancelledKillOrb":
      return [{ ...model, confirm_kill_orb_id: undefined }, []]
    case "ConfirmedKillOrb":
      return confirmedKillOrbModel(model)
    case "UpdatedSelectedOrb":
      return selectedOrbLoadedModel(model, message.orb)
    case "FailedOrbAction":
      return [{ ...model, confirm_kill_orb_id: undefined, notice: message.message }, []]
    case "ChangedDraft":
      return [{ ...model, draft: message.value }, []]
    case "SubmittedDraft":
      return submittedDraftModel(model)
    case "AcceptedTurn":
      return [model, []]
    case "FailedStartTurn":
      return [{ ...model, pending_turn: false, notice: message.message }, []]
    case "ReceivedThreadEvent":
      return receivedEventModel(model, message.event)
    case "ThreadSubscriptionFailed":
      return [{ ...model, connection: "failed", notice: message.message }, []]
  }
  return [model, []]
}

export const subscriptions = Subscription.make<Model, AppMessage>()((entry) => ({
  threadEvents: entry(
    {
      api_base_url: S.String,
      thread_id: S.optional(Ids.ThreadId),
      after_sequence: S.Int,
    },
    {
      modelToDependencies: (model) => ({
        api_base_url: model.api_base_url,
        ...(model.subscribed_thread_id === undefined ? {} : { thread_id: model.subscribed_thread_id }),
        after_sequence: model.subscription_after_sequence,
      }),
      dependenciesToStream: ({ api_base_url, thread_id, after_sequence }) =>
        thread_id === undefined
          ? Stream.empty
          : sdk(api_base_url)
              .subscribeThreadEvents({ thread_id, after_sequence })
              .pipe(
                Stream.map((event) => ReceivedThreadEvent({ event })),
                Stream.catch((error) => Stream.make(ThreadSubscriptionFailed({ message: error.message }))),
              ),
    },
  ),
}))

export const eventRows = (events: ReadonlyArray<Event.Event>): ReadonlyArray<TranscriptRow> =>
  events.map((event) => {
    switch (event.type) {
      case "message.added":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "message",
          title: roleLabel(event.data.message.role),
          body: RikaMessage.displayText(event.data.message),
        }
      case "model.stream.chunk":
        return { id: event.id, sequence: event.sequence, kind: "message", title: "Rika", body: event.data.text }
      case "model.reasoning.delta":
        return { id: event.id, sequence: event.sequence, kind: "event", title: "Reasoning", body: event.data.text }
      case "tool.call.requested":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "tool",
          title: `Tool: ${event.data.call.name}`,
          body: "Running",
        }
      case "tool.call.completed":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: event.data.result.status === "success" ? "tool" : "error",
          title: `Tool: ${event.data.result.name}`,
          body: event.data.result.status,
        }
      case "turn.started":
        return { id: event.id, sequence: event.sequence, kind: "event", title: "Turn started", body: event.turn_id }
      case "turn.completed":
        return { id: event.id, sequence: event.sequence, kind: "event", title: "Turn completed", body: event.turn_id }
      case "turn.failed":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "error",
          title: "Turn failed",
          body: event.data.error.message,
        }
      case "context.resolved":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "event",
          title: "Context resolved",
          body: `${event.data.entries.length} entries · ${event.data.total_chars} chars`,
        }
      case "context.compacted":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "event",
          title: "Context compacted",
          body: `${event.data.trigger} · tail starts at ${event.data.tail_start_sequence}`,
        }
      case "context.pruned":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "event",
          title: "Context pruned",
          body: `${event.data.tool_call_ids.length} tools · ${event.data.estimated_tokens_freed} tokens`,
        }
      case "skill.loaded":
        return { id: event.id, sequence: event.sequence, kind: "event", title: "Skill loaded", body: event.data.name }
      case "subagent.completed":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "event",
          title: `Subagent ${event.data.status}`,
          body: event.data.summary,
        }
      case "artifact.created":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "event",
          title: "Artifact created",
          body: event.data.artifact.title ?? event.data.artifact.kind,
        }
      case "thread.created":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "event",
          title: "Thread created",
          body: event.data.workspace_id,
        }
      case "thread.archived":
        return { id: event.id, sequence: event.sequence, kind: "event", title: "Thread archived", body: "Archived" }
      case "thread.unarchived":
        return { id: event.id, sequence: event.sequence, kind: "event", title: "Thread unarchived", body: "Unarchived" }
      case "tool.call.input.started":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "tool",
          title: `Tool input: ${event.data.name}`,
          body: "Started",
        }
      case "tool.call.input.delta":
        return { id: event.id, sequence: event.sequence, kind: "tool", title: "Tool input", body: event.data.text }
      case "tool.call.input.ended":
        return {
          id: event.id,
          sequence: event.sequence,
          kind: "tool",
          title: `Tool input: ${event.data.name}`,
          body: event.data.input_text,
        }
    }
    return unreachableEventRow(event)
  })

export const contextUsage = (model: Model): ContextUsage | undefined => {
  const latest = model.events.findLast(
    (event): event is Event.TurnCompleted =>
      event.type === "turn.completed" && event.data.usage?.input_tokens !== undefined,
  )
  const selected = model.threads.find((thread) => thread.thread_id === model.selected_thread_id)
  const tokens = latest?.data.usage?.input_tokens ?? selected?.context_tokens
  const window =
    latest?.data.model === undefined ? selected?.context_window : ModelInfo.modelInfo(latest.data.model).context_window
  if (tokens === undefined || window === undefined) return undefined
  const percent = Math.min(100, Math.max(0, Math.round((tokens / window) * 100)))
  return {
    tokens,
    window,
    percent,
    tone: percent >= 90 ? "danger" : percent >= 70 ? "warning" : "normal",
  }
}

const sdk = (apiBaseUrl: string) => Client.make(Client.fetchTransport({ base_url: apiBaseUrl }))

const openThreadModel = (model: Model, threadId: Ids.ThreadId): readonly [Model, ReadonlyArray<AppCommand>] => [
  {
    ...model,
    selected_thread_id: threadId,
    subscribed_thread_id: undefined,
    selected_orb: undefined,
    ...initialOrbTabs(),
    confirm_kill_orb_id: undefined,
    events: [],
    last_sequence: 0,
    subscription_after_sequence: 0,
    connection: "loading",
    notice: undefined,
  },
  [OpenThread({ api_base_url: model.api_base_url, thread_id: threadId })],
]

const createdThreadModel = (
  model: Model,
  summary: Remote.ThreadSummary,
): readonly [Model, ReadonlyArray<AppCommand>] => {
  const next = {
    ...model,
    threads: newestFirst([summary, ...model.threads.filter((thread) => thread.thread_id !== summary.thread_id)]),
    selected_thread_id: summary.thread_id,
    subscribed_thread_id: summary.thread_id,
    selected_orb: undefined,
    ...initialOrbTabs(),
    confirm_kill_orb_id: undefined,
    events: [],
    last_sequence: 0,
    subscription_after_sequence: 0,
    connection: "connected" as const,
    notice: undefined,
  }
  const content = model.pending_submit
  if (content === undefined || content.length === 0) return [{ ...next, pending_submit: undefined }, []]
  return [
    { ...next, pending_turn: true, pending_submit: undefined },
    [StartTurn({ api_base_url: model.api_base_url, thread_id: summary.thread_id, content })],
  ]
}

const openedThreadModel = (model: Model, record: Remote.ThreadRecord): readonly [Model, ReadonlyArray<AppCommand>] => {
  const lastSequence = lastEventSequence(record.events)
  const next = {
    ...model,
    selected_thread_id: record.summary.thread_id,
    subscribed_thread_id: record.summary.thread_id,
    selected_orb: undefined,
    ...initialOrbTabs(),
    confirm_kill_orb_id: undefined,
    threads: newestFirst([
      record.summary,
      ...model.threads.filter((thread) => thread.thread_id !== record.summary.thread_id),
    ]),
    events: record.events,
    last_sequence: lastSequence,
    subscription_after_sequence: lastSequence,
    connection: "connected" as const,
    notice: undefined,
  }
  return [
    next,
    record.summary.orb_status === undefined
      ? []
      : [LoadSelectedOrb({ api_base_url: model.api_base_url, thread_id: record.summary.thread_id })],
  ]
}

const submittedDraftModel = (model: Model): readonly [Model, ReadonlyArray<AppCommand>] => {
  const content = model.draft.trim()
  if (content.length === 0) return [model, []]
  if (model.selected_thread_id === undefined) {
    return [
      { ...model, draft: "", pending_turn: true, pending_submit: content, connection: "loading", notice: undefined },
      [CreateThread({ api_base_url: model.api_base_url })],
    ]
  }
  return [
    { ...model, draft: "", pending_turn: true, notice: undefined },
    [StartTurn({ api_base_url: model.api_base_url, thread_id: model.selected_thread_id, content })],
  ]
}

const orbTabsModel = (model: Model, message: Tabs.Message): readonly [Model, ReadonlyArray<AppCommand>] => {
  const [orb_tabs, commands, maybeOutMessage] = OrbTabs.update(model.orb_tabs, message)
  const selected_orb_tab = Option.match(maybeOutMessage, {
    onNone: () => model.selected_orb_tab,
    onSome: (outMessage) => (isOrbTab(outMessage.value) ? outMessage.value : model.selected_orb_tab),
  })
  return [
    { ...model, selected_orb_tab, orb_tabs },
    Command.mapMessages(commands, (childMessage) => GotOrbTabsMessage({ message: childMessage })),
  ]
}

const receivedEventModel = (model: Model, event: Event.Event): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.subscribed_thread_id === undefined || event.thread_id !== model.subscribed_thread_id) return [model, []]
  if (event.sequence <= model.last_sequence) return [model, []]
  return [
    {
      ...model,
      events: [...model.events, event],
      last_sequence: event.sequence,
      connection: "connected",
      pending_turn: event.type === "turn.completed" || event.type === "turn.failed" ? false : model.pending_turn,
    },
    [],
  ]
}

const selectedOrbLoadedModel = (model: Model, orb: Remote.OrbSummary): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.selected_thread_id !== orb.thread_id) return [model, []]
  return [
    {
      ...model,
      selected_orb: orb,
      confirm_kill_orb_id: undefined,
      threads: updateThreadOrbStatus(model.threads, orb),
      notice: undefined,
    },
    [],
  ]
}

const selectedOrbActionModel = (
  model: Model,
  action: "pause" | "resume",
): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.selected_orb === undefined) return [model, []]
  const input = { api_base_url: model.api_base_url, orb_id: model.selected_orb.orb_id }
  return [
    { ...model, confirm_kill_orb_id: undefined, notice: undefined },
    [action === "pause" ? PauseSelectedOrb(input) : ResumeSelectedOrb(input)],
  ]
}

const confirmedKillOrbModel = (model: Model): readonly [Model, ReadonlyArray<AppCommand>] => {
  if (model.selected_orb === undefined || model.confirm_kill_orb_id !== model.selected_orb.orb_id) return [model, []]
  return [
    { ...model, confirm_kill_orb_id: undefined, notice: undefined },
    [KillSelectedOrb({ api_base_url: model.api_base_url, orb_id: model.selected_orb.orb_id })],
  ]
}

const updateThreadOrbStatus = (
  threads: ReadonlyArray<Remote.ThreadSummary>,
  orb: Remote.OrbSummary,
): ReadonlyArray<Remote.ThreadSummary> =>
  threads.map((thread) => (thread.thread_id === orb.thread_id ? { ...thread, orb_status: orb.status } : thread))

const newestFirst = (threads: ReadonlyArray<Remote.ThreadSummary>): ReadonlyArray<Remote.ThreadSummary> =>
  threads.toSorted((left, right) => right.updated_at - left.updated_at)

const lastEventSequence = (events: ReadonlyArray<Event.Event>) => events.at(-1)?.sequence ?? 0

const initialOrbTabs = () => ({
  selected_orb_tab: "transcript" as const,
  orb_tabs: Tabs.init({ id: "orb-tabs" }),
})

const isOrbTab = (value: string): value is OrbTab =>
  value === "transcript" || value === "files" || value === "changes" || value === "terminal"

const unreachableEventRow = (_event: never): TranscriptRow => ({
  id: "unreachable",
  sequence: 0,
  kind: "event",
  title: "Unknown event",
  body: "",
})

const roleLabel = (role: RikaMessage.Role) => {
  if (role === "assistant") return "Rika"
  if (role === "user") return "User"
  if (role === "tool") return "Tool"
  return "System"
}
