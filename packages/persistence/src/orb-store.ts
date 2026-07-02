import { IdGenerator, Time } from "@rika/core"
import { Common, Ids, Orb } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import * as Database from "./database"
import { orbs } from "./schema"

export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Schema.Struct({
  thread_id: Ids.ThreadId,
  project_id: Ids.ProjectId,
  sandbox_id: Schema.String,
  base_commit: Schema.String,
  endpoint_url: Schema.String,
  token: Schema.String,
}).annotate({ identifier: "Rika.Persistence.OrbStore.CreateInput" })

export interface EndpointInput extends Schema.Schema.Type<typeof EndpointInput> {}
export const EndpointInput = Schema.Struct({
  endpoint_url: Schema.String,
  token: Schema.String,
}).annotate({ identifier: "Rika.Persistence.OrbStore.EndpointInput" })

export interface ListFilter extends Schema.Schema.Type<typeof ListFilter> {}
export const ListFilter = Schema.Struct({
  status: Schema.optional(Orb.OrbStatus),
}).annotate({ identifier: "Rika.Persistence.OrbStore.ListFilter" })

export const ErrorReason = Schema.Literals(["not_found", "invalid_transition", "unique_thread", "database"]).annotate({
  identifier: "Rika.Persistence.OrbStore.ErrorReason",
})
export type ErrorReason = typeof ErrorReason.Type

export class OrbStoreError extends Schema.TaggedErrorClass<OrbStoreError>()("OrbStoreError", {
  message: Schema.String,
  operation: Schema.String,
  reason: ErrorReason,
  orb_id: Schema.optional(Ids.OrbId),
  thread_id: Schema.optional(Ids.ThreadId),
  status: Schema.optional(Orb.OrbStatus),
}) {}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Orb.OrbRecord, Database.DatabaseError | OrbStoreError>
  readonly get: (orbId: Ids.OrbId) => Effect.Effect<Orb.OrbRecord | undefined, Database.DatabaseError | OrbStoreError>
  readonly getByThread: (
    threadId: Ids.ThreadId,
  ) => Effect.Effect<Orb.OrbRecord | undefined, Database.DatabaseError | OrbStoreError>
  readonly list: (
    filter?: ListFilter,
  ) => Effect.Effect<ReadonlyArray<Orb.OrbRecord>, Database.DatabaseError | OrbStoreError>
  readonly setStatus: (
    orbId: Ids.OrbId,
    status: Orb.OrbStatus,
  ) => Effect.Effect<Orb.OrbRecord, Database.DatabaseError | OrbStoreError>
  readonly setEndpoint: (
    orbId: Ids.OrbId,
    input: EndpointInput,
  ) => Effect.Effect<Orb.OrbRecord, Database.DatabaseError | OrbStoreError>
  readonly endpointCredentials: (
    orbId: Ids.OrbId,
  ) => Effect.Effect<EndpointInput | undefined, Database.DatabaseError | OrbStoreError>
  readonly touch: (orbId: Ids.OrbId) => Effect.Effect<Orb.OrbRecord, Database.DatabaseError | OrbStoreError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/OrbStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const databaseService = yield* Database.Service
    const idGenerator = yield* IdGenerator.Service
    const time = yield* Time.Service
    return Service.of({
      create: Effect.fn("OrbStore.create")(function* (input: CreateInput) {
        const orbId = Ids.OrbId.make(yield* idGenerator.next("orb"))
        const now = yield* time.nowMillis
        const record: Orb.OrbRecord = {
          orb_id: orbId,
          thread_id: input.thread_id,
          project_id: input.project_id,
          sandbox_id: input.sandbox_id,
          status: "provisioning",
          base_commit: input.base_commit,
          endpoint_url: input.endpoint_url,
          created_at: now,
          last_active_at: now,
        }
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => {
              database.insert(orbs).values(recordToRow(record, input.token)).run()
              return record
            },
            catch: (cause) => toError(cause, "create", { orbId, threadId: input.thread_id }),
          }),
        )
      }),
      get: Effect.fn("OrbStore.get")(function* (orbId: Ids.OrbId) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => rowToRecord(database.get<OrbRecordRow>(recordByOrbIdQuery(orbId))),
            catch: (cause) => toError(cause, "get", { orbId }),
          }),
        )
      }),
      getByThread: Effect.fn("OrbStore.getByThread")(function* (threadId: Ids.ThreadId) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => rowToRecord(database.get<OrbRecordRow>(recordByThreadIdQuery(threadId))),
            catch: (cause) => toError(cause, "getByThread", { threadId }),
          }),
        )
      }),
      list: Effect.fn("OrbStore.list")(function* (filter: ListFilter = {}) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => listRows(database, filter).map(rowToExistingRecord),
            catch: (cause) => toError(cause, "list"),
          }),
        )
      }),
      setStatus: Effect.fn("OrbStore.setStatus")(function* (orbId: Ids.OrbId, status: Orb.OrbStatus) {
        const now = yield* time.nowMillis
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () =>
              database.transaction((transaction) => {
                const existing = requireOrb(transaction, orbId, "setStatus")
                if (!canTransition(existing.status, status)) {
                  throw new OrbStoreError({
                    message: `Invalid orb status transition ${existing.status} -> ${status}`,
                    operation: "setStatus",
                    reason: "invalid_transition",
                    orb_id: orbId,
                    status,
                  })
                }
                transaction.run(
                  sql`update orbs set status = ${status}, last_active_at = ${now} where orb_id = ${orbId}`,
                )
                return { ...existing, status, last_active_at: now }
              }),
            catch: (cause) => toError(cause, "setStatus", { orbId, status }),
          }),
        )
      }),
      setEndpoint: Effect.fn("OrbStore.setEndpoint")(function* (orbId: Ids.OrbId, input: EndpointInput) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () =>
              database.transaction((transaction) => {
                const existing = requireOrb(transaction, orbId, "setEndpoint")
                transaction.run(
                  sql`update orbs set endpoint_url = ${input.endpoint_url}, token = ${input.token} where orb_id = ${orbId}`,
                )
                return { ...existing, endpoint_url: input.endpoint_url }
              }),
            catch: (cause) => toError(cause, "setEndpoint", { orbId }),
          }),
        )
      }),
      endpointCredentials: Effect.fn("OrbStore.endpointCredentials")(function* (orbId: Ids.OrbId) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () =>
              rowToEndpoint(
                database.get<EndpointRow>(sql`select endpoint_url, token from orbs where orb_id = ${orbId} limit 1`),
              ),
            catch: (cause) => toError(cause, "endpointCredentials", { orbId }),
          }),
        )
      }),
      touch: Effect.fn("OrbStore.touch")(function* (orbId: Ids.OrbId) {
        const now = yield* time.nowMillis
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () =>
              database.transaction((transaction) => {
                const existing = requireOrb(transaction, orbId, "touch")
                transaction.run(sql`update orbs set last_active_at = ${now} where orb_id = ${orbId}`)
                return { ...existing, last_active_at: now }
              }),
            catch: (cause) => toError(cause, "touch", { orbId }),
          }),
        )
      }),
    })
  }),
)

export const create = Effect.fn("OrbStore.create.call")(function* (input: CreateInput) {
  const store = yield* Service
  return yield* store.create(input)
})

export const get = Effect.fn("OrbStore.get.call")(function* (orbId: Ids.OrbId) {
  const store = yield* Service
  return yield* store.get(orbId)
})

export const getByThread = Effect.fn("OrbStore.getByThread.call")(function* (threadId: Ids.ThreadId) {
  const store = yield* Service
  return yield* store.getByThread(threadId)
})

export const list = Effect.fn("OrbStore.list.call")(function* (filter?: ListFilter) {
  const store = yield* Service
  return yield* store.list(filter)
})

export const setStatus = Effect.fn("OrbStore.setStatus.call")(function* (orbId: Ids.OrbId, status: Orb.OrbStatus) {
  const store = yield* Service
  return yield* store.setStatus(orbId, status)
})

export const setEndpoint = Effect.fn("OrbStore.setEndpoint.call")(function* (orbId: Ids.OrbId, input: EndpointInput) {
  const store = yield* Service
  return yield* store.setEndpoint(orbId, input)
})

export const endpointCredentials = Effect.fn("OrbStore.endpointCredentials.call")(function* (orbId: Ids.OrbId) {
  const store = yield* Service
  return yield* store.endpointCredentials(orbId)
})

export const touch = Effect.fn("OrbStore.touch.call")(function* (orbId: Ids.OrbId) {
  const store = yield* Service
  return yield* store.touch(orbId)
})

interface OrbRecordRow {
  readonly orb_id: string
  readonly thread_id: string
  readonly project_id: string
  readonly sandbox_id: string
  readonly status: string
  readonly base_commit: string
  readonly endpoint_url: string
  readonly created_at: number
  readonly last_active_at: number
}

interface EndpointRow {
  readonly endpoint_url: string
  readonly token: string
}

const listRows = (database: Pick<Database.DrizzleDatabase, "all">, filter: ListFilter) => {
  if (filter.status !== undefined) {
    return database.all<OrbRecordRow>(
      sql`${recordColumns} from orbs where status = ${filter.status} order by last_active_at desc`,
    )
  }
  return database.all<OrbRecordRow>(sql`${recordColumns} from orbs order by last_active_at desc`)
}

const requireOrb = (database: Pick<Database.DrizzleDatabase, "get">, orbId: Ids.OrbId, operation: string) => {
  const record = rowToRecord(database.get<OrbRecordRow>(recordByOrbIdQuery(orbId)))
  if (record === undefined) {
    throw new OrbStoreError({
      message: `Orb ${orbId} not found`,
      operation,
      reason: "not_found",
      orb_id: orbId,
    })
  }
  return record
}

const recordToRow = (record: Orb.OrbRecord, token: string) => ({
  orb_id: record.orb_id,
  thread_id: record.thread_id,
  project_id: record.project_id,
  sandbox_id: record.sandbox_id,
  status: record.status,
  base_commit: record.base_commit,
  endpoint_url: record.endpoint_url,
  token,
  created_at: record.created_at,
  last_active_at: record.last_active_at,
})

const rowToRecord = (row: OrbRecordRow | undefined): Orb.OrbRecord | undefined =>
  row === undefined ? undefined : rowToExistingRecord(row)

const rowToExistingRecord = (row: OrbRecordRow): Orb.OrbRecord => ({
  orb_id: Ids.OrbId.make(row.orb_id),
  thread_id: Ids.ThreadId.make(row.thread_id),
  project_id: Ids.ProjectId.make(row.project_id),
  sandbox_id: row.sandbox_id,
  status: Schema.decodeUnknownSync(Orb.OrbStatus)(row.status),
  base_commit: row.base_commit,
  endpoint_url: row.endpoint_url,
  created_at: Common.TimestampMillis.make(row.created_at),
  last_active_at: Common.TimestampMillis.make(row.last_active_at),
})

const rowToEndpoint = (row: EndpointRow | undefined): EndpointInput | undefined =>
  row === undefined ? undefined : { endpoint_url: row.endpoint_url, token: row.token }

const recordColumns = sql`select orb_id, thread_id, project_id, sandbox_id, status, base_commit, endpoint_url, created_at, last_active_at`

const recordByOrbIdQuery = (orbId: Ids.OrbId) => sql`${recordColumns} from orbs where orb_id = ${orbId} limit 1`

const recordByThreadIdQuery = (threadId: Ids.ThreadId) =>
  sql`${recordColumns} from orbs where thread_id = ${threadId} limit 1`

const canTransition = (from: Orb.OrbStatus, to: Orb.OrbStatus) => {
  if (from === to) return true
  if (to === "archived") return true
  switch (from) {
    case "provisioning":
      return to === "running"
    case "running":
      return to === "paused" || to === "killed"
    case "paused":
      return to === "running" || to === "killed"
    case "killed":
    case "archived":
      return false
  }
  return false
}

const toError = (
  cause: unknown,
  operation: string,
  context: { readonly orbId?: Ids.OrbId; readonly threadId?: Ids.ThreadId; readonly status?: Orb.OrbStatus } = {},
) => {
  if (cause instanceof OrbStoreError) return cause
  const reason = isUniqueThreadError(cause) ? "unique_thread" : "database"
  return new OrbStoreError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    reason,
    ...(context.orbId === undefined ? {} : { orb_id: context.orbId }),
    ...(context.threadId === undefined ? {} : { thread_id: context.threadId }),
    ...(context.status === undefined ? {} : { status: context.status }),
  })
}

const isUniqueThreadError = (cause: unknown) => cause instanceof Error && cause.message.includes("orbs.thread_id")
