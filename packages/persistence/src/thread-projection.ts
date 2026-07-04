import { Common, Event, Ids, Message } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import * as Database from "./database"
import * as ThreadFileProjection from "./thread-file-projection"
import { decodePayload } from "./thread-event-log"

export const TurnStatus = Schema.Literals(["active", "completed", "failed"]).annotate({
  identifier: "Rika.ThreadProjection.TurnStatus",
})
export type TurnStatus = typeof TurnStatus.Type

export interface ThreadDiffStats extends Schema.Schema.Type<typeof ThreadDiffStats> {}
export const ThreadDiffStats = Schema.Struct({
  additions: Schema.Int,
  modifications: Schema.Int,
  deletions: Schema.Int,
}).annotate({ identifier: "Rika.ThreadProjection.ThreadDiffStats" })

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
  diff: ThreadDiffStats,
  active_turn_id: Schema.optional(Ids.TurnId),
  active_turn_status: Schema.optional(TurnStatus),
  context_tokens: Schema.optional(Schema.Int),
  last_model: Schema.optional(Schema.String),
  archived: Schema.Boolean,
  visibility: Event.ThreadVisibility,
  created_at: Schema.Int,
  updated_at: Schema.Int,
}).annotate({ identifier: "Rika.ThreadProjection.ThreadSummary" })

export interface ThreadFile extends Schema.Schema.Type<typeof ThreadFile> {}
export const ThreadFile = Schema.Struct({
  thread_id: Ids.ThreadId,
  path: Schema.String,
  first_seen_at: Schema.Int,
  last_seen_at: Schema.Int,
}).annotate({ identifier: "Rika.ThreadProjection.ThreadFile" })

export interface ThreadFilesInput extends Schema.Schema.Type<typeof ThreadFilesInput> {}
export const ThreadFilesInput = Schema.Struct({
  thread_id: Schema.optional(Ids.ThreadId),
  thread_ids: Schema.optional(Schema.Array(Ids.ThreadId)),
}).annotate({ identifier: "Rika.ThreadProjection.ThreadFilesInput" })

export class ThreadProjectionError extends Schema.TaggedErrorClass<ThreadProjectionError>()("ThreadProjectionError", {
  message: Schema.String,
  operation: Schema.String,
  thread_id: Schema.optional(Ids.ThreadId),
}) {}

export interface Interface {
  readonly apply: (
    event: Event.Event,
  ) => Effect.Effect<void, Database.DatabaseError | ThreadProjectionError, Database.Service>
  readonly rebuild: () => Effect.Effect<void, Database.DatabaseError | ThreadProjectionError, Database.Service>
  readonly clear: () => Effect.Effect<void, Database.DatabaseError | ThreadProjectionError, Database.Service>
  readonly listThreads: () => Effect.Effect<
    ReadonlyArray<ThreadSummary>,
    Database.DatabaseError | ThreadProjectionError,
    Database.Service
  >
  readonly getThread: (
    threadId: Ids.ThreadId,
  ) => Effect.Effect<ThreadSummary | undefined, Database.DatabaseError | ThreadProjectionError, Database.Service>
  readonly listThreadFiles: (
    input?: ThreadFilesInput,
  ) => Effect.Effect<ReadonlyArray<ThreadFile>, Database.DatabaseError | ThreadProjectionError, Database.Service>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/ThreadProjection") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    apply: Effect.fn("ThreadProjection.apply")(function* (event: Event.Event) {
      return yield* Database.withDatabaseEffect((database) =>
        Effect.try({
          try: () => applyEvent(database, event),
          catch: (cause) => toError(cause, "apply", event.thread_id),
        }),
      )
    }),
    rebuild: Effect.fn("ThreadProjection.rebuild")(function* () {
      return yield* Database.withDatabaseEffect((database) =>
        Effect.try({
          try: () =>
            database.transaction((transaction) => {
              transaction.run(sql`delete from thread_files`)
              transaction.run(sql`delete from thread_projections`)
              transaction
                .all<PayloadRow>(sql`select payload from thread_events order by thread_id asc, sequence asc`)
                .map((row) => decodePayload(row.payload))
                .forEach((event) => applyEventRow(transaction, event))
            }),
          catch: (cause) => toError(cause, "rebuild"),
        }),
      )
    }),
    clear: Effect.fn("ThreadProjection.clear")(function* () {
      return yield* Database.withDatabaseEffect((database) =>
        Effect.try({
          try: () =>
            database.transaction((transaction) => {
              transaction.run(sql`delete from thread_files`)
              transaction.run(sql`delete from thread_projections`)
            }),
          catch: (cause) => toError(cause, "clear"),
        }).pipe(Effect.asVoid),
      )
    }),
    listThreads: Effect.fn("ThreadProjection.listThreads")(function* () {
      return yield* Database.withDatabaseEffect((database) =>
        Effect.try({
          try: () =>
            database
              .all<ThreadProjectionRow>(sql`select * from thread_projections order by updated_at desc, thread_id asc`)
              .map(rowToSummary),
          catch: (cause) => toError(cause, "listThreads"),
        }),
      )
    }),
    getThread: Effect.fn("ThreadProjection.getThread")(function* (threadId: Ids.ThreadId) {
      return yield* Database.withDatabaseEffect((database) =>
        Effect.try({
          try: () => {
            const row = database.get<ThreadProjectionRow>(
              sql`select * from thread_projections where thread_id = ${threadId}`,
            )
            if (row === undefined) return undefined
            return rowToSummary(row)
          },
          catch: (cause) => toError(cause, "getThread", threadId),
        }),
      )
    }),
    listThreadFiles: Effect.fn("ThreadProjection.listThreadFiles")(function* (input: ThreadFilesInput = {}) {
      return yield* Database.withDatabaseEffect((database) =>
        Effect.try({
          try: () => {
            const threadIds =
              input.thread_ids === undefined ? undefined : new Set(input.thread_ids.map((threadId) => String(threadId)))
            return database
              .all<ThreadFileRow>(sql`select * from thread_files order by thread_id asc, path asc`)
              .map(rowToThreadFile)
              .filter((file) => input.thread_id === undefined || file.thread_id === input.thread_id)
              .filter((file) => threadIds === undefined || threadIds.has(file.thread_id))
          },
          catch: (cause) => toError(cause, "listThreadFiles", input.thread_id),
        }),
      )
    }),
  }),
)

export const apply = Effect.fn("ThreadProjection.apply.call")(function* (event: Event.Event) {
  const projection = yield* Service
  return yield* projection.apply(event)
})

export const rebuild = Effect.fn("ThreadProjection.rebuild.call")(function* () {
  const projection = yield* Service
  return yield* projection.rebuild()
})

export const clear = Effect.fn("ThreadProjection.clear.call")(function* () {
  const projection = yield* Service
  return yield* projection.clear()
})

export const listThreads = Effect.fn("ThreadProjection.listThreads.call")(function* () {
  const projection = yield* Service
  return yield* projection.listThreads()
})

export const getThread = Effect.fn("ThreadProjection.getThread.call")(function* (threadId: Ids.ThreadId) {
  const projection = yield* Service
  return yield* projection.getThread(threadId)
})

export const listThreadFiles = Effect.fn("ThreadProjection.listThreadFiles.call")(function* (
  input: ThreadFilesInput = {},
) {
  const projection = yield* Service
  return yield* projection.listThreadFiles(input)
})

type ProjectionDatabase = Pick<Database.DrizzleDatabase, "all" | "get" | "run" | "transaction">

interface PayloadRow {
  readonly payload: string
}

interface ThreadProjectionRow {
  readonly thread_id: string
  readonly workspace_id: string
  readonly user_id: string | null
  readonly last_user_id: string | null
  readonly latest_message_id: string | null
  readonly latest_message_role: string | null
  readonly latest_message_text: string | null
  readonly latest_message_created_at: number | null
  readonly title_text: string | null
  readonly diff_additions: number
  readonly diff_modifications: number
  readonly diff_deletions: number
  readonly active_turn_id: string | null
  readonly active_turn_status: string | null
  readonly last_context_tokens: number | null
  readonly last_model: string | null
  readonly archived: number
  readonly visibility: string
  readonly last_sequence: number
  readonly created_at: number
  readonly updated_at: number
}

interface ProjectionSequenceRow {
  readonly last_sequence: number
}

interface ThreadFileRow {
  readonly thread_id: string
  readonly path: string
  readonly first_seen_at: number
  readonly last_seen_at: number
}

const applyEvent = (database: Database.DrizzleDatabase, event: Event.Event) =>
  database.transaction((transaction) => applyEventRow(transaction, event))

const applyEventRow = (database: ProjectionDatabase, event: Event.Event) => {
  const row = database.get<ProjectionSequenceRow>(
    sql`select last_sequence from thread_projections where thread_id = ${event.thread_id}`,
  )

  if (row === undefined) return applyFirstEvent(database, event)
  if (event.sequence <= row.last_sequence) return undefined
  if (event.sequence !== row.last_sequence + 1) {
    throw new ThreadProjectionError({
      message: `Expected projection sequence ${row.last_sequence + 1} for thread ${event.thread_id}, received ${event.sequence}`,
      operation: "apply",
      thread_id: event.thread_id,
    })
  }

  ThreadFileProjection.applyThreadFiles(database, event)

  switch (event.type) {
    case "message.added":
      return applyMessageAdded(database, event)
    case "tool.call.completed":
      return applyToolCallCompleted(database, event)
    case "turn.started":
      return applyTurnStarted(database, event)
    case "turn.completed":
      return applyTurnCompleted(database, event)
    case "turn.failed":
      return applyTurnFailed(database, event)
    case "model.stream.chunk":
    case "model.reasoning.delta":
      return applyModelSeen(database, event)
    case "thread.archived":
      return applyThreadArchived(database, event)
    case "thread.unarchived":
      return applyThreadUnarchived(database, event)
    case "thread.visibility.set":
      return applyThreadVisibilitySet(database, event)
    default:
      return applySequenceOnly(database, event)
  }
}

const applyFirstEvent = (database: ProjectionDatabase, event: Event.Event) => {
  if (event.type !== "thread.created") {
    throw new ThreadProjectionError({
      message: `Cannot apply ${event.type} before thread.created for thread ${event.thread_id}`,
      operation: "apply",
      thread_id: event.thread_id,
    })
  }
  if (event.sequence !== 1) {
    throw new ThreadProjectionError({
      message: `Expected first projection sequence 1 for thread ${event.thread_id}, received ${event.sequence}`,
      operation: "apply",
      thread_id: event.thread_id,
    })
  }
  return applyThreadCreated(database, event)
}

const applyThreadCreated = (database: ProjectionDatabase, event: Event.ThreadCreated) =>
  database.run(sql`
    insert into thread_projections (thread_id, workspace_id, user_id, last_user_id, title_text, archived, visibility, last_sequence, created_at, updated_at)
    values (${event.thread_id}, ${event.data.workspace_id}, ${event.data.user_id ?? null}, ${event.data.user_id ?? null}, ${event.data.title_text ?? null}, 0, 'private', ${event.sequence}, ${event.created_at}, ${event.created_at})
  `)

const applyMessageAdded = (database: ProjectionDatabase, event: Event.MessageAdded) => {
  const userId = messageUserId(event)
  return database.run(sql`
    update thread_projections set
      latest_message_id = ${event.data.message.id},
      latest_message_role = ${event.data.message.role},
      latest_message_text = ${messageText(event.data.message)},
      latest_message_created_at = ${event.data.message.created_at},
      last_user_id = case
        when ${userId} is null then last_user_id
        else ${userId}
      end,
      title_text = case
        when title_text is null then ${titleText(event.data.message) ?? null}
        else title_text
      end,
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)
}

const applyToolCallCompleted = (database: ProjectionDatabase, event: Event.ToolCallCompleted) => {
  const diff = diffStatsFromValue(event.data.result.output)
  if (isEmptyDiff(diff)) return applySequenceOnly(database, event)
  return database.run(sql`
    update thread_projections set
      diff_additions = diff_additions + ${diff.additions},
      diff_modifications = diff_modifications + ${diff.modifications},
      diff_deletions = diff_deletions + ${diff.deletions},
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)
}

const applyTurnStarted = (database: ProjectionDatabase, event: Event.TurnStarted) =>
  database.run(sql`
    update thread_projections set
      active_turn_id = ${event.turn_id},
      active_turn_status = 'active',
      last_user_id = case
        when ${event.data.user_id ?? null} is null then last_user_id
        else ${event.data.user_id ?? null}
      end,
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)

const applyTurnFailed = (database: ProjectionDatabase, event: Event.TurnFailed) =>
  database.run(sql`
    update thread_projections set
      active_turn_id = case
        when active_turn_id is null then ${event.turn_id}
        else active_turn_id
      end,
      active_turn_status = case
        when active_turn_id is null then 'failed'
        when active_turn_id = ${event.turn_id} and active_turn_status not in ('completed', 'failed') then 'failed'
        else active_turn_status
      end,
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)

const applyTurnCompleted = (database: ProjectionDatabase, event: Event.TurnCompleted) => {
  const inputTokens = event.data.usage?.input_tokens ?? null
  const model = event.data.model ?? null
  return database.run(sql`
    update thread_projections set
      active_turn_id = case
        when active_turn_id is null then ${event.turn_id}
        else active_turn_id
      end,
      active_turn_status = case
        when active_turn_id is null then 'completed'
        when active_turn_id = ${event.turn_id} and active_turn_status not in ('completed', 'failed') then 'completed'
        else active_turn_status
      end,
      last_context_tokens = case
        when active_turn_id is null and ${inputTokens} is not null then ${inputTokens}
        when active_turn_id = ${event.turn_id} and active_turn_status not in ('completed', 'failed') and ${inputTokens} is not null then ${inputTokens}
        else last_context_tokens
      end,
      last_model = case
        when active_turn_id is null and ${model} is not null then ${model}
        when active_turn_id = ${event.turn_id} and active_turn_status not in ('completed', 'failed') and ${model} is not null then ${model}
        else last_model
      end,
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)
}

const applyModelSeen = (database: ProjectionDatabase, event: Event.ModelStreamChunk | Event.ModelReasoningDelta) =>
  database.run(sql`
    update thread_projections set
      last_model = ${event.data.model},
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)

const applyThreadArchived = (database: ProjectionDatabase, event: Event.ThreadArchived) =>
  database.run(sql`
    update thread_projections set
      archived = 1,
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)

const applyThreadUnarchived = (database: ProjectionDatabase, event: Event.ThreadUnarchived) =>
  database.run(sql`
    update thread_projections set
      archived = 0,
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)

const applyThreadVisibilitySet = (database: ProjectionDatabase, event: Event.ThreadVisibilitySet) =>
  database.run(sql`
    update thread_projections set
      visibility = ${event.data.visibility},
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)

const applySequenceOnly = (database: ProjectionDatabase, event: Event.Event) =>
  database.run(sql`
    update thread_projections set
      last_sequence = ${event.sequence},
      updated_at = ${event.created_at}
    where thread_id = ${event.thread_id}
  `)

const messageText = (message: Message.Message) => Message.displayText(message)

const messageUserId = (event: Event.MessageAdded) => {
  if (event.data.message.role !== "user") return null
  const userId = event.data.message.metadata?.user_id
  return typeof userId === "string" && userId.length > 0 ? userId : null
}

const titleText = (message: Message.Message): string | undefined => {
  if (message.role !== "user") return undefined
  const text = readableText(messageText(message))
  if (text === undefined) return undefined
  return oneLine(text, 96)
}

const readableText = (value: string): string | undefined => {
  const text = value.replace(/\r\n?/g, "\n").trim()
  if (text.length === 0) return undefined
  if (isRawToolPayload(text)) return undefined
  return text
}

const oneLine = (value: string, max: number): string => {
  const text = value.replace(/\s+/g, " ").trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 3))}...`
}

const isRawToolPayload = (text: string): boolean => {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false
  return trimmed.includes('"tool_call"') || trimmed.includes('"tool_result"')
}

const rowToSummary = (row: ThreadProjectionRow): ThreadSummary => ({
  thread_id: Ids.ThreadId.make(row.thread_id),
  workspace_id: Ids.WorkspaceId.make(row.workspace_id),
  user_id: row.user_id === null ? undefined : Ids.UserId.make(row.user_id),
  last_user_id: row.last_user_id === null ? undefined : Ids.UserId.make(row.last_user_id),
  title_text: row.title_text === null ? undefined : row.title_text,
  latest_message_id: row.latest_message_id === null ? undefined : Ids.MessageId.make(row.latest_message_id),
  latest_message_role: roleOrUndefined(row.latest_message_role),
  latest_message_text: row.latest_message_text === null ? undefined : row.latest_message_text,
  latest_message_created_at: row.latest_message_created_at === null ? undefined : row.latest_message_created_at,
  diff: {
    additions: row.diff_additions,
    modifications: row.diff_modifications,
    deletions: row.diff_deletions,
  },
  active_turn_id: row.active_turn_id === null ? undefined : Ids.TurnId.make(row.active_turn_id),
  active_turn_status: turnStatusOrUndefined(row.active_turn_status),
  context_tokens: row.last_context_tokens === null ? undefined : row.last_context_tokens,
  last_model: row.last_model === null ? undefined : row.last_model,
  archived: row.archived === 1,
  visibility: visibilityOrDefault(row.visibility),
  created_at: row.created_at,
  updated_at: row.updated_at,
})

const rowToThreadFile = (row: ThreadFileRow): ThreadFile => ({
  thread_id: Ids.ThreadId.make(row.thread_id),
  path: row.path,
  first_seen_at: row.first_seen_at,
  last_seen_at: row.last_seen_at,
})

const roleOrUndefined = (value: string | null) => {
  if (value === null) return undefined
  return Schema.decodeUnknownSync(Message.Role)(value)
}

const turnStatusOrUndefined = (value: string | null) => {
  if (value === null) return undefined
  return Schema.decodeUnknownSync(TurnStatus)(value)
}

const visibilityOrDefault = (value: string | null) => {
  if (value === null) return "private"
  return Schema.decodeUnknownSync(Event.ThreadVisibility)(value)
}

const emptyDiff: ThreadDiffStats = { additions: 0, modifications: 0, deletions: 0 }

const diffStatsFromValue = (value: Common.JsonValue | undefined): ThreadDiffStats => {
  if (Array.isArray(value)) {
    return value.reduce(addNestedDiffStats, emptyDiff)
  }
  if (!isJsonObject(value)) return emptyDiff
  if (isPierreDiff(value)) return diffStatsFromFileDiff(value.file_diff)
  return Object.values(value).reduce(addNestedDiffStats, emptyDiff)
}

const diffStatsFromFileDiff = (value: Common.JsonValue | undefined): ThreadDiffStats => {
  if (!isJsonObject(value)) return emptyDiff
  return arrayField(value, "hunks")?.filter(isJsonObject).reduce(addHunkDiffStats, emptyDiff) ?? emptyDiff
}

const diffStatsFromHunk = (hunk: Record<string, Common.JsonValue>): ThreadDiffStats =>
  arrayField(hunk, "hunkContent")?.filter(isJsonObject).reduce(addHunkContentDiffStats, emptyDiff) ?? emptyDiff

const addNestedDiffStats = (total: ThreadDiffStats, item: Common.JsonValue): ThreadDiffStats =>
  addDiffStats(total, diffStatsFromValue(item))

const addHunkDiffStats = (total: ThreadDiffStats, hunk: Record<string, Common.JsonValue>): ThreadDiffStats =>
  addDiffStats(total, diffStatsFromHunk(hunk))

const addHunkContentDiffStats = (
  total: ThreadDiffStats,
  content: Record<string, Common.JsonValue>,
): ThreadDiffStats => {
  if (content.type !== "change") return total
  const additions = numberField(content, "additions") ?? 0
  const deletions = numberField(content, "deletions") ?? 0
  return addDiffStats(total, { additions, modifications: Math.min(additions, deletions), deletions })
}

const addDiffStats = (left: ThreadDiffStats, right: ThreadDiffStats): ThreadDiffStats => ({
  additions: left.additions + right.additions,
  modifications: left.modifications + right.modifications,
  deletions: left.deletions + right.deletions,
})

const isEmptyDiff = (diff: ThreadDiffStats): boolean =>
  diff.additions === 0 && diff.modifications === 0 && diff.deletions === 0

const isPierreDiff = (value: Record<string, Common.JsonValue>) =>
  value.kind === "diff" && value.renderer === "@pierre/diffs"

const isJsonObject = (value: Common.JsonValue | undefined): value is Record<string, Common.JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const arrayField = (
  value: Record<string, Common.JsonValue>,
  key: string,
): ReadonlyArray<Common.JsonValue> | undefined => (Array.isArray(value[key]) ? value[key] : undefined)

const numberField = (value: Record<string, Common.JsonValue>, key: string): number | undefined =>
  typeof value[key] === "number" ? value[key] : undefined

const toError = (cause: unknown, operation: string, threadId?: Ids.ThreadId) => {
  if (cause instanceof ThreadProjectionError) return cause
  return new ThreadProjectionError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    thread_id: threadId,
  })
}
