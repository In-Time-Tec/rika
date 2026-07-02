import { Codec, Event, Ids } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import * as Database from "./database"
import { thread_events } from "./schema"

const EventPayload = Schema.fromJsonString(Event.Event)

export class ThreadEventLogError extends Schema.TaggedErrorClass<ThreadEventLogError>()("ThreadEventLogError", {
  message: Schema.String,
  operation: Schema.String,
  thread_id: Schema.optional(Ids.ThreadId),
  event_id: Schema.optional(Ids.EventId),
}) {}

export interface ReadThreadInput {
  readonly thread_id: Ids.ThreadId
  readonly after_sequence?: number
  readonly limit?: number
}

export interface ReadThreadTailInput {
  readonly thread_id: Ids.ThreadId
  readonly limit: number
}

export type AppendIfAbsentResult =
  | { readonly status: "inserted"; readonly event: Event.Event }
  | { readonly status: "skipped"; readonly event: Event.Event }

export interface Interface {
  readonly append: (
    event: Event.Event,
  ) => Effect.Effect<Event.Event, Database.DatabaseError | ThreadEventLogError, Database.Service>
  readonly appendIfAbsent: (
    event: Event.Event,
  ) => Effect.Effect<AppendIfAbsentResult, Database.DatabaseError | ThreadEventLogError, Database.Service>
  readonly readThread: (
    input: ReadThreadInput,
  ) => Effect.Effect<ReadonlyArray<Event.Event>, Database.DatabaseError | ThreadEventLogError, Database.Service>
  readonly readThreadTail: (
    input: ReadThreadTailInput,
  ) => Effect.Effect<ReadonlyArray<Event.Event>, Database.DatabaseError | ThreadEventLogError, Database.Service>
  readonly readAll: () => Effect.Effect<
    ReadonlyArray<Event.Event>,
    Database.DatabaseError | ThreadEventLogError,
    Database.Service
  >
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/ThreadEventLog") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    append: Effect.fn("ThreadEventLog.append")(function* (event: Event.Event) {
      return yield* Database.withDatabaseEffect((database) =>
        Effect.try({
          try: () => appendEvent(database, event),
          catch: (cause) => toError(cause, "append", event),
        }),
      )
    }),
    appendIfAbsent: Effect.fn("ThreadEventLog.appendIfAbsent")(function* (event: Event.Event) {
      return yield* Database.withDatabaseEffect((database) =>
        Effect.try({
          try: () => appendEventIfAbsent(database, event),
          catch: (cause) => toError(cause, "appendIfAbsent", event),
        }),
      )
    }),
    readThread: Effect.fn("ThreadEventLog.readThread")(function* (input: ReadThreadInput) {
      return yield* Database.withDatabaseEffect((database) =>
        Effect.try({
          try: () => readThreadRows(database, input).map((row) => decodePayload(row.payload)),
          catch: (cause) => toError(cause, "readThread"),
        }),
      )
    }),
    readThreadTail: Effect.fn("ThreadEventLog.readThreadTail")(function* (input: ReadThreadTailInput) {
      return yield* Database.withDatabaseEffect((database) =>
        Effect.try({
          try: () => readThreadTailRows(database, input).map((row) => decodePayload(row.payload)),
          catch: (cause) => toError(cause, "readThreadTail"),
        }),
      )
    }),
    readAll: Effect.fn("ThreadEventLog.readAll")(function* () {
      return yield* Database.withDatabaseEffect((database) =>
        Effect.try({
          try: () =>
            database
              .all<PayloadRow>(sql`select payload from thread_events order by thread_id asc, sequence asc`)
              .map((row) => decodePayload(row.payload)),
          catch: (cause) => toError(cause, "readAll"),
        }),
      )
    }),
  }),
)

export const append = Effect.fn("ThreadEventLog.append.call")(function* (event: Event.Event) {
  const eventLog = yield* Service
  return yield* eventLog.append(event)
})

export const appendIfAbsent = Effect.fn("ThreadEventLog.appendIfAbsent.call")(function* (event: Event.Event) {
  const eventLog = yield* Service
  return yield* eventLog.appendIfAbsent(event)
})

export const readThread = Effect.fn("ThreadEventLog.readThread.call")(function* (input: ReadThreadInput) {
  const eventLog = yield* Service
  return yield* eventLog.readThread(input)
})

export const readThreadTail = Effect.fn("ThreadEventLog.readThreadTail.call")(function* (input: ReadThreadTailInput) {
  const eventLog = yield* Service
  return yield* eventLog.readThreadTail(input)
})

export const readAll = Effect.fn("ThreadEventLog.readAll.call")(function* () {
  const eventLog = yield* Service
  return yield* eventLog.readAll()
})

type EventLogDatabase = Pick<Database.DrizzleDatabase, "all" | "get" | "insert" | "run" | "transaction">

interface PayloadRow {
  readonly payload: string
}

interface SequenceRow {
  readonly sequence: number | null
}

interface ChangesRow {
  readonly changes: number
}

const appendEvent = (database: Database.DrizzleDatabase, event: Event.Event) =>
  database.transaction((transaction) => appendEventRow(transaction, event))

const appendEventIfAbsent = (database: Database.DrizzleDatabase, event: Event.Event): AppendIfAbsentResult =>
  database.transaction((transaction) => {
    const existingBySequence = eventByThreadSequence(transaction, event.thread_id, event.sequence)
    if (existingBySequence !== undefined) {
      requireMatchingExisting(existingBySequence.payload, event, "appendIfAbsent")
      return { status: "skipped", event }
    }
    const existingById = eventById(transaction, event.id)
    if (existingById !== undefined) requireMatchingExisting(existingById.payload, event, "appendIfAbsent")
    const latestValue = latestSequence(transaction, event.thread_id)?.sequence ?? 0
    requireNextSequence(latestValue + 1, event, "appendIfAbsent")
    insertEventRowIfAbsent(transaction, event)
    const changes = transaction.get<ChangesRow>(sql`select changes() as changes`)
    if (changes?.changes === 1) return { status: "inserted", event }
    const insertedBySequence = eventByThreadSequence(transaction, event.thread_id, event.sequence)
    if (insertedBySequence !== undefined) {
      requireMatchingExisting(insertedBySequence.payload, event, "appendIfAbsent")
      return { status: "skipped", event }
    }
    const insertedById = eventById(transaction, event.id)
    if (insertedById !== undefined) requireMatchingExisting(insertedById.payload, event, "appendIfAbsent")
    throw new ThreadEventLogError({
      message: `Event ${event.id} was not inserted`,
      operation: "appendIfAbsent",
      thread_id: event.thread_id,
      event_id: event.id,
    })
  })

const readThreadRows = (database: Database.DrizzleDatabase, input: ReadThreadInput) => {
  const afterSequence = input.after_sequence ?? 0
  if (input.limit === undefined) {
    return database.all<PayloadRow>(
      sql`select payload from thread_events where thread_id = ${input.thread_id} and sequence > ${afterSequence} order by sequence asc`,
    )
  }
  return database.all<PayloadRow>(
    sql`select payload from thread_events where thread_id = ${input.thread_id} and sequence > ${afterSequence} order by sequence asc limit ${input.limit}`,
  )
}

const readThreadTailRows = (database: Database.DrizzleDatabase, input: ReadThreadTailInput) =>
  database
    .all<PayloadRow>(
      sql`select payload from thread_events where thread_id = ${input.thread_id} order by sequence desc limit ${input.limit}`,
    )
    .reverse()

const appendEventRow = (database: EventLogDatabase, event: Event.Event) => {
  const existing = database.get<PayloadRow>(sql`select payload from thread_events where id = ${event.id}`)
  if (existing !== undefined) return requireMatchingExisting(existing.payload, event)

  const latest = latestSequence(database, event.thread_id)
  requireNextSequence((latest?.sequence ?? 0) + 1, event, "append")

  const references = Event.references(event)
  database
    .insert(thread_events)
    .values({
      id: event.id,
      thread_id: event.thread_id,
      turn_id: event.turn_id,
      sequence: event.sequence,
      version: event.version,
      type: event.type,
      payload: encodePayload(event),
      message_id: references.message_id,
      tool_call_id: references.tool_call_id,
      artifact_id: references.artifact_id,
      created_at: event.created_at,
    })
    .run()
  return event
}

const insertEventRowIfAbsent = (database: EventLogDatabase, event: Event.Event) => {
  const references = Event.references(event)
  database.run(sql`
    insert or ignore into thread_events (
      id,
      thread_id,
      turn_id,
      sequence,
      version,
      type,
      payload,
      message_id,
      tool_call_id,
      artifact_id,
      created_at
    ) values (
      ${event.id},
      ${event.thread_id},
      ${event.turn_id ?? null},
      ${event.sequence},
      ${event.version},
      ${event.type},
      ${encodePayload(event)},
      ${references.message_id ?? null},
      ${references.tool_call_id ?? null},
      ${references.artifact_id ?? null},
      ${event.created_at}
    )
  `)
}

const latestSequence = (database: EventLogDatabase, threadId: Ids.ThreadId) =>
  database.get<SequenceRow>(sql`select max(sequence) as sequence from thread_events where thread_id = ${threadId}`)

const eventByThreadSequence = (database: EventLogDatabase, threadId: Ids.ThreadId, sequence: number) =>
  database.get<PayloadRow>(
    sql`select payload from thread_events where thread_id = ${threadId} and sequence = ${sequence} limit 1`,
  )

const eventById = (database: EventLogDatabase, eventId: Ids.EventId) =>
  database.get<PayloadRow>(sql`select payload from thread_events where id = ${eventId} limit 1`)

const requireNextSequence = (nextSequence: number, event: Event.Event, operation: string) => {
  if (event.sequence === nextSequence) return
  throw new ThreadEventLogError({
    message: `Expected sequence ${nextSequence} for thread ${event.thread_id}, received ${event.sequence}`,
    operation,
    thread_id: event.thread_id,
    event_id: event.id,
  })
}

const requireMatchingExisting = (payload: string, event: Event.Event, operation = "append") => {
  const existing = decodePayload(payload)
  if (payload === encodePayload(event)) return existing
  throw new ThreadEventLogError({
    message: `Event ${event.id} already exists with different payload`,
    operation,
    thread_id: event.thread_id,
    event_id: event.id,
  })
}

export const encodePayload = (event: Event.Event) => Schema.encodeSync(EventPayload)(Codec.decode(Event.Event)(event))
export const decodePayload = (payload: string) => Schema.decodeUnknownSync(EventPayload)(payload)

const toError = (cause: unknown, operation: string, event?: Event.Event) => {
  if (cause instanceof ThreadEventLogError) return cause
  return new ThreadEventLogError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    thread_id: event?.thread_id,
    event_id: event?.id,
  })
}
