import * as BunServices from "@effect/platform-bun/BunServices"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { expect, test } from "vitest"
import { Database as NativeDatabase } from "bun:sqlite"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Database from "@rika/product-store/product-database-layer"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
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

test("finishes current bootstrap after an empty SQLite file survives startup", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-empty-bootstrap-" })
      const filename = `${directory}/rika.db`
      yield* Effect.sync(() => {
        const database = new NativeDatabase(filename)
        database.exec("PRAGMA journal_mode = WAL")
        database.close()
      })
      expect((yield* fileSystem.stat(filename)).size).toBeGreaterThan(0n)
      yield* Effect.scoped(Layer.build(Database.layer(filename)))
      const names = yield* Effect.sync(() => {
        const database = new NativeDatabase(filename, { readonly: true })
        const rows = database
          .query<
            { name: string },
            []
          >("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all()
        database.close()
        return rows.map((row) => row.name)
      })
      expect(names).toContain("rika_threads")
      expect(names).toContain("rika_transcript_units")
      expect(names).toContain("rika_migrations")
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("rejects structurally fresh database files with SQLite sidecars without changing them", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-empty-sidecars-" })
      for (const [name, initialize, suffix] of [
        ["zero-wal", false, "-wal"],
        ["zero-shm", false, "-shm"],
        ["header-wal", true, "-wal"],
      ] as const) {
        const filename = `${directory}/${name}/rika.db`
        yield* fileSystem.makeDirectory(`${directory}/${name}`, { recursive: true })
        if (initialize)
          yield* Effect.sync(() => {
            const database = new NativeDatabase(filename)
            database.close()
          })
        else yield* fileSystem.writeFile(filename, new Uint8Array())
        yield* fileSystem.writeFileString(`${filename}${suffix}`, "recovery-state")
        const before = yield* Effect.all([fileSystem.readFile(filename), fileSystem.readFile(`${filename}${suffix}`)])
        const result = yield* Effect.result(Effect.scoped(Layer.build(Database.layer(filename))))
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(String(result.failure)).toContain("Use a fresh Rika data root")
        const after = yield* Effect.all([fileSystem.readFile(filename), fileSystem.readFile(`${filename}${suffix}`)])
        expect(after.map((bytes) => Array.from(bytes))).toEqual(before.map((bytes) => Array.from(bytes)))
      }
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("enforces current foreign keys and cascades thread deletion", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-foreign-keys-" })
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
        const foreignKeys = yield* sql`PRAGMA foreign_keys`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ foreign_keys: Schema.Literal(1) })))),
        )
        expect(foreignKeys).toEqual([{ foreign_keys: 1 }])
        yield* threads.create({ id, workspace: "/work", title: "Cascade", now: 1 })
        const turn = yield* create(turns, {
          id: Turn.TurnId.make("cascade-turn"),
          threadId: id,
          prompt: "cascade",
          now: 2,
        })
        yield* commitAll(transcripts, turn, TranscriptProjection.Projection.empty(turn.id, turn.prompt), undefined)
        const orphan = yield* Effect.result(sql`INSERT INTO rika_turns
          (id, thread_id, prompt, status, created_at, updated_at)
          VALUES ('orphan', 'missing-thread', 'orphan', 'accepted', 3, 3)`)
        expect(orphan._tag).toBe("Failure")
        yield* sql`DELETE FROM rika_threads WHERE id = ${id}`
        const counts = yield* sql`SELECT
          (SELECT COUNT(*) FROM rika_turns) AS turns,
          (SELECT COUNT(*) FROM rika_thread_queue_state) AS queues,
          (SELECT COUNT(*) FROM rika_transcript_checkpoints) AS checkpoints,
          (SELECT COUNT(*) FROM rika_transcript_units) AS units`.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Array(
                Schema.Struct({
                  turns: Schema.Literal(0),
                  queues: Schema.Literal(0),
                  checkpoints: Schema.Literal(0),
                  units: Schema.Literal(0),
                }),
              ),
            ),
          ),
        )
        expect(counts).toEqual([{ turns: 0, queues: 0, checkpoints: 0, units: 0 }])
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("turn SQL mutations, ordering, and rejection branches", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-turns-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
      )
      return yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        yield* threads.create({
          id,
          workspace: "/work",
          title: "A",
          now: 1,
        })
        const active = yield* create(turns, {
          id: Turn.TurnId.make("active"),
          threadId: id,
          prompt: "a",
          now: 2,
        })
        const second = yield* create(turns, {
          id: Turn.TurnId.make("second"),
          threadId: id,
          prompt: "b",
          now: 3,
        })
        const third = yield* create(turns, {
          id: Turn.TurnId.make("third"),
          threadId: id,
          prompt: "c",
          now: 4,
        })
        expect((yield* turns.findActive(id))?.id).toBe(active.id)
        expect((yield* turns.readQueue(id)).turns.map((turn) => turn.id)).toEqual([second.id, third.id])
        expect((yield* turns.listNonterminal).map((turn) => turn.id)).toEqual([active.id, second.id, third.id])
        expect(yield* turns.claimNextQueued(id, 5)).toBeUndefined()
        expect((yield* turns.editQueued(second.id, "edited", 6)).prompt).toBe("edited")
        expect((yield* Effect.result(turns.editQueued(active.id, "no", 6)))._tag).toBe("Failure")
        expect((yield* Effect.result(turns.dequeue(active.id)))._tag).toBe("Failure")
        expect(yield* turns.takeQueued(third.id)).toMatchObject({
          turn: { id: third.id, prompt: "c" },
          queue: { change: { _tag: "Removed", turnId: third.id } },
        })
        expect(yield* turns.startAccepted(active.id, 7)).toBe(true)
        expect(yield* turns.cancelAccepted(active.id, 8)).toBe(false)
        expect(yield* turns.startAccepted(active.id, 9)).toBe(false)
        yield* turns.setStatus(active.id, "completed", "terminal-cursor", 7)
        for (const [index, staleStatus] of Turn.Status.literals.filter((candidate) => candidate !== "queued").entries())
          expect(yield* turns.setStatus(active.id, staleStatus, `stale-${staleStatus}`, index + 8)).toMatchObject({
            status: "completed",
            lastCursor: "terminal-cursor",
            updatedAt: 7,
          })
        const claimed = yield* turns.claimNextQueued(id, 8)
        expect(claimed?.turn.id).toBe(second.id)
        expect((yield* turns.list(id)).map((turn) => turn.id)).toEqual([active.id, second.id])

        const cancellationThreadId = Thread.ThreadId.make("cancellation-claim-thread")
        yield* threads.create({ id: cancellationThreadId, workspace: "/work", title: "Cancellation", now: 9 })
        const cancellation = yield* create(turns, {
          id: Turn.TurnId.make("cancellation-claim"),
          threadId: cancellationThreadId,
          prompt: "cancel",
          now: 10,
        })
        expect(yield* turns.cancelAccepted(cancellation.id, 11)).toBe(true)
        expect(yield* turns.startAccepted(cancellation.id, 12)).toBe(false)
        expect(yield* turns.cancelAccepted(cancellation.id, 13)).toBe(false)
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})
