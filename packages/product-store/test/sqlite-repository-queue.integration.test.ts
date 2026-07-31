import * as BunServices from "@effect/platform-bun/BunServices"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { expect, test } from "vitest"
import { Database as NativeDatabase } from "bun:sqlite"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Database from "@rika/product-store/product-database-layer"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as ThreadSummaryRepository from "@rika/product-store/sqlite-thread-summary-repository"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as TurnContract from "@rika/product/turn-repository"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as Turn from "@rika/product/turn-record"
import { commitAll } from "./transcript-repository-fixtures"

const id = Thread.ThreadId.make("thread-a")

const create = (
  repository: TurnContract.Interface,
  input: Omit<TurnContract.CreateInput, "executionRoute" | "queueCapacity"> & { readonly queueCapacity?: number },
) =>
  repository.createForSubmission({
    queueCapacity: 128,
    ...input,
    executionRoute: Turn.testExecutionRoute(),
  })

const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })

const legacyModel = (model: Turn.ExecutionModelRoute) => {
  const { providerConnection, registrationIdentity, ...rest } = model
  return {
    ...rest,
    provider: providerConnection.provider,
    registrationKey: registrationIdentity,
    providerProtocol: providerConnection.protocol,
    providerBaseUrl: providerConnection.baseUrl,
    providerApiKeyEnv: "TEST_API_KEY",
    providerOptions: { gatewayProtocol: "opaque" },
  }
}

const _createPreBranchDatabase = (filename: string) => {
  const database = new NativeDatabase(filename)
  database.exec(`
    CREATE TABLE rika_migrations (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    );
    CREATE TABLE rika_workspaces (
      path TEXT PRIMARY KEY NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE rika_threads (
      id TEXT PRIMARY KEY NOT NULL,
      workspace TEXT NOT NULL REFERENCES rika_workspaces(path),
      title TEXT NOT NULL,
      labels_json TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX rika_threads_listing ON rika_threads (pinned DESC, updated_at DESC, id ASC);
    CREATE TABLE rika_turns (
      id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
      last_cursor TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      extension_pin_json TEXT,
      prompt_parts_json TEXT,
      execution_route_json TEXT,
      review_fan_out_id TEXT
    );
    CREATE INDEX rika_turns_thread ON rika_turns (thread_id, created_at ASC, id ASC);
    CREATE TABLE rika_transcript_entries (
      turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      events_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      projection_version INTEGER NOT NULL DEFAULT 1,
      oldest_cursor TEXT,
      checkpoint_cursor TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX rika_transcript_page ON rika_transcript_entries (thread_id, created_at DESC, turn_id DESC);
    CREATE TABLE rika_thread_turn_activity (
      turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
      projected_cursor TEXT,
      complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
      added INTEGER NOT NULL DEFAULT 0 CHECK (added >= 0),
      modified INTEGER NOT NULL DEFAULT 0 CHECK (modified >= 0),
      removed INTEGER NOT NULL DEFAULT 0 CHECK (removed >= 0),
      last_event_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX rika_thread_turn_activity_summary ON rika_thread_turn_activity (thread_id, last_event_at DESC);
    CREATE TABLE rika_thread_read_state (
      thread_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
      last_read_at INTEGER NOT NULL
    );
    CREATE TABLE rika_transcript_checkpoints (
      turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
      drafts_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT -1,
      projection_version INTEGER NOT NULL DEFAULT 2,
      oldest_cursor TEXT,
      checkpoint_cursor TEXT,
      cost_usd REAL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE rika_transcript_units (
      unit_key TEXT PRIMARY KEY NOT NULL,
      turn_id TEXT NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
      unit_sequence INTEGER NOT NULL,
      unit_part INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      unit_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX rika_transcript_units_page ON rika_transcript_units (
      thread_id, created_at DESC, turn_id DESC, unit_sequence DESC, unit_part DESC, unit_key DESC
    );
    CREATE INDEX rika_transcript_units_turn ON rika_transcript_units (
      turn_id, unit_sequence ASC, unit_part ASC, unit_key ASC
    );
  `)
  const migrations = [
    "product_baseline",
    "turns",
    "queued_turn_status",
    "execution_extension_pins",
    "turn_prompt_parts",
    "drop_thread_session_id",
    "execution_route_pins",
    "review_fan_out_owners",
    "transcript_projection",
    "thread_summaries",
    "semantic_transcript_projection",
  ]
  const insertMigration = database.query("INSERT INTO rika_migrations (migration_id, name) VALUES (?, ?)")
  for (const [index, name] of migrations.entries()) insertMigration.run(index + 1, name)
  const currentRoute = Turn.testExecutionRoute()
  const executionRoute = JSON.stringify({
    ...currentRoute,
    main: legacyModel(currentRoute.main),
    oracle: legacyModel(currentRoute.oracle),
    title: legacyModel(currentRoute.title!),
    compactionSummary: legacyModel(currentRoute.compactionSummary!),
    agents: Object.fromEntries(Object.entries(currentRoute.agents!).map(([role, model]) => [role, legacyModel(model)])),
  }).replaceAll('"providerApiKeyEnv":"TEST_API_KEY"', '"gatewayAuth":"bearer-env:TEST_API_KEY"')
  database.query("INSERT INTO rika_workspaces (path, created_at) VALUES (?, ?)").run("/work/pre-branch", 1)
  database
    .query(
      "INSERT INTO rika_threads (id, workspace, title, labels_json, pinned, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run("thread-a", "/work/pre-branch", "Pre-branch thread", '["preserved"]', 1, 0, 2, 3)
  const insertTurn = database.query(
    "INSERT INTO rika_turns (id, thread_id, prompt, status, last_cursor, created_at, updated_at, extension_pin_json, prompt_parts_json, execution_route_json, review_fan_out_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  insertTurn.run(
    "completed-turn",
    "thread-a",
    "completed prompt",
    "completed",
    "completed-cursor",
    4,
    5,
    null,
    '[{"type":"text","text":"completed prompt"}]',
    executionRoute,
    null,
  )
  insertTurn.run("legacy-unpinned-turn", "thread-a", "legacy prompt", "completed", null, 5, 5, null, null, null, null)
  insertTurn.run("queued-turn", "thread-a", "queued prompt", "queued", null, 6, 6, null, null, executionRoute, null)
  database
    .query(
      "INSERT INTO rika_transcript_entries (turn_id, thread_id, prompt, status, events_json, revision, projection_version, oldest_cursor, checkpoint_cursor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "completed-turn",
      "thread-a",
      "completed prompt",
      "completed",
      '[{"type":"execution.completed"}]',
      1,
      1,
      "completed-cursor",
      "completed-cursor",
      4,
      5,
    )
  database
    .query(
      "INSERT INTO rika_transcript_checkpoints (turn_id, thread_id, drafts_json, revision, projection_version, oldest_cursor, checkpoint_cursor, cost_usd, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run("completed-turn", "thread-a", "[]", 1, 2, "completed-cursor", "completed-cursor", 0.5, 5)
  const unit = {
    key: "completed-turn:user",
    turnId: "completed-turn",
    order: { sequence: 0, part: 0 },
    revision: 0,
    content: { _tag: "Entry", role: "user", text: "completed prompt" },
  }
  database
    .query(
      "INSERT INTO rika_transcript_units (unit_key, turn_id, thread_id, unit_sequence, unit_part, revision, unit_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(unit.key, "completed-turn", "thread-a", 0, 0, 0, JSON.stringify(unit), 4, 5)
  database.close()
}

test("dequeue removes the queued turn activity from the materialized summary", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-summary-dequeue-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
        ThreadSummaryRepository.layer.pipe(Layer.provide(database)),
      )
      const context = yield* Layer.build(layer)
      yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        const summaries = yield* ThreadSummaryRepository.Service
        yield* threads.create({ id, workspace: "/work/a", title: "First", now: 1 })
        const active = yield* create(turns, {
          id: Turn.TurnId.make("active"),
          threadId: id,
          prompt: "active",
          now: 2,
        })
        yield* turns.setStatus(active.id, "running", "active-cursor", 3)
        const queued = yield* create(turns, {
          id: Turn.TurnId.make("queued"),
          threadId: id,
          prompt: "queued",
          now: 4,
        })
        yield* summaries.replaceTurn({
          turnId: active.id,
          threadId: id,
          projectedCursor: "active-cursor",
          complete: false,
          editTotals: { added: 3, modified: 2, removed: 1 },
          lastEventAt: 3,
          now: 3,
        })
        yield* summaries.replaceTurn({
          turnId: queued.id,
          threadId: id,
          complete: false,
          editTotals: { added: 7, modified: 5, removed: 4 },
          lastEventAt: 4,
          now: 4,
        })
        expect((yield* summaries.list())[0]?.editTotals).toEqual({ added: 10, modified: 7, removed: 5 })
        yield* turns.dequeue(queued.id)
        expect((yield* summaries.list())[0]?.editTotals).toEqual({ added: 3, modified: 2, removed: 1 })
      }).pipe(Effect.provide(context))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("concurrent SQLite submissions cannot exceed queue capacity and dequeue frees one slot", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-bounded-queue-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
      )
      yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        yield* threads.create({ id, workspace: "/work", title: "Bounded", now: 1 })
        yield* create(turns, {
          id: Turn.TurnId.make("active"),
          threadId: id,
          prompt: "active",
          queueCapacity: 3,
          now: 1,
        })
        const submitted = yield* Effect.forEach(
          Array.from({ length: 10 }, (_, index) => index),
          (index) =>
            Effect.result(
              create(turns, {
                id: Turn.TurnId.make(`bounded-${index}`),
                threadId: id,
                prompt: `bounded ${index}`,
                queueCapacity: 3,
                now: index + 2,
              }),
            ),
          { concurrency: "unbounded" },
        )
        const failures = submitted.filter((result) => result._tag === "Failure")
        expect(failures).toHaveLength(7)
        for (const result of failures)
          expect(result._tag === "Failure" ? result.failure : undefined).toEqual(
            TurnContract.QueueFull.make({ threadId: id, capacity: 3, count: 3 }),
          )
        const full = yield* turns.readQueue(id)
        expect(full).toMatchObject({ revision: 3, queuedCount: 3 })
        expect(yield* turns.list(id)).toHaveLength(4)
        const removed = full.turns[0]
        if (removed === undefined) return yield* Effect.die("Missing queued turn")
        yield* turns.dequeue(removed.id)
        const replacement = yield* create(turns, {
          id: Turn.TurnId.make("bounded-replacement"),
          threadId: id,
          prompt: "replacement",
          queueCapacity: 3,
          now: 20,
        })
        expect(replacement.queue).toMatchObject({ revision: 5, queuedCount: 3 })
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("SQLite queue copy, take, and accepted rollback stay atomic", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-queue-transactions-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
      )
      yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        const requeueThread = Thread.ThreadId.make("sqlite-requeue-thread")
        const copyThread = Thread.ThreadId.make("sqlite-copy-thread")
        yield* threads.create({ id: requeueThread, workspace: "/work", title: "Requeue", now: 1 })
        yield* threads.create({ id: copyThread, workspace: "/work", title: "Copy", now: 1 })

        const accepted = yield* create(turns, {
          id: Turn.TurnId.make("sqlite-requeue-accepted"),
          threadId: requeueThread,
          prompt: "accepted",
          now: 2,
        })
        expect(yield* turns.requeueAccepted(accepted.id, 1, 3)).toMatchObject({
          status: "queued",
          queue: { revision: 1, queuedCount: 1 },
        })
        expect((yield* turns.claimNextQueued(requeueThread, 4))?.turn.id).toBe(accepted.id)

        const copied = yield* turns.copy(
          {
            _tag: "AgentExecution",
            id: Turn.TurnId.make("sqlite-copied-queued"),
            threadId: copyThread,
            prompt: "copied",
            executionRoute: Turn.testExecutionRoute(),
            author: { _tag: "Human" },
            lineage: { _tag: "Original" },
            status: "queued",
            stopIntent: "none",
            createdAt: 2,
            updatedAt: 2,
          },
          1,
        )
        expect(copied).toMatchObject({ status: "queued", queue: { revision: 1, queuedCount: 1 } })
        const overflowId = Turn.TurnId.make("sqlite-copy-overflow")
        expect(
          yield* Effect.result(
            turns.copy(
              {
                _tag: "AgentExecution",
                id: overflowId,
                threadId: copyThread,
                prompt: "overflow",
                executionRoute: Turn.testExecutionRoute(),
                author: { _tag: "Human" },
                lineage: { _tag: "Original" },
                status: "queued",
                stopIntent: "none",
                createdAt: 3,
                updatedAt: 3,
              },
              1,
            ),
          ),
        ).toMatchObject({ _tag: "Failure", failure: { _tag: "TurnQueueFull", count: 1 } })
        expect(yield* turns.get(overflowId)).toBeUndefined()
        expect(yield* turns.takeQueued(copied.id)).toMatchObject({
          turn: { id: copied.id },
          queue: { revision: 2, queuedCount: 0 },
        })
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("concurrent queue submissions produce contiguous revisions and one coalesced wake", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-queue-stress-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
      )
      yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        yield* threads.create({ id, workspace: "/work", title: "Stress", now: 1 })
        const active = yield* create(turns, {
          id: Turn.TurnId.make("active"),
          threadId: id,
          prompt: "active",
          now: 1,
        })
        const submitted = yield* Effect.forEach(
          Array.from({ length: 4 }, (_, index) => index),
          (index) =>
            create(turns, {
              id: Turn.TurnId.make(`queued-${index.toString().padStart(3, "0")}`),
              threadId: id,
              prompt: `queued ${index}`,
              now: index + 2,
            }),
          { concurrency: "unbounded" },
        )
        expect(submitted.map((turn) => turn.queue?.revision).toSorted((left, right) => left! - right!)).toEqual([
          1, 2, 3, 4,
        ])
        const queue = yield* turns.readQueue(id)
        expect(queue).toMatchObject({ revision: 4, queuedCount: 4 })
        expect(queue.turns).toHaveLength(4)
        const wake = yield* turns.requestQueueWake(id)
        expect(wake).toEqual({ threadId: id, generation: 1, queueRevision: 4 })
        expect(yield* turns.requestQueueWake(id)).toEqual(wake)
        yield* turns.setStatus(active.id, "completed", undefined, 200)
        const claims = yield* Effect.forEach(Array.from({ length: 20 }), () => turns.claimNextQueued(id, 201), {
          concurrency: "unbounded",
        })
        expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1)
        expect(yield* turns.readQueue(id)).toMatchObject({ revision: 4, queuedCount: 4 })
        yield* turns.resetQueueClaims
        const claimed = yield* turns.claimNextQueued(id, 202)
        if (claimed === undefined) return yield* Effect.die("Missing claim after reset")
        const transitioned = yield* turns.finishQueuedClaim(claimed, "running", "cursor", undefined, 203)
        expect(transitioned).toMatchObject({
          _tag: "Transitioned",
          turn: { status: "running", lastCursor: "cursor" },
          queue: { revision: 5, queuedCount: 3 },
        })
        const sql = yield* SqlClient
        const plan = yield* sql`EXPLAIN QUERY PLAN SELECT * FROM rika_turns
          WHERE thread_id = ${id} AND status = 'queued'
          ORDER BY created_at ASC, id ASC LIMIT 1`
        const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ detail: Schema.String })))(plan)
        expect(decoded.map((row) => row.detail).join("\n")).toContain("rika_turns_queue")
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("thread creation rolls back its workspace when the thread insert fails", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-thread-atomicity-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.merge(database, ThreadRepository.layer.pipe(Layer.provide(database)))
      yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const sql = yield* SqlClient
        yield* sql`CREATE TRIGGER reject_thread BEFORE INSERT ON rika_threads
          BEGIN SELECT RAISE(ABORT, 'injected thread failure'); END`
        const result = yield* Effect.result(
          threads.create({ id, workspace: "/work/rollback", title: "Rejected", now: 1 }),
        )
        expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ThreadRepositoryError" } })
        expect(yield* sql`SELECT path FROM rika_workspaces WHERE path = '/work/rollback'`).toEqual([])
        expect(yield* threads.get(id)).toBeUndefined()
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("malformed SQLite product rows fail through typed repositories", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-malformed-rows-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
        TranscriptRepository.layer.pipe(Layer.provide(database)),
      )
      yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        const transcripts = yield* TranscriptRepository.Service
        const sql = yield* SqlClient
        yield* threads.create({ id, workspace: "/work", title: "Malformed", now: 1 })
        const turn = yield* create(turns, {
          id: Turn.TurnId.make("malformed-turn"),
          threadId: id,
          prompt: "persist",
          now: 2,
        })
        yield* commitAll(transcripts, turn, TranscriptProjection.Projection.empty(turn.id, turn.prompt), undefined)
        yield* sql`UPDATE rika_threads SET labels_json = 'not-json' WHERE id = ${id}`
        expect(yield* Effect.result(threads.get(id))).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ThreadRepositoryError" },
        })
        yield* sql`INSERT INTO rika_transcript_units
          (turn_id, unit_key, execution_key, thread_id, unit_order_key, revision, unit_json, created_at, updated_at)
          VALUES (${turn.id}, 'malformed-unit', ${TranscriptCorrelation.executionKey(turn.id)}, ${id}, 'malformed-order', 1, 'not-json', 2, 2)`
        expect(yield* Effect.result(transcripts.get(turn.id))).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "TranscriptRepositoryError" },
        })
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("independent SQLite clients share queue limits and reject stale summary writes", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-concurrent-clients-" })
      const filename = `${directory}/rika.db`
      const makeLayer = () => {
        const database = Database.layer(filename)
        return Layer.mergeAll(
          database,
          ThreadRepository.layer.pipe(Layer.provide(database)),
          TurnRepository.layer.pipe(Layer.provide(database)),
          ThreadSummaryRepository.layer.pipe(Layer.provide(database)),
        )
      }
      const first = yield* Layer.build(makeLayer())
      const second = yield* Layer.build(makeLayer())
      const [threads, firstTurns, firstSummaries, firstSql] = yield* Effect.all([
        ThreadRepository.Service,
        TurnRepository.Service,
        ThreadSummaryRepository.Service,
        SqlClient,
      ]).pipe(Effect.provide(first))
      const [secondTurns, secondSummaries] = yield* Effect.all([
        TurnRepository.Service,
        ThreadSummaryRepository.Service,
      ]).pipe(Effect.provide(second))
      yield* threads.create({ id, workspace: "/work", title: "Concurrent", now: 1 })
      const active = yield* create(firstTurns, {
        id: Turn.TurnId.make("client-active"),
        threadId: id,
        prompt: "active",
        queueCapacity: 2,
        now: 2,
      })
      const attempts = yield* Effect.forEach(
        Array.from({ length: 6 }, (_, index) => index),
        (index) =>
          Effect.result(
            create(index % 2 === 0 ? firstTurns : secondTurns, {
              id: Turn.TurnId.make(`client-queued-${index}`),
              threadId: id,
              prompt: `queued ${index}`,
              queueCapacity: 2,
              now: index + 3,
            }),
          ),
        { concurrency: "unbounded" },
      )
      expect(attempts.filter((attempt) => attempt._tag === "Success")).toHaveLength(2)
      expect(attempts.filter((attempt) => attempt._tag === "Failure").map((attempt) => attempt.failure)).toEqual(
        Array.from({ length: 4 }, () =>
          expect.objectContaining({ _tag: "TurnQueueFull", threadId: id, capacity: 2, count: 2 }),
        ),
      )
      expect(yield* firstTurns.readQueue(id)).toMatchObject({ queuedCount: 2, revision: 2 })
      yield* firstSummaries.replaceTurn({
        turnId: active.id,
        threadId: id,
        projectedCursor: "newer",
        complete: true,
        editTotals: { added: 8, modified: 5, removed: 3 },
        lastEventAt: 20,
        now: 20,
      })
      yield* secondSummaries.replaceTurn({
        turnId: active.id,
        threadId: id,
        projectedCursor: "older",
        complete: false,
        editTotals: { added: 1, modified: 0, removed: 0 },
        lastEventAt: 4,
        now: 4,
      })
      expect(yield* secondSummaries.list()).toMatchObject([{ lastActivityAt: 20 }])
      expect(
        yield* firstSql`SELECT projected_cursor, complete, added, modified, removed, updated_at
        FROM rika_thread_turn_activity WHERE turn_id = ${active.id}`,
      ).toEqual([{ projected_cursor: "newer", complete: 1, added: 8, modified: 5, removed: 3, updated_at: 20 }])
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})
