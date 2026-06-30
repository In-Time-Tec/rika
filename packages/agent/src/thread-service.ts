import { Config, IdGenerator, Time } from "@rika/core"
import { Database, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"

const defaultReferenceChars = 2_000
const defaultSearchLimit = 20

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
}).annotate({ identifier: "Rika.Agent.ThreadService.SearchInput" })

export interface ReferenceInput extends Schema.Schema.Type<typeof ReferenceInput> {}
export const ReferenceInput = Schema.Struct({
  thread_id: Ids.ThreadId,
  query: Schema.optional(Schema.String),
  max_chars: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Agent.ThreadService.ReferenceInput" })

export interface ThreadRecord extends Schema.Schema.Type<typeof ThreadRecord> {}
export const ThreadRecord = Schema.Struct({
  summary: ThreadProjection.ThreadSummary,
  events: Schema.Array(Event.Event),
}).annotate({ identifier: "Rika.Agent.ThreadService.ThreadRecord" })

export interface SearchResult extends Schema.Schema.Type<typeof SearchResult> {}
export const SearchResult = Schema.Struct({
  summary: ThreadProjection.ThreadSummary,
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
  summary: ThreadProjection.ThreadSummary,
  events: Schema.Array(Event.Event),
}).annotate({ identifier: "Rika.Agent.ThreadService.ThreadExport" })

export class ThreadServiceError extends Schema.TaggedErrorClass<ThreadServiceError>()("ThreadServiceError", {
  message: Schema.String,
  operation: Schema.String,
  thread_id: Schema.optional(Ids.ThreadId),
}) {}

export type Error =
  | ThreadServiceError
  | Config.ConfigError
  | Database.DatabaseError
  | ThreadEventLog.ThreadEventLogError
  | ThreadProjection.ThreadProjectionError

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<ThreadProjection.ThreadSummary, Error>
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<ThreadProjection.ThreadSummary>, Error>
  readonly open: (input: ThreadIdInput) => Effect.Effect<ThreadRecord, Error>
  readonly archive: (input: ThreadIdInput) => Effect.Effect<ThreadProjection.ThreadSummary, Error>
  readonly unarchive: (input: ThreadIdInput) => Effect.Effect<ThreadProjection.ThreadSummary, Error>
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
  readonly idGenerator: IdGenerator.Interface
  readonly time: Time.Interface
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const database = yield* Database.Service
    const eventLog = yield* ThreadEventLog.Service
    const projection = yield* ThreadProjection.Service
    const idGenerator = yield* IdGenerator.Service
    const time = yield* Time.Service
    const dependencies: Dependencies = { config, database, eventLog, projection, idGenerator, time }

    return Service.of({
      create: Effect.fn("ThreadService.create")(function* (input: CreateInput) {
        return yield* createThread(dependencies, input)
      }),
      list: Effect.fn("ThreadService.list")(function* (input: ListInput = {}) {
        return yield* listThreads(dependencies, input)
      }),
      open: Effect.fn("ThreadService.open")(function* (input: ThreadIdInput) {
        return yield* openThread(dependencies, input.thread_id)
      }),
      archive: Effect.fn("ThreadService.archive")(function* (input: ThreadIdInput) {
        return yield* setArchived(dependencies, input.thread_id, true)
      }),
      unarchive: Effect.fn("ThreadService.unarchive")(function* (input: ThreadIdInput) {
        return yield* setArchived(dependencies, input.thread_id, false)
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
      archive: overrides.archive ?? ((input) => fail("archive", input.thread_id)),
      unarchive: overrides.unarchive ?? ((input) => fail("unarchive", input.thread_id)),
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

export const archive = Effect.fn("ThreadService.archive.call")(function* (input: ThreadIdInput) {
  const service = yield* Service
  return yield* service.archive(input)
})

export const unarchive = Effect.fn("ThreadService.unarchive.call")(function* (input: ThreadIdInput) {
  const service = yield* Service
  return yield* service.unarchive(input)
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

const createThread = (dependencies: Dependencies, input: CreateInput) =>
  Effect.gen(function* () {
    const config = yield* dependencies.config.get
    const threadId = input.thread_id ?? Ids.ThreadId.make(yield* dependencies.idGenerator.next("thread"))
    const existing = yield* getSummary(dependencies, threadId)
    if (existing !== undefined) return existing

    const createdAt = yield* dependencies.time.nowMillis
    const event: Event.ThreadCreated = {
      id: Ids.EventId.make(yield* dependencies.idGenerator.next("event")),
      thread_id: threadId,
      sequence: 1,
      version: 1,
      created_at: createdAt,
      type: "thread.created",
      data: {
        workspace_id: input.workspace_id ?? Ids.WorkspaceId.make(config.workspace_root),
        ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
      },
    }
    yield* appendAndProject(dependencies, event)
    return yield* requireSummary(dependencies, threadId, "create")
  })

const listThreads = (dependencies: Dependencies, input: ListInput) =>
  Effect.gen(function* () {
    const limit = clamp(input.limit ?? 100, 1, 1_000)
    const summaries = yield* dependencies.projection
      .listThreads()
      .pipe(Effect.provideService(Database.Service, dependencies.database))
    return summaries
      .filter((summary) => input.include_archived === true || !summary.archived)
      .filter((summary) => input.workspace_id === undefined || summary.workspace_id === input.workspace_id)
      .slice(0, limit)
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

const setArchived = (dependencies: Dependencies, threadId: Ids.ThreadId, archived: boolean) =>
  Effect.gen(function* () {
    const record = yield* openThread(dependencies, threadId)
    if (record.summary.archived === archived) return record.summary

    const createdAt = yield* dependencies.time.nowMillis
    const common = {
      id: Ids.EventId.make(yield* dependencies.idGenerator.next("event")),
      thread_id: threadId,
      sequence: latestSequence(record.events) + 1,
      version: 1 as const,
      created_at: createdAt,
      data: {},
    }
    const event: Event.ThreadArchived | Event.ThreadUnarchived = archived
      ? { ...common, type: "thread.archived" }
      : { ...common, type: "thread.unarchived" }
    yield* appendAndProject(dependencies, event)
    return yield* requireSummary(dependencies, threadId, archived ? "archive" : "unarchive")
  })

const searchThreads = (dependencies: Dependencies, input: SearchInput) =>
  Effect.gen(function* () {
    const summaries = yield* listThreads(dependencies, {
      limit: 1_000,
      ...(input.include_archived === undefined ? {} : { include_archived: input.include_archived }),
      ...(input.workspace_id === undefined ? {} : { workspace_id: input.workspace_id }),
    })
    const events = groupEventsByThread(yield* readAll(dependencies))
    const terms = tokenize(input.query ?? "")
    const results = summaries
      .filter((summary) => input.user_id === undefined || summary.user_id === input.user_id)
      .filter((summary) => input.after === undefined || summary.updated_at >= input.after)
      .filter((summary) => input.before === undefined || summary.updated_at <= input.before)
      .map((summary) => scoreSummary(summary, events.get(summary.thread_id) ?? [], terms))
      .filter((result) => terms.length === 0 || result.score > 0)
      .toSorted((left, right) => right.score - left.score || right.summary.updated_at - left.summary.updated_at)
    return results.slice(0, clamp(input.limit ?? defaultSearchLimit, 1, 100))
  })

const exportThread = (dependencies: Dependencies, threadId: Ids.ThreadId) =>
  Effect.gen(function* () {
    const record = yield* openThread(dependencies, threadId)
    const exportedAt = yield* dependencies.time.nowMillis
    return { schema_version: 1 as const, exported_at: exportedAt, thread_id: threadId, ...record }
  })

const referenceThread = (dependencies: Dependencies, input: ReferenceInput) =>
  Effect.gen(function* () {
    const record = yield* openThread(dependencies, input.thread_id)
    const maxChars = clamp(input.max_chars ?? defaultReferenceChars, 400, 10_000)
    const entries = referenceEntries(record, tokenize(input.query ?? ""))
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
  const messages = record.events.flatMap(messageEntry)
  const relevant =
    terms.length === 0
      ? messages
      : messages.filter((message) => terms.some((term) => message.toLowerCase().includes(term)))
  const selected = uniqueStrings([
    `Thread ${record.summary.thread_id}`,
    `Workspace: ${record.summary.workspace_id}`,
    `Archived: ${record.summary.archived}`,
    ...(record.summary.latest_message_text === undefined
      ? []
      : [`Latest: ${oneLine(record.summary.latest_message_text)}`]),
    ...firstAndLast(relevant.length === 0 ? messages : relevant, 6),
    ...toolEntries(record.events).slice(-4),
    ...fileEntries(record.events)
      .slice(0, 8)
      .map((path) => `File: ${path}`),
  ])
  return selected
}

const scoreSummary = (
  summary: ThreadProjection.ThreadSummary,
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
  return { summary, score, matched: uniqueStrings(matched).slice(0, 8) }
}

const searchableFields = (summary: ThreadProjection.ThreadSummary, events: ReadonlyArray<Event.Event>) =>
  uniqueStrings([
    summary.thread_id,
    summary.workspace_id,
    summary.user_id ?? "",
    summary.latest_message_text ?? "",
    ...events.flatMap(messageEntry),
    ...fileEntries(events),
    ...toolEntries(events),
    ...events.map((event) => JSON.stringify(event.metadata ?? {})),
  ]).filter((value) => value.length > 0)

const messageEntry = (event: Event.Event): ReadonlyArray<string> => {
  if (event.type !== "message.added") return []
  const text = messageText(event.data.message)
  return text.length === 0 ? [] : [`${event.data.message.role}: ${oneLine(text)}`]
}

const toolEntries = (events: ReadonlyArray<Event.Event>) =>
  events.flatMap((event) => {
    if (event.type === "tool.call.requested") return [`Tool: ${event.data.call.name}`]
    if (event.type === "tool.call.completed")
      return [`Tool result: ${event.data.result.name} ${event.data.result.status}`]
    return []
  })

const fileEntries = (events: ReadonlyArray<Event.Event>) => uniqueStrings(events.flatMap(pathsFromEvent))

const pathsFromEvent = (event: Event.Event): ReadonlyArray<string> => {
  if (event.type === "message.added") {
    return event.data.message.content.flatMap((part) => {
      if (part.type === "file-reference") return [part.path]
      if (part.type === "image" && part.filename !== undefined) return [part.filename]
      return []
    })
  }
  if (event.type === "context.resolved")
    return event.data.entries.flatMap((entry) => (entry.path === undefined ? [] : [entry.path]))
  if (event.type === "tool.call.completed" && event.data.result.output !== undefined)
    return pathsFromJson(event.data.result.output)
  return []
}

const pathsFromJson = (value: Common.JsonValue): ReadonlyArray<string> => {
  if (typeof value === "string") return looksLikePath(value) ? [value] : []
  if (Array.isArray(value)) return value.flatMap(pathsFromJson)
  if (!isJsonObject(value)) return []
  return Object.entries(value).flatMap(([key, child]) =>
    (key === "path" || key === "file" || key === "filename") && typeof child === "string" && looksLikePath(child)
      ? [child]
      : pathsFromJson(child),
  )
}

const appendAndProject = (dependencies: Dependencies, event: Event.Event) =>
  Effect.gen(function* () {
    const appended = yield* dependencies.eventLog
      .append(event)
      .pipe(Effect.provideService(Database.Service, dependencies.database))
    yield* dependencies.projection.apply(appended).pipe(Effect.provideService(Database.Service, dependencies.database))
    return appended
  })

const readThread = (dependencies: Dependencies, threadId: Ids.ThreadId) =>
  dependencies.eventLog
    .readThread({ thread_id: threadId })
    .pipe(Effect.provideService(Database.Service, dependencies.database))

const readAll = (dependencies: Dependencies) =>
  dependencies.eventLog.readAll().pipe(Effect.provideService(Database.Service, dependencies.database))

const getSummary = (dependencies: Dependencies, threadId: Ids.ThreadId) =>
  dependencies.projection.getThread(threadId).pipe(Effect.provideService(Database.Service, dependencies.database))

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

const groupEventsByThread = (events: ReadonlyArray<Event.Event>) => {
  const grouped = new Map<Ids.ThreadId, Array<Event.Event>>()
  for (const event of events) {
    const current = grouped.get(event.thread_id) ?? []
    current.push(event)
    grouped.set(event.thread_id, current)
  }
  return grouped
}

const messageText = (message: Message.Message) => Message.displayText(message)

const tokenize = (query: string) =>
  uniqueStrings(
    query
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean),
  )

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
const uniqueStrings = (values: ReadonlyArray<string>) => [...new Set(values.filter((value) => value.length > 0))]
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim()
const looksLikePath = (value: string) => value.includes("/") || /\.[A-Za-z0-9]+$/.test(value)
const isJsonObject = (value: Common.JsonValue | undefined): value is Record<string, Common.JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
