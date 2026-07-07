import { Event, Ids, Message } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import * as Database from "./database"
import { ThreadProjectionError } from "./thread-projection-error"
import * as ProjectionWriter from "./thread-projection-writer"

export { ThreadProjectionError } from "./thread-projection-error"

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
  visibility: Event.ThreadVisibilityDefaulted,
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
          try: () => ProjectionWriter.applyEvent(database, event),
          catch: (cause) => toError(cause, "apply", event.thread_id),
        }),
      )
    }),
    rebuild: Effect.fn("ThreadProjection.rebuild")(function* () {
      return yield* Database.withDatabaseEffect((database) =>
        Effect.try({
          try: () => ProjectionWriter.rebuildProjection(database),
          catch: (cause) => toError(cause, "rebuild"),
        }),
      )
    }),
    clear: Effect.fn("ThreadProjection.clear")(function* () {
      return yield* Database.withDatabaseEffect((database) =>
        Effect.try({
          try: () => ProjectionWriter.clearProjection(database),
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

interface ThreadFileRow {
  readonly thread_id: string
  readonly path: string
  readonly first_seen_at: number
  readonly last_seen_at: number
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

const visibilityOrDefault = (value: string | null | undefined) => {
  if (value == null) return "private"
  return Schema.decodeUnknownSync(Event.ThreadVisibility)(value)
}

const toError = (cause: unknown, operation: string, threadId?: Ids.ThreadId) => {
  if (cause instanceof ThreadProjectionError) return cause
  return new ThreadProjectionError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    thread_id: threadId,
  })
}
