import { Config, Diagnostics, IdGenerator, StringArray, Time } from "@rika/core"
import { ModelInfo } from "@rika/llm"
import { Database, ProjectStore, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as ThreadDigest from "./thread-digest"
import * as ThreadSearchQuery from "./thread-search-query"

const defaultReferenceChars = 2_000
const defaultSearchLimit = 20
const defaultPreviewLimit = 160

export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Schema.Struct({
  thread_id: Schema.optional(Ids.ThreadId),
  workspace_id: Schema.optional(Ids.WorkspaceId),
  user_id: Schema.optional(Ids.UserId),
}).annotate({ identifier: "Rika.Agent.ThreadService.CreateInput" })

export interface ThreadIdInput extends Schema.Schema.Type<typeof ThreadIdInput> {}
export const ThreadIdInput = Schema.Struct({
  thread_id: Ids.ThreadId,
}).annotate({ identifier: "Rika.Agent.ThreadService.ThreadIdInput" })

export interface SetVisibilityInput extends Schema.Schema.Type<typeof SetVisibilityInput> {}
export const SetVisibilityInput = Schema.Struct({
  thread_id: Ids.ThreadId,
  visibility: Event.ThreadVisibility,
}).annotate({ identifier: "Rika.Agent.ThreadService.SetVisibilityInput" })

export interface ForkInput extends Schema.Schema.Type<typeof ForkInput> {}
export const ForkInput = Schema.Struct({
  thread_id: Ids.ThreadId,
  at_turn: Schema.optional(Ids.TurnId),
  user_id: Schema.optional(Ids.UserId),
  title_text: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Agent.ThreadService.ForkInput" })

export interface PreviewInput extends Schema.Schema.Type<typeof PreviewInput> {}
export const PreviewInput = Schema.Struct({
  thread_id: Ids.ThreadId,
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Agent.ThreadService.PreviewInput" })

export interface ListInput extends Schema.Schema.Type<typeof ListInput> {}
export const ListInput = Schema.Struct({
  include_archived: Schema.optional(Schema.Boolean),
  workspace_id: Schema.optional(Ids.WorkspaceId),
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Agent.ThreadService.ListInput" })

export interface SearchInput extends Schema.Schema.Type<typeof SearchInput> {}
export const SearchInput = Schema.Struct({
  query: Schema.optional(Schema.String),
  include_archived: Schema.optional(Schema.Boolean),
  workspace_id: Schema.optional(Ids.WorkspaceId),
  user_id: Schema.optional(Ids.UserId),
  after: Schema.optional(Common.TimestampMillis),
  before: Schema.optional(Common.TimestampMillis),
  limit: Schema.optional(Schema.Int),
  thread_ids: Schema.optional(Schema.Array(Ids.ThreadId)),
}).annotate({ identifier: "Rika.Agent.ThreadService.SearchInput" })

export interface ReferenceInput extends Schema.Schema.Type<typeof ReferenceInput> {}
export const ReferenceInput = Schema.Struct({
  thread_id: Ids.ThreadId,
  query: Schema.optional(Schema.String),
  max_chars: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Agent.ThreadService.ReferenceInput" })

export interface ThreadSummary extends Schema.Schema.Type<typeof ThreadSummary> {}
export const ThreadSummary = Schema.Struct({
  thread_id: Ids.ThreadId,
  workspace_id: Ids.WorkspaceId,
  user_id: Schema.optional(Ids.UserId),
  last_user_id: Schema.optional(Ids.UserId),
  title_text: Schema.optional(Schema.String),
  latest_message_id: Schema.optional(Ids.MessageId),
  latest_message_role: Schema.optional(Message.Role),
  latest_message_text: Schema.optional(Schema.String),
  latest_message_created_at: Schema.optional(Schema.Int),
  diff: ThreadProjection.ThreadDiffStats,
  active_turn_id: Schema.optional(Ids.TurnId),
  active_turn_status: Schema.optional(ThreadProjection.TurnStatus),
  context_tokens: Schema.optional(Schema.Int),
  context_window: Schema.optional(Schema.Int),
  archived: Schema.Boolean,
  visibility: Event.ThreadVisibilityDefaulted,
  created_at: Schema.Int,
  updated_at: Schema.Int,
}).annotate({ identifier: "Rika.Agent.ThreadService.ThreadSummary" })

export interface ThreadRecord extends Schema.Schema.Type<typeof ThreadRecord> {}
export const ThreadRecord = Schema.Struct({
  summary: ThreadSummary,
  events: Schema.Array(Event.Event),
}).annotate({ identifier: "Rika.Agent.ThreadService.ThreadRecord" })

export interface SearchResult extends Schema.Schema.Type<typeof SearchResult> {}
export const SearchResult = Schema.Struct({
  summary: ThreadSummary,
  score: Schema.Int,
  matched: Schema.Array(Schema.String),
}).annotate({ identifier: "Rika.Agent.ThreadService.SearchResult" })

export interface ThreadReference extends Schema.Schema.Type<typeof ThreadReference> {}
export const ThreadReference = Schema.Struct({
  thread_id: Ids.ThreadId,
  rendered: Schema.String,
  entries: Schema.Array(Schema.String),
  total_chars: Schema.Int,
  truncated: Schema.Boolean,
}).annotate({ identifier: "Rika.Agent.ThreadService.ThreadReference" })

export interface ThreadExport extends Schema.Schema.Type<typeof ThreadExport> {}
export const ThreadExport = Schema.Struct({
  schema_version: Schema.Literal(1),
  exported_at: Common.TimestampMillis,
  thread_id: Ids.ThreadId,
  summary: ThreadSummary,
  events: Schema.Array(Event.Event),
}).annotate({ identifier: "Rika.Agent.ThreadService.ThreadExport" })

export class ThreadServiceError extends Schema.TaggedErrorClass<ThreadServiceError>()("ThreadServiceError", {
  message: Schema.String,
  operation: Schema.String,
  thread_id: Schema.optional(Ids.ThreadId),
}) {}

export const ThreadForkErrorReason = Schema.Literals(["source_missing", "turn_missing", "turn_open"]).annotate({
  identifier: "Rika.Agent.ThreadService.ThreadForkErrorReason",
})
export type ThreadForkErrorReason = typeof ThreadForkErrorReason.Type

export class ThreadForkError extends Schema.TaggedErrorClass<ThreadForkError>()("ThreadForkError", {
  message: Schema.String,
  reason: ThreadForkErrorReason,
  thread_id: Ids.ThreadId,
  turn_id: Schema.optional(Ids.TurnId),
}) {}

export type Error =
  | ThreadServiceError
  | ThreadForkError
  | Config.ConfigError
  | Database.DatabaseError
  | ProjectStore.ProjectStoreError
  | ThreadEventLog.ThreadEventLogError
  | ThreadProjection.ThreadProjectionError

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<ThreadSummary, Error>
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<ThreadSummary>, Error>
  readonly open: (input: ThreadIdInput) => Effect.Effect<ThreadRecord, Error>
  readonly preview: (input: PreviewInput) => Effect.Effect<ThreadRecord, Error>
  readonly fork: (input: ForkInput) => Effect.Effect<ThreadSummary, Error>
  readonly archive: (input: ThreadIdInput) => Effect.Effect<ThreadSummary, Error>
  readonly unarchive: (input: ThreadIdInput) => Effect.Effect<ThreadSummary, Error>
  readonly setVisibility: (input: SetVisibilityInput) => Effect.Effect<ThreadSummary, Error>
  readonly deleteThread: (input: ThreadIdInput) => Effect.Effect<never, ThreadServiceError>
  readonly search: (input: SearchInput) => Effect.Effect<ReadonlyArray<SearchResult>, Error>
  readonly share: (input: ThreadIdInput) => Effect.Effect<ThreadExport, Error>
  readonly reference: (input: ReferenceInput) => Effect.Effect<ThreadReference, Error>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/ThreadService") {}

interface Dependencies {
  readonly config: Config.Interface
  readonly database: Database.Interface
  readonly eventLog: ThreadEventLog.Interface
  readonly projection: ThreadProjection.Interface
  readonly projectStore?: ProjectStore.Interface
  readonly idGenerator: IdGenerator.Interface
  readonly time: Time.Interface
  readonly diagnostics: Diagnostics.Interface
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const database = yield* Database.Service
    const eventLog = yield* ThreadEventLog.Service
    const projection = yield* ThreadProjection.Service
    const projectStore = Option.getOrUndefined(yield* Effect.serviceOption(ProjectStore.Service))
    const idGenerator = yield* IdGenerator.Service
    const time = yield* Time.Service
    const diagnostics = yield* Diagnostics.Service
    const dependencies: Dependencies = {
      config,
      database,
      eventLog,
      projection,
      ...(projectStore === undefined ? {} : { projectStore }),
      idGenerator,
      time,
      diagnostics,
    }

    return Service.of({
      create: Effect.fn("ThreadService.create")(function* (input: CreateInput) {
        return yield* threadEvent(
          dependencies.diagnostics,
          "thread.create",
          input.thread_id === undefined ? {} : { thread_id: input.thread_id },
          (fields) => createThread(dependencies, input, fields),
        )
      }),
      list: Effect.fn("ThreadService.list")(function* (input: ListInput = {}) {
        return yield* listThreads(dependencies, input)
      }),
      open: Effect.fn("ThreadService.open")(function* (input: ThreadIdInput) {
        return yield* openThread(dependencies, input.thread_id)
      }),
      preview: Effect.fn("ThreadService.preview")(function* (input: PreviewInput) {
        return yield* previewThread(dependencies, input)
      }),
      fork: Effect.fn("ThreadService.fork")(function* (input: ForkInput) {
        return yield* threadEvent(dependencies.diagnostics, "thread.fork", { thread_id: input.thread_id }, (fields) =>
          forkThread(dependencies, input, fields),
        )
      }),
      archive: Effect.fn("ThreadService.archive")(function* (input: ThreadIdInput) {
        return yield* threadEvent(
          dependencies.diagnostics,
          "thread.archive",
          { thread_id: input.thread_id },
          (fields) => setArchived(dependencies, input.thread_id, true, fields),
        )
      }),
      unarchive: Effect.fn("ThreadService.unarchive")(function* (input: ThreadIdInput) {
        return yield* threadEvent(
          dependencies.diagnostics,
          "thread.unarchive",
          { thread_id: input.thread_id },
          (fields) => setArchived(dependencies, input.thread_id, false, fields),
        )
      }),
      setVisibility: Effect.fn("ThreadService.setVisibility")(function* (input: SetVisibilityInput) {
        return yield* threadEvent(
          dependencies.diagnostics,
          "thread.visibility",
          { thread_id: input.thread_id, visibility: input.visibility },
          (fields) => setVisibilityInternal(dependencies, input, fields),
        )
      }),
      deleteThread: Effect.fn("ThreadService.deleteThread")(function* (input: ThreadIdInput) {
        return yield* new ThreadServiceError({
          message: "Thread deletion is not supported by the append-only local event log",
          operation: "deleteThread",
          thread_id: input.thread_id,
        })
      }),
      search: Effect.fn("ThreadService.search")(function* (input: SearchInput) {
        return yield* searchThreads(dependencies, input)
      }),
      share: Effect.fn("ThreadService.share")(function* (input: ThreadIdInput) {
        return yield* exportThread(dependencies, input.thread_id)
      }),
      reference: Effect.fn("ThreadService.reference")(function* (input: ReferenceInput) {
        return yield* referenceThread(dependencies, input)
      }),
    })
  }),
)

export const fakeLayer = (overrides: Partial<Interface> = {}) => {
  const fail = (operation: string, threadId?: Ids.ThreadId) =>
    Effect.fail(
      new ThreadServiceError({
        message: `Fake ThreadService does not implement ${operation}`,
        operation,
        thread_id: threadId,
      }),
    )

  return Layer.succeed(
    Service,
    Service.of({
      create: overrides.create ?? (() => fail("create")),
      list: overrides.list ?? (() => fail("list")),
      open: overrides.open ?? ((input) => fail("open", input.thread_id)),
      preview: overrides.preview ?? ((input) => fail("preview", input.thread_id)),
      fork: overrides.fork ?? ((input) => fail("fork", input.thread_id)),
      archive: overrides.archive ?? ((input) => fail("archive", input.thread_id)),
      unarchive: overrides.unarchive ?? ((input) => fail("unarchive", input.thread_id)),
      setVisibility: overrides.setVisibility ?? ((input) => fail("setVisibility", input.thread_id)),
      deleteThread: overrides.deleteThread ?? ((input) => fail("deleteThread", input.thread_id)),
      search: overrides.search ?? (() => fail("search")),
      share: overrides.share ?? ((input) => fail("share", input.thread_id)),
      reference: overrides.reference ?? ((input) => fail("reference", input.thread_id)),
    }),
  )
}

export const create = Effect.fn("ThreadService.create.call")(function* (input: CreateInput) {
  const service = yield* Service
  return yield* service.create(input)
})

export const list = Effect.fn("ThreadService.list.call")(function* (input: ListInput = {}) {
  const service = yield* Service
  return yield* service.list(input)
})

export const open = Effect.fn("ThreadService.open.call")(function* (input: ThreadIdInput) {
  const service = yield* Service
  return yield* service.open(input)
})

export const preview = Effect.fn("ThreadService.preview.call")(function* (input: PreviewInput) {
  const service = yield* Service
  return yield* service.preview(input)
})

export const fork = Effect.fn("ThreadService.fork.call")(function* (input: ForkInput) {
  const service = yield* Service
  return yield* service.fork(input)
})

export const archive = Effect.fn("ThreadService.archive.call")(function* (input: ThreadIdInput) {
  const service = yield* Service
  return yield* service.archive(input)
})

export const unarchive = Effect.fn("ThreadService.unarchive.call")(function* (input: ThreadIdInput) {
  const service = yield* Service
  return yield* service.unarchive(input)
})

export const setVisibility = Effect.fn("ThreadService.setVisibility.call")(function* (input: SetVisibilityInput) {
  const service = yield* Service
  return yield* service.setVisibility(input)
})

export const deleteThread = Effect.fn("ThreadService.deleteThread.call")(function* (input: ThreadIdInput) {
  const service = yield* Service
  return yield* service.deleteThread(input)
})

export const search = Effect.fn("ThreadService.search.call")(function* (input: SearchInput) {
  const service = yield* Service
  return yield* service.search(input)
})

export const share = Effect.fn("ThreadService.share.call")(function* (input: ThreadIdInput) {
  const service = yield* Service
  return yield* service.share(input)
})

export const reference = Effect.fn("ThreadService.reference.call")(function* (input: ReferenceInput) {
  const service = yield* Service
  return yield* service.reference(input)
})

const threadEvent = <A, E>(
  diagnostics: Diagnostics.Interface,
  op: string,
  seed: Diagnostics.Fields,
  run: (fields: Diagnostics.Fields) => Effect.Effect<A, E>,
) => Diagnostics.event(op, run, seed).pipe(Effect.provideService(Diagnostics.Service, diagnostics))

const createThread = (dependencies: Dependencies, input: CreateInput, fields: Diagnostics.Fields) =>
  Effect.gen(function* () {
    const config = yield* dependencies.config.get
    const threadId = input.thread_id ?? Ids.ThreadId.make(yield* dependencies.idGenerator.next("thread"))
    fields.thread_id = threadId
    const existing = yield* getSummary(dependencies, threadId)
    if (existing !== undefined) {
      fields.created = false
      return existing
    }

    const createdAt = yield* dependencies.time.nowMillis
    const workspaceId = input.workspace_id ?? Ids.WorkspaceId.make(config.workspace_root)
    const event: Event.ThreadCreated = {
      id: Ids.EventId.make(yield* dependencies.idGenerator.next("event")),
      thread_id: threadId,
      sequence: 1,
      version: 1,
      created_at: createdAt,
      type: "thread.created",
      data: {
        workspace_id: workspaceId,
        ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
      },
    }
    yield* appendAndProject(dependencies, event)
    fields.created = true
    fields.workspace_id = workspaceId
    fields.event_count = 1
    return yield* requireSummary(dependencies, threadId, "create")
  })

const listThreads = (dependencies: Dependencies, input: ListInput) =>
  Effect.gen(function* () {
    const limit = clamp(input.limit ?? 100, 1, 1_000)
    const summaries = yield* dependencies.projection
      .listThreads()
      .pipe(Effect.provideService(Database.Service, dependencies.database))
    const filtered = summaries
      .filter((summary) => input.include_archived === true || !summary.archived)
      .filter((summary) => input.workspace_id === undefined || summary.workspace_id === input.workspace_id)
      .map(summaryFromProjection)
    return limit === undefined ? filtered : filtered.slice(0, limit)
  })

const openThread = (dependencies: Dependencies, threadId: Ids.ThreadId) =>
  Effect.gen(function* () {
    const events = yield* readThread(dependencies, threadId)
    if (events.length === 0) {
      return yield* new ThreadServiceError({
        message: `Thread ${threadId} does not exist`,
        operation: "open",
        thread_id: threadId,
      })
    }
    const summary = yield* requireSummary(dependencies, threadId, "open")
    return { summary, events }
  })

const previewThread = (dependencies: Dependencies, input: PreviewInput) =>
  Effect.gen(function* () {
    const summary = yield* requireSummary(dependencies, input.thread_id, "preview")
    const limit = clamp(input.limit ?? defaultPreviewLimit, 1, 500)
    const events = yield* readThreadTail(dependencies, input.thread_id, limit)
    return { summary, events }
  })

const setArchived = (
  dependencies: Dependencies,
  threadId: Ids.ThreadId,
  archived: boolean,
  fields: Diagnostics.Fields,
) =>
  Effect.gen(function* () {
    const record = yield* openThread(dependencies, threadId)
    fields.event_count = record.events.length
    if (record.summary.archived === archived) {
      fields.changed = false
      return record.summary
    }

    const createdAt = yield* dependencies.time.nowMillis
    const sequence = latestSequence(record.events) + 1
    const common = {
      id: Ids.EventId.make(yield* dependencies.idGenerator.next("event")),
      thread_id: threadId,
      sequence,
      version: 1 as const,
      created_at: createdAt,
      data: {},
    }
    const event: Event.ThreadArchived | Event.ThreadUnarchived = archived
      ? { ...common, type: "thread.archived" }
      : { ...common, type: "thread.unarchived" }
    yield* appendAndProject(dependencies, event)
    fields.changed = true
    fields.sequence = sequence
    return yield* requireSummary(dependencies, threadId, archived ? "archive" : "unarchive")
  })

const setVisibilityInternal = (dependencies: Dependencies, input: SetVisibilityInput, fields: Diagnostics.Fields) =>
  Effect.gen(function* () {
    const record = yield* openThread(dependencies, input.thread_id)
    fields.event_count = record.events.length
    if (record.summary.visibility === input.visibility) {
      fields.changed = false
      return record.summary
    }

    const createdAt = yield* dependencies.time.nowMillis
    const sequence = latestSequence(record.events) + 1
    const event: Event.ThreadVisibilitySet = {
      id: Ids.EventId.make(yield* dependencies.idGenerator.next("event")),
      thread_id: input.thread_id,
      sequence,
      version: 1,
      created_at: createdAt,
      type: "thread.visibility.set",
      data: { visibility: input.visibility },
    }
    yield* appendAndProject(dependencies, event)
    fields.changed = true
    fields.sequence = sequence
    return yield* requireSummary(dependencies, input.thread_id, "setVisibility")
  })

const searchThreads = (dependencies: Dependencies, input: SearchInput) =>
  Effect.gen(function* () {
    const parsed = ThreadSearchQuery.parseThreadSearchQuery(input.query ?? "")
    const now = yield* dependencies.time.nowMillis
    const projectWorkspaceId = yield* resolveProjectWorkspaceId(dependencies, parsed.project)
    if (parsed.project !== undefined && projectWorkspaceId === undefined) return []
    if (
      input.workspace_id !== undefined &&
      projectWorkspaceId !== undefined &&
      input.workspace_id !== projectWorkspaceId
    ) {
      return []
    }
    const fileThreadIds = yield* matchingFileThreadIds(dependencies, parsed.file_globs, input.thread_ids)
    if (parsed.file_globs.length > 0 && fileThreadIds !== undefined && fileThreadIds.size === 0) return []
    const threadIds = combineThreadIds(input.thread_ids, fileThreadIds)
    if (parsed.file_globs.length > 0 && threadIds !== undefined && threadIds.length === 0) return []
    const includeArchived = parsed.archived === true ? true : input.include_archived
    const candidateInput: SearchInput = {
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(includeArchived === undefined ? {} : { include_archived: includeArchived }),
      ...(projectWorkspaceId === undefined && input.workspace_id === undefined
        ? {}
        : { workspace_id: projectWorkspaceId ?? input.workspace_id }),
      ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
      ...resolvedBound("after", input.after, parsed.after, now),
      ...resolvedBound("before", input.before, parsed.before, now),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(threadIds === undefined ? {} : { thread_ids: threadIds }),
    }
    const summaries = yield* searchCandidateSummaries(dependencies, candidateInput, parsed.archived)
    const terms = parsed.terms
    let scored: ReadonlyArray<SearchResult>
    if (terms.length === 0) {
      scored = summaries.map((summary) => scoreSummary(summary, [], terms))
    } else if (candidateInput.thread_ids === undefined) {
      scored = yield* scoreSummariesFromAllEvents(dependencies, summaries, terms)
    } else {
      scored = yield* scoreSummariesFromThreadEvents(dependencies, summaries, terms)
    }
    const results = scored
      .filter((result) => terms.length === 0 || result.score > 0)
      .toSorted((left, right) => right.score - left.score || right.summary.updated_at - left.summary.updated_at)
    return results.slice(0, clamp(input.limit ?? defaultSearchLimit, 1, 1_000))
  })

const searchCandidateSummaries = (dependencies: Dependencies, input: SearchInput, archived?: boolean) =>
  Effect.gen(function* () {
    const threadIds =
      input.thread_ids === undefined ? undefined : new Set(input.thread_ids.map((threadId) => String(threadId)))
    const summaries = yield* dependencies.projection
      .listThreads()
      .pipe(Effect.provideService(Database.Service, dependencies.database))
    return summaries
      .filter((summary) => input.include_archived === true || !summary.archived)
      .filter((summary) => archived === undefined || summary.archived === archived)
      .filter((summary) => input.workspace_id === undefined || summary.workspace_id === input.workspace_id)
      .filter((summary) => threadIds === undefined || threadIds.has(String(summary.thread_id)))
      .filter((summary) => input.user_id === undefined || summary.user_id === input.user_id)
      .filter((summary) => input.after === undefined || summary.updated_at >= input.after)
      .filter((summary) => input.before === undefined || summary.updated_at <= input.before)
      .map(summaryFromProjection)
  })

const scoreSummariesFromAllEvents = (
  dependencies: Dependencies,
  summaries: ReadonlyArray<ThreadSummary>,
  terms: ReadonlyArray<string>,
) =>
  readAll(dependencies).pipe(
    Effect.map((events) => {
      const grouped = groupEventsByThread(events)
      return summaries.map((summary) => scoreSummary(summary, grouped.get(summary.thread_id) ?? [], terms))
    }),
  )

const scoreSummariesFromThreadEvents = (
  dependencies: Dependencies,
  summaries: ReadonlyArray<ThreadSummary>,
  terms: ReadonlyArray<string>,
) =>
  Effect.forEach(summaries, (summary) =>
    readThread(dependencies, summary.thread_id).pipe(Effect.map((events) => scoreSummary(summary, events, terms))),
  )

const exportThread = (dependencies: Dependencies, threadId: Ids.ThreadId) =>
  Effect.gen(function* () {
    const record = yield* openThread(dependencies, threadId)
    const exportedAt = yield* dependencies.time.nowMillis
    return { schema_version: 1 as const, exported_at: exportedAt, thread_id: threadId, ...record }
  })

const forkThread = (dependencies: Dependencies, input: ForkInput, fields: Diagnostics.Fields) =>
  Effect.gen(function* () {
    const sourceEvents = yield* readThread(dependencies, input.thread_id)
    if (sourceEvents.length === 0) return yield* forkError(input.thread_id, "source_missing")

    const cutoff = yield* forkCutoff(sourceEvents, input.thread_id, input.at_turn)
    const sourcePrefix = sourceEvents.filter((event) => event.sequence <= cutoff)
    const forkedPrefix = sourcePrefix.filter((event) => event.type !== "thread.visibility.set")
    const forkThreadId = Ids.ThreadId.make(yield* dependencies.idGenerator.next("thread"))
    const created = requireThreadCreated(sourcePrefix, input.thread_id)
    const forkedEvents = yield* Effect.forEach(forkedPrefix, (event, index) =>
      forkEvent(dependencies, {
        event,
        sequence: index + 1,
        forkThreadId,
        sourceThreadId: input.thread_id,
        sourceCreated: created,
        ...(input.user_id === undefined ? {} : { userId: input.user_id }),
        ...(input.title_text === undefined ? {} : { titleText: input.title_text }),
        cutoff,
      }),
    )
    yield* dependencies.eventLog
      .appendManyAndProject(forkedEvents)
      .pipe(Effect.provideService(Database.Service, dependencies.database))
    fields.fork_thread_id = forkThreadId
    fields.cutoff_sequence = cutoff
    fields.event_count = forkedEvents.length
    return yield* requireSummary(dependencies, forkThreadId, "fork")
  })

const referenceThread = (dependencies: Dependencies, input: ReferenceInput) =>
  Effect.gen(function* () {
    const record = yield* openThread(dependencies, input.thread_id)
    const maxChars = clamp(input.max_chars ?? defaultReferenceChars, 400, 10_000)
    const entries = referenceEntries(record, ThreadSearchQuery.parseThreadSearchQuery(input.query ?? "").terms)
    const rendered = capText(entries.join("\n"), maxChars)
    return {
      thread_id: input.thread_id,
      rendered: rendered.text,
      entries,
      total_chars: rendered.text.length,
      truncated: rendered.truncated,
    }
  })

const referenceEntries = (record: ThreadRecord, terms: ReadonlyArray<string>) => {
  const messages = record.events.flatMap(ThreadDigest.messageEntry)
  const relevant =
    terms.length === 0
      ? messages
      : messages.filter((message) => terms.some((term) => message.toLowerCase().includes(term)))
  const selected = StringArray.uniqueNonEmptyStrings([
    `Thread ${record.summary.thread_id}`,
    `Workspace: ${record.summary.workspace_id}`,
    `Visibility: ${record.summary.visibility}`,
    `Archived: ${record.summary.archived}`,
    ...(record.summary.latest_message_text === undefined
      ? []
      : [`Latest: ${oneLine(record.summary.latest_message_text)}`]),
    ...firstAndLast(relevant.length === 0 ? messages : relevant, 6),
    ...ThreadDigest.toolEntries(record.events).slice(-4),
    ...ThreadDigest.fileEntries(record.events)
      .slice(0, 8)
      .map((path) => `File: ${path}`),
  ])
  return selected
}

const scoreSummary = (
  summary: ThreadSummary,
  events: ReadonlyArray<Event.Event>,
  terms: ReadonlyArray<string>,
): SearchResult => {
  const fields = searchableFields(summary, events)
  const matched =
    terms.length === 0 ? [] : fields.filter((field) => terms.some((term) => field.toLowerCase().includes(term)))
  const score =
    terms.length === 0
      ? 0
      : terms.reduce((total, term) => total + fields.filter((field) => field.toLowerCase().includes(term)).length, 0)
  return { summary, score, matched: StringArray.uniqueNonEmptyStrings(matched).slice(0, 8) }
}

const searchableFields = (summary: ThreadSummary, events: ReadonlyArray<Event.Event>) =>
  StringArray.uniqueNonEmptyStrings([
    summary.thread_id,
    summary.workspace_id,
    summary.user_id ?? "",
    summary.latest_message_text ?? "",
    ...events.flatMap(ThreadDigest.messageEntry),
    ...ThreadDigest.fileEntries(events),
    ...ThreadDigest.toolEntries(events),
    ...events.map((event) => JSON.stringify(event.metadata ?? {})),
  ]).filter((value) => value.length > 0)

const resolveProjectWorkspaceId = (dependencies: Dependencies, projectName: string | undefined) =>
  Effect.gen(function* () {
    if (projectName === undefined || dependencies.projectStore === undefined) return undefined
    const project = yield* dependencies.projectStore.getByName(projectName)
    return project === undefined ? undefined : Ids.WorkspaceId.make(`project:${project.project_id}`)
  })

const matchingFileThreadIds = (
  dependencies: Dependencies,
  fileGlobs: ReadonlyArray<string>,
  threadIds: ReadonlyArray<Ids.ThreadId> | undefined,
) =>
  fileGlobs.length === 0
    ? Effect.succeed(undefined)
    : dependencies.projection.listThreadFiles(threadIds === undefined ? {} : { thread_ids: threadIds }).pipe(
        Effect.provideService(Database.Service, dependencies.database),
        Effect.map(
          (files) =>
            new Set(
              files
                .filter((file) => fileGlobs.some((glob) => ThreadSearchQuery.matchesFileGlob(file.path, glob)))
                .map((file) => file.thread_id),
            ),
        ),
      )

const combineThreadIds = (
  inputThreadIds: ReadonlyArray<Ids.ThreadId> | undefined,
  fileThreadIds: ReadonlySet<Ids.ThreadId> | undefined,
): ReadonlyArray<Ids.ThreadId> | undefined => {
  if (fileThreadIds === undefined) return inputThreadIds
  if (inputThreadIds === undefined) return [...fileThreadIds]
  return inputThreadIds.filter((threadId) => fileThreadIds.has(threadId))
}

const resolvedBound = (
  key: "after" | "before",
  input: Common.TimestampMillis | undefined,
  parsed: ThreadSearchQuery.DateFilter | undefined,
  now: Common.TimestampMillis,
) => {
  const parsedMillis = parsed === undefined ? undefined : ThreadSearchQuery.resolveDateFilter(parsed, now)
  const value = key === "after" ? maxTimestamp(input, parsedMillis) : minTimestamp(input, parsedMillis)
  return value === undefined ? {} : { [key]: value }
}

const maxTimestamp = (
  left: Common.TimestampMillis | undefined,
  right: Common.TimestampMillis | undefined,
): Common.TimestampMillis | undefined => {
  if (left === undefined) return right
  if (right === undefined) return left
  return Common.TimestampMillis.make(Math.max(left, right))
}

const minTimestamp = (
  left: Common.TimestampMillis | undefined,
  right: Common.TimestampMillis | undefined,
): Common.TimestampMillis | undefined => {
  if (left === undefined) return right
  if (right === undefined) return left
  return Common.TimestampMillis.make(Math.min(left, right))
}

const appendAndProject = (dependencies: Dependencies, event: Event.Event) =>
  Effect.gen(function* () {
    const appended = yield* dependencies.eventLog
      .appendAndProject(event)
      .pipe(Effect.provideService(Database.Service, dependencies.database))
    return appended
  })

interface ForkEventInput {
  readonly event: Event.Event
  readonly sequence: number
  readonly forkThreadId: Ids.ThreadId
  readonly sourceThreadId: Ids.ThreadId
  readonly sourceCreated: Event.ThreadCreated
  readonly userId?: Ids.UserId
  readonly titleText?: string
  readonly cutoff: number
}

const forkEvent = (dependencies: Dependencies, input: ForkEventInput) =>
  Effect.gen(function* () {
    const id = Ids.EventId.make(yield* dependencies.idGenerator.next("event"))
    const fields = {
      id,
      thread_id: input.forkThreadId,
      sequence: input.sequence,
    }
    if (input.event.type === "thread.created") {
      const event: Event.ThreadCreated = {
        ...input.event,
        ...fields,
        data: {
          workspace_id: input.sourceCreated.data.workspace_id,
          ...(input.userId === undefined ? {} : { user_id: input.userId }),
          ...(input.titleText === undefined ? {} : { title_text: input.titleText }),
          forked_from: { thread_id: input.sourceThreadId, sequence: input.cutoff },
        },
      }
      return event
    }
    if (input.event.type === "message.added") {
      const event: Event.MessageAdded = {
        ...input.event,
        ...fields,
        data: {
          message: {
            ...input.event.data.message,
            thread_id: input.forkThreadId,
          },
        },
      }
      return event
    }
    return { ...input.event, ...fields } as Event.Event
  })

const forkCutoff = (
  events: ReadonlyArray<Event.Event>,
  threadId: Ids.ThreadId,
  atTurn: Ids.TurnId | undefined,
): Effect.Effect<number, ThreadForkError> => {
  if (atTurn !== undefined) {
    const terminal = events.find((event) => isTurnTerminal(event) && event.turn_id === atTurn)
    if (terminal !== undefined) return Effect.succeed(terminal.sequence)
    const hasTurn = events.some((event) => event.turn_id === atTurn)
    return hasTurn ? forkError(threadId, "turn_open", atTurn) : forkError(threadId, "turn_missing", atTurn)
  }

  const lastStarted = events.findLast((event): event is Event.TurnStarted => event.type === "turn.started")
  if (
    lastStarted !== undefined &&
    !events.some((event) => isTurnTerminal(event) && event.turn_id === lastStarted.turn_id)
  ) {
    return forkError(threadId, "turn_open", lastStarted.turn_id)
  }
  return Effect.succeed(latestSequence(events))
}

const requireThreadCreated = (events: ReadonlyArray<Event.Event>, threadId: Ids.ThreadId) => {
  const created = events.find((event): event is Event.ThreadCreated => event.type === "thread.created")
  if (created !== undefined) return created
  throw new ThreadForkError({
    message: `Thread ${threadId} has no thread.created event`,
    reason: "source_missing",
    thread_id: threadId,
  })
}

const forkError = (threadId: Ids.ThreadId, reason: ThreadForkErrorReason, turnId?: Ids.TurnId) =>
  Effect.fail(
    new ThreadForkError({
      message: forkErrorMessage(threadId, reason, turnId),
      reason,
      thread_id: threadId,
      ...(turnId === undefined ? {} : { turn_id: turnId }),
    }),
  )

const forkErrorMessage = (threadId: Ids.ThreadId, reason: ThreadForkErrorReason, turnId?: Ids.TurnId) => {
  if (reason === "source_missing") return `Thread ${threadId} does not exist`
  if (reason === "turn_missing") return `Thread ${threadId} has no turn ${turnId}`
  return `Thread ${threadId} turn ${turnId} is still open`
}

const isTurnTerminal = (event: Event.Event): event is Event.TurnCompleted | Event.TurnFailed =>
  event.type === "turn.completed" || event.type === "turn.failed"

const readThread = (dependencies: Dependencies, threadId: Ids.ThreadId) =>
  dependencies.eventLog
    .readThread({ thread_id: threadId })
    .pipe(Effect.provideService(Database.Service, dependencies.database))

const readThreadTail = (dependencies: Dependencies, threadId: Ids.ThreadId, limit: number) =>
  dependencies.eventLog
    .readThreadTail({ thread_id: threadId, limit })
    .pipe(Effect.provideService(Database.Service, dependencies.database))

const readAll = (dependencies: Dependencies) =>
  dependencies.eventLog.readAll().pipe(Effect.provideService(Database.Service, dependencies.database))

const getSummary = (dependencies: Dependencies, threadId: Ids.ThreadId) =>
  dependencies.projection.getThread(threadId).pipe(
    Effect.map((summary) => (summary === undefined ? undefined : summaryFromProjection(summary))),
    Effect.provideService(Database.Service, dependencies.database),
  )

const requireSummary = (dependencies: Dependencies, threadId: Ids.ThreadId, operation: string) =>
  Effect.gen(function* () {
    const summary = yield* getSummary(dependencies, threadId)
    if (summary !== undefined) return summary
    return yield* new ThreadServiceError({
      message: `Missing projection for thread ${threadId}`,
      operation,
      thread_id: threadId,
    })
  })

const summaryFromProjection = (summary: ThreadProjection.ThreadSummary): ThreadSummary => {
  const { last_model: lastModel, ...base } = summary
  return {
    ...base,
    ...(lastModel === undefined ? {} : { context_window: ModelInfo.modelInfo(lastModel).context_window }),
  }
}

const groupEventsByThread = (events: ReadonlyArray<Event.Event>) => {
  const grouped = new Map<Ids.ThreadId, Array<Event.Event>>()
  for (const event of events) {
    const current = grouped.get(event.thread_id) ?? []
    current.push(event)
    grouped.set(event.thread_id, current)
  }
  return grouped
}

const firstAndLast = (values: ReadonlyArray<string>, limit: number) => {
  if (values.length <= limit) return values
  const head = values.slice(0, Math.ceil(limit / 2))
  const tail = values.slice(-Math.floor(limit / 2))
  return [...head, ...tail]
}

const capText = (text: string, maxChars: number) =>
  text.length <= maxChars
    ? { text, truncated: false }
    : { text: `${text.slice(0, maxChars)}\n… truncated`, truncated: true }

const latestSequence = (events: ReadonlyArray<Event.Event>) => events.at(-1)?.sequence ?? 0
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(Math.floor(value), min), max)
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim()
