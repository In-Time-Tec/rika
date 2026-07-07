import { IdGenerator, Time } from "@rika/core"
import { Common, Ids, Orb } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import * as Database from "./database"
import { orb_usage_intervals, orbs } from "./schema"

export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Schema.Struct({
  thread_id: Ids.ThreadId,
  project_id: Ids.ProjectId,
  sandbox_id: Schema.optional(Schema.NullOr(Schema.String)),
  base_commit: Schema.optional(Schema.NullOr(Schema.String)),
  endpoint_url: Schema.optional(Schema.NullOr(Schema.String)),
  token: Schema.optional(Schema.NullOr(Schema.String)),
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

export interface UsageFilter extends Schema.Schema.Type<typeof UsageFilter> {}
export const UsageFilter = Schema.Struct({
  orb_id: Schema.optional(Ids.OrbId),
  project_name: Schema.optional(Schema.String),
  since: Schema.optional(Common.TimestampMillis),
}).annotate({ identifier: "Rika.Persistence.OrbStore.UsageFilter" })

export interface UsageRow extends Schema.Schema.Type<typeof UsageRow> {}
export const UsageRow = Schema.Struct({
  orb_id: Ids.OrbId,
  thread_id: Ids.ThreadId,
  project_id: Ids.ProjectId,
  project: Schema.String,
  total_running_minutes: Schema.Number,
  interval_count: Schema.Int,
}).annotate({ identifier: "Rika.Persistence.OrbStore.UsageRow" })

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
  readonly usage: (
    filter?: UsageFilter,
  ) => Effect.Effect<ReadonlyArray<UsageRow>, Database.DatabaseError | OrbStoreError>
  readonly repairUsageIntervals: () => Effect.Effect<number, Database.DatabaseError | OrbStoreError>
  readonly setStatus: (
    orbId: Ids.OrbId,
    status: Orb.OrbStatus,
  ) => Effect.Effect<Orb.OrbRecord, Database.DatabaseError | OrbStoreError>
  readonly setSandbox: (
    orbId: Ids.OrbId,
    sandboxId: string,
  ) => Effect.Effect<Orb.OrbRecord, Database.DatabaseError | OrbStoreError>
  readonly setBaseCommit: (
    orbId: Ids.OrbId,
    baseCommit: string,
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
          sandbox_id: input.sandbox_id ?? null,
          status: "provisioning",
          base_commit: input.base_commit ?? null,
          endpoint_url: input.endpoint_url ?? null,
          created_at: now,
          last_active_at: now,
        }
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => {
              database
                .insert(orbs)
                .values(recordToRow(record, input.token ?? null))
                .run()
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
      usage: Effect.fn("OrbStore.usage")(function* (filter: UsageFilter = {}) {
        const now = yield* time.nowMillis
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => usageRows(database, filter, now),
            catch: (cause) => toError(cause, "usage", filter.orb_id === undefined ? {} : { orbId: filter.orb_id }),
          }),
        )
      }),
      repairUsageIntervals: Effect.fn("OrbStore.repairUsageIntervals")(function* () {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () =>
              database.transaction((transaction) => {
                const rows = staleOpenIntervalRows(transaction)
                for (const row of rows) {
                  transaction.run(
                    sql`update orb_usage_intervals set ended_at = ${row.last_active_at} where id = ${row.id}`,
                  )
                }
                return rows.length
              }),
            catch: (cause) => toError(cause, "repairUsageIntervals"),
          }),
        )
      }),
      setStatus: Effect.fn("OrbStore.setStatus")(function* (orbId: Ids.OrbId, status: Orb.OrbStatus) {
        const now = yield* time.nowMillis
        const intervalId =
          status === "running" ? Ids.OrbUsageIntervalId.make(yield* idGenerator.next("orb_usage_interval")) : undefined
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
                if (existing.status !== "running" && status === "running" && intervalId !== undefined) {
                  closeOpenIntervals(transaction, orbId, existing.last_active_at)
                  openInterval(transaction, intervalId, orbId, now)
                }
                if (existing.status === "running" && status !== "running") {
                  closeOpenIntervals(transaction, orbId, now)
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
      setSandbox: Effect.fn("OrbStore.setSandbox")(function* (orbId: Ids.OrbId, sandboxId: string) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () =>
              database.transaction((transaction) => {
                const existing = requireOrb(transaction, orbId, "setSandbox")
                transaction.run(sql`update orbs set sandbox_id = ${sandboxId} where orb_id = ${orbId}`)
                return { ...existing, sandbox_id: sandboxId }
              }),
            catch: (cause) => toError(cause, "setSandbox", { orbId }),
          }),
        )
      }),
      setBaseCommit: Effect.fn("OrbStore.setBaseCommit")(function* (orbId: Ids.OrbId, baseCommit: string) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () =>
              database.transaction((transaction) => {
                const existing = requireOrb(transaction, orbId, "setBaseCommit")
                transaction.run(sql`update orbs set base_commit = ${baseCommit} where orb_id = ${orbId}`)
                return { ...existing, base_commit: baseCommit }
              }),
            catch: (cause) => toError(cause, "setBaseCommit", { orbId }),
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

export const usage = Effect.fn("OrbStore.usage.call")(function* (filter?: UsageFilter) {
  const store = yield* Service
  return yield* store.usage(filter)
})

export const repairUsageIntervals = Effect.fn("OrbStore.repairUsageIntervals.call")(function* () {
  const store = yield* Service
  return yield* store.repairUsageIntervals()
})

export const setStatus = Effect.fn("OrbStore.setStatus.call")(function* (orbId: Ids.OrbId, status: Orb.OrbStatus) {
  const store = yield* Service
  return yield* store.setStatus(orbId, status)
})

export const setSandbox = Effect.fn("OrbStore.setSandbox.call")(function* (orbId: Ids.OrbId, sandboxId: string) {
  const store = yield* Service
  return yield* store.setSandbox(orbId, sandboxId)
})

export const setBaseCommit = Effect.fn("OrbStore.setBaseCommit.call")(function* (orbId: Ids.OrbId, baseCommit: string) {
  const store = yield* Service
  return yield* store.setBaseCommit(orbId, baseCommit)
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
  readonly sandbox_id: string | null
  readonly status: string
  readonly base_commit: string | null
  readonly endpoint_url: string | null
  readonly created_at: number
  readonly last_active_at: number
}

interface EndpointRow {
  readonly endpoint_url: string | null
  readonly token: string | null
}

interface UsageIntervalQueryRow {
  readonly orb_id: string
  readonly thread_id: string
  readonly project_id: string
  readonly project_name: string | null
  readonly status: string
  readonly last_active_at: number
  readonly started_at: number
  readonly ended_at: number | null
}

interface StaleOpenIntervalRow {
  readonly id: string
  readonly last_active_at: number
}

const listRows = (database: Pick<Database.DrizzleDatabase, "all">, filter: ListFilter) => {
  if (filter.status !== undefined) {
    return database.all<OrbRecordRow>(
      sql`${recordColumns} from orbs where status = ${filter.status} order by last_active_at desc`,
    )
  }
  return database.all<OrbRecordRow>(sql`${recordColumns} from orbs order by last_active_at desc`)
}

const usageRows = (
  database: Pick<Database.DrizzleDatabase, "all">,
  filter: UsageFilter,
  now: Common.TimestampMillis,
) => {
  const since = filter.since
  const rows = database
    .all<UsageIntervalQueryRow>(
      sql`
        select
          i.orb_id,
          o.thread_id,
          o.project_id,
          p.name as project_name,
          o.status,
          o.last_active_at,
          i.started_at,
          i.ended_at
        from orb_usage_intervals i
        join orbs o on o.orb_id = i.orb_id
        left join projects p on p.project_id = o.project_id
        order by o.last_active_at desc, i.started_at asc
      `,
    )
    .filter((row) => filter.orb_id === undefined || row.orb_id === filter.orb_id)
    .filter((row) => filter.project_name === undefined || row.project_name === filter.project_name)

  const grouped = new Map<string, UsageRow>()
  for (const row of rows) {
    const endedAt = row.ended_at ?? (row.status === "running" ? now : row.last_active_at)
    const startedAt = since === undefined ? row.started_at : Math.max(row.started_at, since)
    const runningMillis = Math.max(0, endedAt - startedAt)
    if (runningMillis <= 0) continue
    const existing = grouped.get(row.orb_id)
    const minutes = runningMillis / 60_000
    if (existing === undefined) {
      grouped.set(row.orb_id, {
        orb_id: Ids.OrbId.make(row.orb_id),
        thread_id: Ids.ThreadId.make(row.thread_id),
        project_id: Ids.ProjectId.make(row.project_id),
        project: row.project_name ?? row.project_id,
        total_running_minutes: minutes,
        interval_count: 1,
      })
    } else {
      grouped.set(row.orb_id, {
        ...existing,
        total_running_minutes: existing.total_running_minutes + minutes,
        interval_count: existing.interval_count + 1,
      })
    }
  }
  return [...grouped.values()].map((row) => ({
    ...row,
    total_running_minutes: normalizedMinutes(row.total_running_minutes),
  }))
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

const openInterval = (
  database: Pick<Database.DrizzleDatabase, "insert">,
  id: Ids.OrbUsageIntervalId,
  orbId: Ids.OrbId,
  startedAt: Common.TimestampMillis,
) => {
  database.insert(orb_usage_intervals).values({ id, orb_id: orbId, started_at: startedAt, ended_at: null }).run()
}

const closeOpenIntervals = (
  database: Pick<Database.DrizzleDatabase, "run">,
  orbId: Ids.OrbId,
  endedAt: Common.TimestampMillis,
) => {
  database.run(sql`update orb_usage_intervals set ended_at = ${endedAt} where orb_id = ${orbId} and ended_at is null`)
}

const staleOpenIntervalRows = (database: Pick<Database.DrizzleDatabase, "all">) =>
  database.all<StaleOpenIntervalRow>(
    sql`
      select i.id, o.last_active_at
      from orb_usage_intervals i
      join orbs o on o.orb_id = i.orb_id
      where i.ended_at is null and o.status <> 'running'
    `,
  )

const recordToRow = (record: Orb.OrbRecord, token: string | null) => ({
  orb_id: record.orb_id,
  thread_id: record.thread_id,
  project_id: record.project_id,
  sandbox_id: record.sandbox_id,
  status: record.status,
  base_commit: record.base_commit,
  endpoint_url: record.endpoint_url,
  token: token ?? null,
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
  row === undefined || row.endpoint_url === null || row.token === null
    ? undefined
    : { endpoint_url: row.endpoint_url, token: row.token }

const recordColumns = sql`select orb_id, thread_id, project_id, sandbox_id, status, base_commit, endpoint_url, created_at, last_active_at`

const recordByOrbIdQuery = (orbId: Ids.OrbId) => sql`${recordColumns} from orbs where orb_id = ${orbId} limit 1`

const recordByThreadIdQuery = (threadId: Ids.ThreadId) =>
  sql`
    ${recordColumns}
    from orbs
    where thread_id = ${threadId}
    order by
      case when status in ('provisioning', 'running', 'paused') then 0 else 1 end,
      last_active_at desc,
      created_at desc
    limit 1
  `

const normalizedMinutes = (value: number) => Number(value.toFixed(6))

const canTransition = (from: Orb.OrbStatus, to: Orb.OrbStatus) => {
  if (from === to) return true
  if (to === "archived") return true
  switch (from) {
    case "provisioning":
      return to === "running" || to === "killed"
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
