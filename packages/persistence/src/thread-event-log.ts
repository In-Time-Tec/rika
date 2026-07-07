import { SecretRedactor } from "@rika/core"
import { Common, ErrorEnvelope, Event, Ids, Message, Tool } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import * as Database from "./database"
import { thread_events } from "./schema"
import { decodePayload, encodePayload } from "./thread-event-codec"
import { ThreadProjectionError } from "./thread-projection-error"
import * as ProjectionWriter from "./thread-projection-writer"

export { decodePayload, encodePayload } from "./thread-event-codec"

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
  readonly appendAndProject: (
    event: Event.Event,
  ) => Effect.Effect<
    Event.Event,
    Database.DatabaseError | ThreadEventLogError | ThreadProjectionError,
    Database.Service
  >
  readonly appendMany: (
    events: ReadonlyArray<Event.Event>,
  ) => Effect.Effect<ReadonlyArray<Event.Event>, Database.DatabaseError | ThreadEventLogError, Database.Service>
  readonly appendManyAndProject: (
    events: ReadonlyArray<Event.Event>,
  ) => Effect.Effect<
    ReadonlyArray<Event.Event>,
    Database.DatabaseError | ThreadEventLogError | ThreadProjectionError,
    Database.Service
  >
  readonly appendIfAbsent: (
    event: Event.Event,
  ) => Effect.Effect<AppendIfAbsentResult, Database.DatabaseError | ThreadEventLogError, Database.Service>
  readonly appendIfAbsentAndProject: (
    event: Event.Event,
  ) => Effect.Effect<
    AppendIfAbsentResult,
    Database.DatabaseError | ThreadEventLogError | ThreadProjectionError,
    Database.Service
  >
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

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const redactor = Option.getOrUndefined(yield* Effect.serviceOption(SecretRedactor.Service))
    const redactForAppend = (event: Event.Event) => redactEvent(redactor, event)
    return Service.of({
      append: Effect.fn("ThreadEventLog.append")(function* (event: Event.Event) {
        const redacted = redactForAppend(event)
        return yield* Database.withDatabaseEffect((database) =>
          Effect.try({
            try: () => appendEvent(database, redacted),
            catch: (cause) => toEventLogError(cause, "append", redacted),
          }),
        )
      }),
      appendAndProject: Effect.fn("ThreadEventLog.appendAndProject")(function* (event: Event.Event) {
        const redacted = redactForAppend(event)
        return yield* Database.withDatabaseEffect((database) =>
          Effect.try({
            try: () => appendAndProjectEvent(database, redacted),
            catch: (cause) => toAppendAndProjectError(cause, "appendAndProject", redacted),
          }),
        )
      }),
      appendMany: Effect.fn("ThreadEventLog.appendMany")(function* (events: ReadonlyArray<Event.Event>) {
        const redacted = events.map(redactForAppend)
        return yield* Database.withDatabaseEffect((database) =>
          Effect.try({
            try: () => appendEvents(database, redacted),
            catch: (cause) => toEventLogError(cause, "appendMany", redacted[0]),
          }),
        )
      }),
      appendManyAndProject: Effect.fn("ThreadEventLog.appendManyAndProject")(function* (
        events: ReadonlyArray<Event.Event>,
      ) {
        const redacted = events.map(redactForAppend)
        return yield* Database.withDatabaseEffect((database) =>
          Effect.try({
            try: () => appendManyAndProjectEvents(database, redacted),
            catch: (cause) => toAppendAndProjectError(cause, "appendManyAndProject", redacted[0]),
          }),
        )
      }),
      appendIfAbsent: Effect.fn("ThreadEventLog.appendIfAbsent")(function* (event: Event.Event) {
        const redacted = redactForAppend(event)
        return yield* Database.withDatabaseEffect((database) =>
          Effect.try({
            try: () => appendEventIfAbsent(database, redacted),
            catch: (cause) => toEventLogError(cause, "appendIfAbsent", redacted),
          }),
        )
      }),
      appendIfAbsentAndProject: Effect.fn("ThreadEventLog.appendIfAbsentAndProject")(function* (event: Event.Event) {
        const redacted = redactForAppend(event)
        return yield* Database.withDatabaseEffect((database) =>
          Effect.try({
            try: () => appendIfAbsentAndProjectEvent(database, redacted),
            catch: (cause) => toAppendAndProjectError(cause, "appendIfAbsentAndProject", redacted),
          }),
        )
      }),
      readThread: Effect.fn("ThreadEventLog.readThread")(function* (input: ReadThreadInput) {
        return yield* Database.withDatabaseEffect((database) =>
          Effect.try({
            try: () => readThreadRows(database, input).map((row) => decodePayload(row.payload)),
            catch: (cause) => toEventLogError(cause, "readThread"),
          }),
        )
      }),
      readThreadTail: Effect.fn("ThreadEventLog.readThreadTail")(function* (input: ReadThreadTailInput) {
        return yield* Database.withDatabaseEffect((database) =>
          Effect.try({
            try: () => readThreadTailRows(database, input).map((row) => decodePayload(row.payload)),
            catch: (cause) => toEventLogError(cause, "readThreadTail"),
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
            catch: (cause) => toEventLogError(cause, "readAll"),
          }),
        )
      }),
    })
  }),
)

export const append = Effect.fn("ThreadEventLog.append.call")(function* (event: Event.Event) {
  const eventLog = yield* Service
  return yield* eventLog.append(event)
})

export const appendAndProject = Effect.fn("ThreadEventLog.appendAndProject.call")(function* (event: Event.Event) {
  const eventLog = yield* Service
  return yield* eventLog.appendAndProject(event)
})

export const appendMany = Effect.fn("ThreadEventLog.appendMany.call")(function* (events: ReadonlyArray<Event.Event>) {
  const eventLog = yield* Service
  return yield* eventLog.appendMany(events)
})

export const appendManyAndProject = Effect.fn("ThreadEventLog.appendManyAndProject.call")(function* (
  events: ReadonlyArray<Event.Event>,
) {
  const eventLog = yield* Service
  return yield* eventLog.appendManyAndProject(events)
})

export const appendIfAbsent = Effect.fn("ThreadEventLog.appendIfAbsent.call")(function* (event: Event.Event) {
  const eventLog = yield* Service
  return yield* eventLog.appendIfAbsent(event)
})

export const appendIfAbsentAndProject = Effect.fn("ThreadEventLog.appendIfAbsentAndProject.call")(function* (
  event: Event.Event,
) {
  const eventLog = yield* Service
  return yield* eventLog.appendIfAbsentAndProject(event)
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

type EventLogDatabase = Pick<Database.DrizzleDatabase, "all" | "get" | "insert" | "run">

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

const appendAndProjectEvent = (database: Database.DrizzleDatabase, event: Event.Event) =>
  database.transaction((transaction) => {
    const appended = appendEventRow(transaction, event, "appendAndProject")
    ProjectionWriter.applyEventRow(transaction, appended)
    return appended
  })

const appendEvents = (database: Database.DrizzleDatabase, events: ReadonlyArray<Event.Event>) =>
  database.transaction((transaction) => events.map((event) => appendEventRow(transaction, event, "appendMany")))

const appendManyAndProjectEvents = (database: Database.DrizzleDatabase, events: ReadonlyArray<Event.Event>) =>
  database.transaction((transaction) =>
    events.map((event) => {
      const appended = appendEventRow(transaction, event, "appendManyAndProject")
      ProjectionWriter.applyEventRow(transaction, appended)
      return appended
    }),
  )

const appendEventIfAbsent = (database: Database.DrizzleDatabase, event: Event.Event): AppendIfAbsentResult =>
  database.transaction((transaction) => appendEventIfAbsentRow(transaction, event, "appendIfAbsent"))

const appendIfAbsentAndProjectEvent = (database: Database.DrizzleDatabase, event: Event.Event): AppendIfAbsentResult =>
  database.transaction((transaction) => {
    const result = appendEventIfAbsentRow(transaction, event, "appendIfAbsentAndProject")
    ProjectionWriter.applyEventRow(transaction, result.event)
    return result
  })

const appendEventIfAbsentRow = (
  database: EventLogDatabase,
  event: Event.Event,
  operation: string,
): AppendIfAbsentResult => {
  const existingBySequence = eventByThreadSequence(database, event.thread_id, event.sequence)
  if (existingBySequence !== undefined) {
    const existing = requireMatchingExisting(existingBySequence.payload, event, operation)
    return { status: "skipped", event: existing }
  }
  const existingById = eventById(database, event.id)
  if (existingById !== undefined) requireMatchingExisting(existingById.payload, event, operation)
  const latestValue = latestSequence(database, event.thread_id)?.sequence ?? 0
  requireNextSequence(latestValue + 1, event, operation)
  insertEventRowIfAbsent(database, event)
  const changes = database.get<ChangesRow>(sql`select changes() as changes`)
  if (changes?.changes === 1) return { status: "inserted", event }
  const insertedBySequence = eventByThreadSequence(database, event.thread_id, event.sequence)
  if (insertedBySequence !== undefined) {
    const existing = requireMatchingExisting(insertedBySequence.payload, event, operation)
    return { status: "skipped", event: existing }
  }
  const insertedById = eventById(database, event.id)
  if (insertedById !== undefined) {
    const existing = requireMatchingExisting(insertedById.payload, event, operation)
    return { status: "skipped", event: existing }
  }
  throw new ThreadEventLogError({
    message: `Event ${event.id} was not inserted`,
    operation,
    thread_id: event.thread_id,
    event_id: event.id,
  })
}

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

const appendEventRow = (database: EventLogDatabase, event: Event.Event, operation = "append") => {
  const existing = database.get<PayloadRow>(sql`select payload from thread_events where id = ${event.id}`)
  if (existing !== undefined) return requireMatchingExisting(existing.payload, event, operation)

  const latest = latestSequence(database, event.thread_id)
  requireNextSequence((latest?.sequence ?? 0) + 1, event, operation)

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

const redactEvent = (redactor: SecretRedactor.Interface | undefined, event: Event.Event): Event.Event => {
  if (redactor === undefined) return event
  switch (event.type) {
    case "thread.created":
      return {
        ...event,
        data: {
          ...event.data,
          ...(event.data.title_text === undefined ? {} : { title_text: redactor.redact(event.data.title_text) }),
        },
      }
    case "turn.started":
    case "context.pruned":
    case "turn.completed":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.visibility.set":
      return event
    case "message.added":
      return { ...event, data: { message: redactMessage(redactor, event.data.message) } }
    case "model.stream.chunk":
    case "model.reasoning.delta":
      return { ...event, data: { ...event.data, text: redactor.redact(event.data.text) } }
    case "context.resolved":
      return {
        ...event,
        data: {
          ...event.data,
          entries: event.data.entries.map((entry) => ({
            ...entry,
            ...(entry.content === undefined ? {} : { content: redactor.redact(entry.content) }),
            ...(entry.thread_reference === undefined
              ? {}
              : { thread_reference: redactor.redact(entry.thread_reference) }),
            ...(entry.metadata === undefined ? {} : { metadata: redactMetadata(redactor, entry.metadata) }),
          })),
          rendered: redactor.redact(event.data.rendered),
          ...(event.data.metadata === undefined ? {} : { metadata: redactor.redactJson(event.data.metadata) }),
        },
      }
    case "context.compacted":
      return { ...event, data: { ...event.data, summary: redactor.redact(event.data.summary) } }
    case "skill.loaded":
      return {
        ...event,
        data: {
          ...event.data,
          description: redactor.redact(event.data.description),
          source: redactor.redact(event.data.source),
          skill_file: redactor.redact(event.data.skill_file),
          resource_paths: event.data.resource_paths.map((path) => redactor.redact(path)),
        },
      }
    case "subagent.completed":
      return {
        ...event,
        data: {
          ...event.data,
          summary: redactor.redact(event.data.summary),
          evidence: event.data.evidence.map((item) => redactor.redact(item)),
        },
      }
    case "tool.call.input.started":
      return event
    case "tool.call.input.delta":
      return { ...event, data: { ...event.data, text: redactor.redact(event.data.text) } }
    case "tool.call.input.ended":
      return { ...event, data: { ...event.data, input_text: redactor.redact(event.data.input_text) } }
    case "tool.call.requested":
      return { ...event, data: { call: redactCall(redactor, event.data.call) } }
    case "tool.call.completed":
      return { ...event, data: { result: redactResult(redactor, event.data.result) } }
    case "artifact.created":
      return {
        ...event,
        data: {
          artifact: {
            ...event.data.artifact,
            ...(event.data.artifact.title === undefined ? {} : { title: redactor.redact(event.data.artifact.title) }),
            content: redactor.redactJson(event.data.artifact.content),
            ...(event.data.artifact.metadata === undefined
              ? {}
              : { metadata: redactMetadata(redactor, event.data.artifact.metadata) }),
          },
        },
      }
    case "turn.failed":
      return { ...event, data: { error: redactEnvelope(redactor, event.data.error) } }
  }
  const exhaustive: never = event
  return exhaustive
}

const redactMessage = (redactor: SecretRedactor.Interface, message: Message.Message): Message.Message => ({
  ...message,
  content: message.content.map((part) => redactContentPart(redactor, part)),
  ...(message.metadata === undefined ? {} : { metadata: redactMetadata(redactor, message.metadata) }),
})

const redactContentPart = (redactor: SecretRedactor.Interface, part: Message.ContentPart): Message.ContentPart => {
  switch (part.type) {
    case "text":
      return {
        ...part,
        text: redactor.redact(part.text),
        ...(part.metadata === undefined ? {} : { metadata: redactMetadata(redactor, part.metadata) }),
      }
    case "tool-call":
      return { ...part, call: redactCall(redactor, part.call) }
    case "tool-result":
      return { ...part, result: redactResult(redactor, part.result) }
    case "image":
      return {
        ...part,
        ...(part.filename === undefined ? {} : { filename: redactor.redact(part.filename) }),
        ...(part.metadata === undefined ? {} : { metadata: redactMetadata(redactor, part.metadata) }),
      }
    case "file-reference":
      return {
        ...part,
        path: redactor.redact(part.path),
        ...(part.metadata === undefined ? {} : { metadata: redactMetadata(redactor, part.metadata) }),
      }
  }
  const exhaustive: never = part
  return exhaustive
}

const redactCall = (redactor: SecretRedactor.Interface, call: Tool.Call): Tool.Call => ({
  ...call,
  input: redactor.redactJson(call.input),
  ...(call.metadata === undefined ? {} : { metadata: redactMetadata(redactor, call.metadata) }),
})

const redactResult = (redactor: SecretRedactor.Interface, result: Tool.Result): Tool.Result => ({
  ...result,
  ...(result.output === undefined ? {} : { output: redactor.redactJson(result.output) }),
  ...(result.error === undefined ? {} : { error: redactEnvelope(redactor, result.error) }),
  ...(result.metadata === undefined ? {} : { metadata: redactMetadata(redactor, result.metadata) }),
})

const redactEnvelope = (
  redactor: SecretRedactor.Interface,
  envelope: ErrorEnvelope.Envelope,
): ErrorEnvelope.Envelope => ({
  ...envelope,
  message: redactor.redact(envelope.message),
  ...(envelope.details === undefined ? {} : { details: redactor.redactJson(envelope.details) }),
})

const redactMetadata = (redactor: SecretRedactor.Interface, metadata: Common.Metadata): Common.Metadata =>
  Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, redactor.redactJson(value)]))

const toAppendAndProjectError = (cause: unknown, operation: string, event?: Event.Event) => {
  if (cause instanceof ThreadEventLogError) return cause
  if (cause instanceof ThreadProjectionError) return cause
  return toEventLogError(cause, operation, event)
}

const toEventLogError = (cause: unknown, operation: string, event?: Event.Event) => {
  if (cause instanceof ThreadEventLogError) return cause
  return new ThreadEventLogError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    thread_id: event?.thread_id,
    event_id: event?.id,
  })
}
