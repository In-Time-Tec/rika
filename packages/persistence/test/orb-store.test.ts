import { describe, expect, test } from "bun:test"
import { IdGenerator, Time } from "@rika/core"
import { Common, Ids, Orb } from "@rika/schema"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database, Migration, OrbStore } from "../src/index"

const createdAt = Common.TimestampMillis.make(1_980_000_001_000)
const touchedAt = Common.TimestampMillis.make(1_980_000_001_500)
const statusAt = Common.TimestampMillis.make(1_980_000_002_000)
const runningAt = Common.TimestampMillis.make(1_980_000_060_000)
const duplicateRunningAt = Common.TimestampMillis.make(1_980_000_120_000)
const pausedAt = Common.TimestampMillis.make(1_980_000_180_000)
const resumedAt = Common.TimestampMillis.make(1_980_000_240_000)
const killedAt = Common.TimestampMillis.make(1_980_000_300_000)
const usageReadAt = Common.TimestampMillis.make(1_980_000_360_000)
const orbId = Ids.OrbId.make("orb_1")
const threadId = Ids.ThreadId.make("thread_orb_store")
const projectId = Ids.ProjectId.make("project_orb_store")

describe("OrbStore", () => {
  test("creates a staged provisioning record and allows cleanup before running", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* OrbStore.create({ thread_id: threadId, project_id: projectId })
        const killed = yield* OrbStore.setStatus(orbId, "killed")
        return { created, killed }
      }).pipe(Effect.provide(makeLayer({ times: [createdAt, touchedAt] }))),
    )

    expect(result.created).toEqual(
      orbRecord({
        sandbox_id: null,
        base_commit: null,
        endpoint_url: null,
        status: "provisioning",
        last_active_at: createdAt,
      }),
    )
    expect(result.killed.status).toBe("killed")
    expect(result.killed.last_active_at).toBe(touchedAt)
  })

  test("records sandbox identity and base commit during provisioning", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* OrbStore.create({ thread_id: threadId, project_id: projectId })
        const sandbox = yield* OrbStore.setSandbox(orbId, "sandbox_orb_store")
        const baseCommit = yield* OrbStore.setBaseCommit(orbId, "abc123")
        const stored = yield* OrbStore.get(orbId)
        return { sandbox, baseCommit, stored }
      }).pipe(Effect.provide(makeLayer())),
    )

    expect(result.sandbox.sandbox_id).toBe("sandbox_orb_store")
    expect(result.baseCommit.base_commit).toBe("abc123")
    expect(result.stored).toEqual(
      orbRecord({
        sandbox_id: "sandbox_orb_store",
        base_commit: "abc123",
        endpoint_url: null,
        status: "provisioning",
      }),
    )
  })

  test("creates, fetches, and lists token-free orb records", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* OrbStore.create(createInput())
        const byId = yield* OrbStore.get(orbId)
        const byThread = yield* OrbStore.getByThread(threadId)
        const listed = yield* OrbStore.list()
        const running = yield* OrbStore.list({ status: "running" })
        return { created, byId, byThread, listed, running }
      }).pipe(Effect.provide(makeLayer())),
    )

    const expected = orbRecord({ status: "provisioning", last_active_at: createdAt })
    expect(result.created).toEqual(expected)
    expect(result.byId).toEqual(expected)
    expect(result.byThread).toEqual(expected)
    expect(result.listed).toEqual([expected])
    expect(result.running).toEqual([])
    expect(result.created).not.toHaveProperty("token")
  })

  test("rejects a second orb for the same thread with a discriminated error", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* OrbStore.create(createInput())
        return yield* OrbStore.create({ ...createInput(), project_id: Ids.ProjectId.make("project_second") })
      }).pipe(Effect.flip, Effect.provide(makeLayer())),
    )

    expect(error).toBeInstanceOf(OrbStore.OrbStoreError)
    if (!(error instanceof OrbStore.OrbStoreError)) throw new Error("expected OrbStoreError")
    expect(error.reason).toBe("unique_thread")
    expect(error.operation).toBe("create")
    expect(error.thread_id).toBe(threadId)
  })

  test("allows a new active orb for a thread after the previous orb is terminal", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const first = yield* OrbStore.create(createInput())
        const killed = yield* OrbStore.setStatus(first.orb_id, "killed")
        const second = yield* OrbStore.create({ ...createInput(), sandbox_id: "sandbox_orb_store_retry" })
        const byThread = yield* OrbStore.getByThread(threadId)
        const listed = yield* OrbStore.list()
        return { killed, second, byThread, listed }
      }).pipe(Effect.provide(makeLayer({ times: [createdAt, touchedAt, statusAt] }))),
    )

    expect(result.killed).toMatchObject({ orb_id: orbId, status: "killed" })
    expect(result.second).toMatchObject({
      orb_id: Ids.OrbId.make("orb_2"),
      thread_id: threadId,
      status: "provisioning",
      sandbox_id: "sandbox_orb_store_retry",
    })
    expect(result.byThread).toEqual(result.second)
    expect(result.listed.map((record) => record.orb_id)).toEqual([Ids.OrbId.make("orb_2"), orbId])
  })

  test("stores endpoint tokens behind a narrow credential accessor", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* OrbStore.create(createInput())
        const updated = yield* OrbStore.setEndpoint(orbId, {
          endpoint_url: "https://orb.example.test",
          token: "secret-token",
        })
        const read = yield* OrbStore.get(orbId)
        const credentials = yield* OrbStore.endpointCredentials(orbId)
        return { updated, read, credentials }
      }).pipe(Effect.provide(makeLayer())),
    )

    expect(result.updated.endpoint_url).toBe("https://orb.example.test")
    expect(result.read).toEqual(result.updated)
    expect(result.read).not.toHaveProperty("token")
    expect(result.credentials).toEqual({ endpoint_url: "https://orb.example.test", token: "secret-token" })
  })

  test("guards terminal status transitions and bumps last activity on valid status changes", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* OrbStore.create(createInput())
        const running = yield* OrbStore.setStatus(orbId, "running")
        const paused = yield* OrbStore.setStatus(orbId, "paused")
        const killed = yield* OrbStore.setStatus(orbId, "killed")
        const killedToRunning = yield* OrbStore.setStatus(orbId, "running").pipe(Effect.flip)
        const archived = yield* OrbStore.setStatus(orbId, "archived")
        const archivedToRunning = yield* OrbStore.setStatus(orbId, "running").pipe(Effect.flip)
        return { running, paused, killed, killedToRunning, archived, archivedToRunning }
      }).pipe(Effect.provide(makeLayer({ times: [createdAt, touchedAt, statusAt, statusAt, statusAt, statusAt] }))),
    )

    expect(result.running.status).toBe("running")
    expect(result.running.last_active_at).toBe(touchedAt)
    expect(result.paused.status).toBe("paused")
    expect(result.killed.status).toBe("killed")
    expect(result.killedToRunning).toBeInstanceOf(OrbStore.OrbStoreError)
    if (!(result.killedToRunning instanceof OrbStore.OrbStoreError)) throw new Error("expected OrbStoreError")
    expect(result.killedToRunning.reason).toBe("invalid_transition")
    expect(result.archived.status).toBe("archived")
    expect(result.archivedToRunning).toBeInstanceOf(OrbStore.OrbStoreError)
    if (!(result.archivedToRunning instanceof OrbStore.OrbStoreError)) throw new Error("expected OrbStoreError")
    expect(result.archivedToRunning.reason).toBe("invalid_transition")
  })

  test("touch bumps last_active_at", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* OrbStore.create(createInput())
        return yield* OrbStore.touch(orbId)
      }).pipe(Effect.provide(makeLayer({ times: [createdAt, touchedAt] }))),
    )

    expect(result.last_active_at).toBe(touchedAt)
  })

  test("status transitions record one usage interval per running span", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* OrbStore.create(createInput())
        yield* OrbStore.setStatus(orbId, "running")
        yield* OrbStore.setStatus(orbId, "running")
        yield* OrbStore.setStatus(orbId, "paused")
        yield* OrbStore.setStatus(orbId, "running")
        yield* OrbStore.setStatus(orbId, "killed")
        const usage = yield* OrbStore.usage()
        return usage
      }).pipe(
        Effect.provide(
          makeLayer({
            times: [createdAt, runningAt, duplicateRunningAt, pausedAt, resumedAt, killedAt, usageReadAt],
          }),
        ),
      ),
    )

    expect(result).toEqual([
      {
        orb_id: orbId,
        thread_id: threadId,
        project_id: projectId,
        project: projectId,
        total_running_minutes: 3,
        interval_count: 2,
      },
    ])
  })

  test("usage includes open running intervals through the read time", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* OrbStore.create(createInput())
        yield* OrbStore.setStatus(orbId, "running")
        yield* OrbStore.setStatus(orbId, "paused")
        yield* OrbStore.setStatus(orbId, "running")
        return yield* OrbStore.usage()
      }).pipe(Effect.provide(makeLayer({ times: [createdAt, runningAt, pausedAt, resumedAt, usageReadAt] }))),
    )

    expect(result[0]?.total_running_minutes).toBe(4)
    expect(result[0]?.interval_count).toBe(2)
  })

  test("repairs stale open intervals using the orb last activity time", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* OrbStore.create(createInput())
        yield* OrbStore.setStatus(orbId, "running")
        yield* simulateCrashPausedOrb(orbId, pausedAt)
        yield* OrbStore.repairUsageIntervals()
        yield* OrbStore.setStatus(orbId, "running")
        yield* OrbStore.setStatus(orbId, "killed")
        return yield* OrbStore.usage()
      }).pipe(Effect.provide(makeLayer({ times: [createdAt, runningAt, resumedAt, killedAt, usageReadAt] }))),
    )

    expect(result[0]?.total_running_minutes).toBe(3)
    expect(result[0]?.interval_count).toBe(2)
  })

  test("normal record reads do not select endpoint tokens", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* OrbStore.create(createInput())
        yield* OrbStore.setEndpoint(orbId, {
          endpoint_url: "https://orb.example.test",
          token: "secret-token",
        })
        yield* OrbStore.get(orbId)
        yield* OrbStore.getByThread(threadId)
        yield* OrbStore.list()
        yield* OrbStore.list({ status: "provisioning" })
        yield* OrbStore.setStatus(orbId, "running")
        yield* OrbStore.touch(orbId)
      }).pipe(Effect.provide(makeLayer({ auditRecordReads: true, times: [createdAt, touchedAt, statusAt] }))),
    )
  })
})

const createInput = (): OrbStore.CreateInput => ({
  thread_id: threadId,
  project_id: projectId,
  sandbox_id: "sandbox_orb_store",
  base_commit: "abc123",
  endpoint_url: "",
  token: "",
})

const orbRecord = (override: Partial<Orb.OrbRecord> = {}): Orb.OrbRecord => ({
  orb_id: orbId,
  thread_id: threadId,
  project_id: projectId,
  sandbox_id: "sandbox_orb_store",
  status: "provisioning",
  base_commit: "abc123",
  endpoint_url: "",
  created_at: createdAt,
  last_active_at: createdAt,
  ...override,
})

const makeLayer = (
  input: { readonly times?: ReadonlyArray<Common.TimestampMillis>; readonly auditRecordReads?: boolean } = {},
) => {
  const timeLayer = timeSequenceLayer(input.times ?? [createdAt])
  const idLayer = IdGenerator.sequenceLayer(1)
  const databaseLayer = input.auditRecordReads === true ? recordReadAuditLayer : Database.memoryLayer
  const storeLayer = OrbStore.layer.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  return Layer.mergeAll(databaseLayer, Migration.layer, timeLayer, idLayer, storeLayer)
}

const timeSequenceLayer = (times: ReadonlyArray<Common.TimestampMillis>) => {
  let index = 0
  return Layer.succeed(
    Time.Service,
    Time.Service.of({
      nowMillis: Effect.sync(() => {
        const value = times[Math.min(index, times.length - 1)] ?? createdAt
        index += 1
        return value
      }),
    }),
  )
}

const recordReadAuditLayer = Layer.effect(
  Database.Service,
  Effect.gen(function* () {
    const databaseService = yield* Database.Service
    return Database.Service.of({
      withDatabase: (operation) => databaseService.withDatabase((database) => operation(auditDatabase(database))),
      withDatabaseEffect: (operation) =>
        databaseService.withDatabaseEffect((database) => operation(auditDatabase(database))),
    })
  }),
).pipe(Layer.provide(Database.memoryLayer))

const auditDatabase = (database: Database.DrizzleDatabase): Database.DrizzleDatabase =>
  new Proxy(database, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property === "get" || property === "all") {
        return (query: unknown, ...args: Array<unknown>) => {
          rejectRecordTokenRead(query)
          return value.call(target, query, ...args)
        }
      }
      if (property === "transaction") {
        return (callback: (transaction: Database.DrizzleDatabase) => unknown, ...args: Array<unknown>) =>
          value.call(target, (transaction: Database.DrizzleDatabase) => callback(auditDatabase(transaction)), ...args)
      }
      return typeof value === "function" ? value.bind(target) : value
    },
  })

const rejectRecordTokenRead = (query: unknown) => {
  const text = queryText(query).replaceAll(/\s+/g, " ").toLowerCase()
  if (text.includes("select * from orbs")) {
    throw new Error("orb record read selected endpoint token")
  }
}

const simulateCrashPausedOrb = (id: Ids.OrbId, at: Common.TimestampMillis) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.withDatabaseEffect((client) =>
      Effect.sync(() => {
        client.run(sql`update orbs set status = 'paused', last_active_at = ${at} where orb_id = ${id}`)
      }),
    )
  })

const queryText = (query: unknown): string => {
  if (typeof query === "string") return query
  if (query === null || typeof query !== "object") return ""
  const queryChunks = Reflect.get(query, "queryChunks")
  if (Array.isArray(queryChunks)) {
    return queryChunks.map(queryText).join(" ")
  }
  const value = Reflect.get(query, "value")
  if (value !== undefined) {
    return Array.isArray(value) ? value.map(queryText).join(" ") : queryText(value)
  }
  return ""
}
