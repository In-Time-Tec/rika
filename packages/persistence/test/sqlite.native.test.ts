import * as BunServices from "@effect/platform-bun/BunServices"
import * as Transcript from "@rika/transcript"
import { expect, test } from "vitest"
import { Database as NativeDatabase } from "bun:sqlite"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { Database, Thread, ThreadRepository, ThreadSummaryRepository } from "../src"
import * as TurnRepository from "../src/turn-repository"
import * as TranscriptRepository from "../src/transcript-repository"
import * as Turn from "../src/turn-schema"

const id = Thread.ThreadId.make("thread-a")

const create = (
  repository: TurnRepository.Interface,
  input: Omit<TurnRepository.CreateInput, "executionRoute" | "queueCapacity"> & { readonly queueCapacity?: number },
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

const createPreBranchDatabase = (filename: string) => {
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
  const executionRoute = JSON.stringify({ version: 1, ...Turn.testExecutionRoute() })
    .replaceAll('"providerProtocol"', '"gatewayProtocol"')
    .replaceAll('"providerBaseUrl"', '"gatewayBaseUrl"')
    .replaceAll(
      '"gatewayBaseUrl":"test://model"',
      '"gatewayBaseUrl":"test://model","gatewayAuth":"bearer-env:TEST_API_KEY","providerOptions":{"gatewayProtocol":"opaque"}',
    )
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

test("migrates a pre-branch database without losing product or queue data", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-pre-branch-migration-" })
      const filename = `${directory}/rika.db`
      yield* Effect.sync(() => createPreBranchDatabase(filename))
      const database = Database.layer(filename)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
        TranscriptRepository.layer.pipe(Layer.provide(database)),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const threads = yield* ThreadRepository.Service
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          const sql = yield* SqlClient
          expect(yield* threads.get(id)).toMatchObject({
            id: "thread-a",
            title: "Pre-branch thread",
            labels: ["preserved"],
            pinned: true,
          })
          const storedTurns = yield* turns.list(id)
          expect(storedTurns.map((turn) => String(turn.id))).toEqual([
            "completed-turn",
            "legacy-unpinned-turn",
            "queued-turn",
          ])
          const migratedRoute = storedTurns.find((turn) => turn.id === "completed-turn")?.executionRoute
          expect(migratedRoute).toMatchObject({
            main: { providerProtocol: "test", providerBaseUrl: "test://model", providerApiKeyEnv: "TEST_API_KEY" },
            oracle: { providerProtocol: "test", providerBaseUrl: "test://model", providerApiKeyEnv: "TEST_API_KEY" },
            title: { providerProtocol: "test", providerBaseUrl: "test://model", providerApiKeyEnv: "TEST_API_KEY" },
            compactionSummary: {
              providerProtocol: "test",
              providerBaseUrl: "test://model",
              providerApiKeyEnv: "TEST_API_KEY",
            },
            agents: {
              task: { providerProtocol: "test", providerBaseUrl: "test://model", providerApiKeyEnv: "TEST_API_KEY" },
            },
          })
          expect(migratedRoute?.main.providerOptions).toEqual({ gatewayProtocol: "opaque" })
          expect(migratedRoute?.main).not.toHaveProperty("gatewayProtocol")
          expect(migratedRoute?.main).not.toHaveProperty("gatewayBaseUrl")
          expect(migratedRoute?.main).not.toHaveProperty("gatewayAuth")
          expect(storedTurns.find((turn) => turn.id === "legacy-unpinned-turn")?.executionRoute).toBeDefined()
          expect(yield* transcripts.get(Turn.TurnId.make("completed-turn"))).toMatchObject({
            revision: 1,
            modelPhase: -1,
            checkpointCursor: "completed-cursor",
            costUsd: 0.5,
            units: [{ content: { _tag: "Entry", role: "user", text: "completed prompt" } }],
          })
          expect(yield* transcripts.page(id)).toMatchObject({
            entries: [{ turn: { id: "completed-turn" }, unit: { key: "completed-turn:user" } }],
          })
          expect(yield* turns.readQueue(id)).toMatchObject({
            revision: 1,
            queuedCount: 1,
            turns: [{ id: "queued-turn", prompt: "queued prompt" }],
          })
          expect(yield* turns.editQueued(Turn.TurnId.make("queued-turn"), "edited queued prompt", 7)).toMatchObject({
            prompt: "edited queued prompt",
            queue: { revision: 2, queuedCount: 1 },
          })
          const wake = yield* turns.requestQueueWake(id)
          expect(wake).toEqual({ threadId: id, generation: 1, queueRevision: 2 })
          expect(yield* turns.consumeQueueWake(id, 1)).toBe(true)
          const added = yield* create(turns, {
            id: Turn.TurnId.make("new-queued-turn"),
            threadId: id,
            prompt: "new queued prompt",
            now: 8,
          })
          expect(added).toMatchObject({ status: "queued", queue: { revision: 3, queuedCount: 2 } })
          expect(yield* turns.dequeue(added.id)).toMatchObject({ revision: 4, queuedCount: 1 })
          const migrationRows = yield* sql`SELECT migration_id, name FROM rika_migrations ORDER BY migration_id`
          expect(migrationRows.at(-1)).toEqual({ migration_id: 13, name: "provider_execution_routes" })
          expect(yield* sql`SELECT COUNT(*) AS count FROM rika_transcript_entries`).toEqual([{ count: 1 }])
        }).pipe(provideLayer(layer)),
      )
      const reopenedDatabase = Database.layer(filename)
      const reopened = Layer.mergeAll(
        reopenedDatabase,
        TurnRepository.layer.pipe(Layer.provide(reopenedDatabase)),
        TranscriptRepository.layer.pipe(Layer.provide(reopenedDatabase)),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          const sql = yield* SqlClient
          expect(yield* turns.readQueue(id)).toMatchObject({
            revision: 4,
            queuedCount: 1,
            turns: [{ id: "queued-turn", prompt: "edited queued prompt" }],
          })
          expect(yield* transcripts.get(Turn.TurnId.make("completed-turn"))).toMatchObject({
            units: [{ content: { _tag: "Entry", text: "completed prompt" } }],
          })
          expect(yield* sql`SELECT COUNT(*) AS count FROM rika_migrations`).toEqual([{ count: 13 }])
        }).pipe(provideLayer(reopened)),
      )
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("creates, persists, and reopens the current schema", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-persistence-" })
      const filename = `${directory}/rika.db`
      const database = Database.layer(filename)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
        ThreadSummaryRepository.layer.pipe(Layer.provide(database)),
        TranscriptRepository.layer.pipe(Layer.provide(database)),
      )
      yield* Effect.gen(function* () {
        const repository = yield* ThreadRepository.Service
        yield* repository.create({
          id,
          workspace: "/work/a",
          title: "First",
          now: 1,
        })
        yield* repository.label(id, ["local"], 2)
        const turns = yield* TurnRepository.Service
        yield* create(turns, {
          id: Turn.TurnId.make("turn-a"),
          threadId: id,
          prompt: "hello",
          now: 3,
        })
        yield* turns.setExtensionPin(Turn.TurnId.make("turn-a"), {
          generation: "generation-a",
          sourceDigest: "source-a",
          configFingerprint: "config-a",
          toolSchemaDigest: "tools-a",
          mcpFingerprint: "mcp-a",
          resolvedContextDigest: "context-a",
        })
        yield* turns.setStatus(Turn.TurnId.make("turn-a"), "completed", "cursor-a", 4)
        const summaries = yield* ThreadSummaryRepository.Service
        yield* summaries.replaceTurn({
          turnId: Turn.TurnId.make("turn-a"),
          threadId: id,
          projectedCursor: "cursor-a",
          complete: true,
          editTotals: { added: 3, modified: 2, removed: 1 },
          lastEventAt: 5,
          now: 5,
        })
        yield* summaries.markRead(id, 6)
        const transcript = yield* TranscriptRepository.Service
        const storedTurn = yield* turns.get(Turn.TurnId.make("turn-a"))
        if (storedTurn === undefined) return yield* Effect.die("turn-a was not stored")
        yield* transcript.replace(
          storedTurn,
          Transcript.project(storedTurn.id, storedTurn.prompt, [
            { cursor: "cursor-a", sequence: 1, type: "execution.completed", createdAt: 4 },
          ]),
        )
        yield* transcript.append(storedTurn, {
          cursor: "cursor-b",
          sequence: 2,
          type: "model.usage.reported",
          createdAt: 5,
        })
        yield* transcript.append(storedTurn, {
          cursor: "cursor-b",
          sequence: 2,
          type: "model.usage.reported",
          createdAt: 5,
        })
        const sql = yield* SqlClient
        const queryPlan = yield* sql`EXPLAIN QUERY PLAN
          SELECT u.unit_json, c.revision, t.prompt
          FROM rika_transcript_units u
          JOIN rika_transcript_checkpoints c ON c.turn_id = u.turn_id
          JOIN rika_turns t ON t.id = u.turn_id
          WHERE u.thread_id = ${id}
          ORDER BY u.created_at DESC, u.turn_id DESC, u.unit_sequence DESC, u.unit_part DESC, u.unit_key DESC
          LIMIT 51`
        const decodedPlan = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ detail: Schema.String })))(
          queryPlan,
        )
        expect(decodedPlan.map((row) => row.detail).join("\n")).not.toContain("TEMP B-TREE")
        const cursorPlan = yield* sql`EXPLAIN QUERY PLAN
          SELECT u.unit_json, c.revision, t.prompt
          FROM rika_transcript_units u
          JOIN rika_transcript_checkpoints c ON c.turn_id = u.turn_id
          JOIN rika_turns t ON t.id = u.turn_id
          WHERE u.thread_id = ${id} AND
            (u.created_at, u.turn_id, u.unit_sequence, u.unit_part, u.unit_key) <
            (${storedTurn.createdAt}, ${storedTurn.id}, 2, 0, "turn:turn-a:user")
          ORDER BY u.created_at DESC, u.turn_id DESC, u.unit_sequence DESC, u.unit_part DESC, u.unit_key DESC
          LIMIT 51`
        const decodedCursorPlan = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ detail: Schema.String })),
        )(cursorPlan)
        const cursorDetails = decodedCursorPlan.map((row) => row.detail).join("\n")
        expect(cursorDetails).toContain("rika_transcript_units_page")
        expect(cursorDetails).toContain("(created_at,turn_id,unit_sequence,unit_part,unit_key)<")
        expect(cursorDetails).not.toContain("TEMP B-TREE")
      }).pipe(provideLayer(layer))
      const reopenedDatabase = Database.layer(filename)
      const reopened = Layer.mergeAll(
        ThreadRepository.layer.pipe(Layer.provide(reopenedDatabase)),
        TurnRepository.layer.pipe(Layer.provide(reopenedDatabase)),
        ThreadSummaryRepository.layer.pipe(Layer.provide(reopenedDatabase)),
        TranscriptRepository.layer.pipe(Layer.provide(reopenedDatabase)),
      )
      return yield* Effect.gen(function* () {
        const repository = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        const summaries = yield* ThreadSummaryRepository.Service
        const transcripts = yield* TranscriptRepository.Service
        return {
          thread: yield* repository.get(id),
          turn: yield* turns.get(Turn.TurnId.make("turn-a")),
          summaries: yield* summaries.list(),
          transcript: yield* transcripts.get(Turn.TurnId.make("turn-a")),
        }
      }).pipe(provideLayer(reopened))
    }),
  )
  return Effect.runPromise(
    Effect.scoped(
      program.pipe(
        provideLayer(BunServices.layer),
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.thread?.title).toBe("First")
            expect(result.thread?.labels).toEqual(["local"])
            expect(result.turn?.status).toBe("completed")
            expect(result.turn?.lastCursor).toBe("cursor-a")
            expect(result.turn?.extensionPin).toEqual({
              generation: "generation-a",
              sourceDigest: "source-a",
              configFingerprint: "config-a",
              toolSchemaDigest: "tools-a",
              mcpFingerprint: "mcp-a",
              resolvedContextDigest: "context-a",
            })
            expect(result.summaries).toMatchObject([
              {
                id: "thread-a",
                unread: false,
                lastActivityAt: 5,
                editTotals: { added: 3, modified: 2, removed: 1 },
              },
            ])
            expect(result.transcript).toMatchObject({
              revision: 2,
              checkpointCursor: "cursor-b",
              units: [{ content: { _tag: "Entry", role: "user", text: "hello" } }],
            })
          }),
        ),
      ),
    ),
  )
})

test("reopens a completed nested transcript through the SQLite page", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-nested-transcript-" })
      const filename = `${directory}/rika.db`
      const database = Database.layer(filename)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
        TranscriptRepository.layer.pipe(Layer.provide(database)),
      )
      const expected = yield* Effect.scoped(
        Effect.gen(function* () {
          const threads = yield* ThreadRepository.Service
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          yield* threads.create({ id, workspace: "/work/nested", title: "Nested", now: 1 })
          const target = yield* create(turns, {
            id: Turn.TurnId.make("nested-turn"),
            threadId: id,
            prompt: "delegate",
            now: 2,
          })
          const completed = yield* turns.setStatus(target.id, "completed", "parent-done", 3)
          const childId = "nested-turn:child:agent"
          const parent = Transcript.project(target.id, target.prompt, [
            {
              cursor: "agent",
              sequence: 0,
              type: "tool.call.requested",
              createdAt: 2,
              data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "inspect" } },
            },
            {
              cursor: "spawned",
              sequence: 1,
              type: "child_run.spawned",
              createdAt: 2,
              data: { tool_call_id: "agent", child_execution_id: `execution:${childId}` },
            },
            { cursor: "parent-done", sequence: 2, type: "execution.completed", createdAt: 3 },
          ])
          const child = Transcript.project(childId, "", [
            {
              cursor: "answer",
              sequence: 0,
              type: "model.output.completed",
              createdAt: 3,
              text: "## Complete\n\n**Checks passed.**",
            },
            { cursor: "child-done", sequence: 1, type: "execution.completed", createdAt: 3 },
          ])
          const projection = Transcript.withNestedProjections(parent, [
            { parentId: `${target.id}:agent`, projection: child },
          ])
          yield* transcripts.replace(completed, projection)
          return projection.units
        }).pipe(provideLayer(layer)),
      )
      const reopenedDatabase = Database.layer(filename)
      const reopened = Layer.mergeAll(
        reopenedDatabase,
        TranscriptRepository.layer.pipe(Layer.provide(reopenedDatabase)),
      )
      const page = yield* Effect.scoped(
        Effect.gen(function* () {
          const transcripts = yield* TranscriptRepository.Service
          return yield* transcripts.page(id, { limit: 200 })
        }).pipe(provideLayer(reopened)),
      )
      expect(page.entries.map((entry) => entry.unit)).toEqual([...expected])
      expect(page.entries.filter((entry) => entry.unit.parentId === "nested-turn:agent")).toHaveLength(2)
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("rejects an incompatible database without mutating it", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-incompatible-" })
      const filename = `${directory}/rika.db`
      yield* Effect.sync(() => {
        const database = new NativeDatabase(filename)
        database.exec("CREATE TABLE old_sessions (id TEXT PRIMARY KEY)")
        database.close()
      })
      const before = yield* fileSystem.readFile(filename)
      const result = yield* Effect.result(Effect.scoped(Layer.build(Database.layer(filename))))
      const after = yield* fileSystem.readFile(filename)
      const files = yield* fileSystem.readDirectory(directory)
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
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(String(result.failure)).toContain("Use a fresh Rika data root")
      expect([...after]).toEqual([...before])
      expect(files).toEqual(["rika.db"])
      expect(names).toEqual(["old_sessions"])
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("rejects partial and future schemas without changing them", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-schema-shape-" })
      const partial = `${directory}/partial.db`
      yield* Effect.sync(() => {
        const database = new NativeDatabase(partial)
        database.exec("CREATE TABLE rika_workspaces (path TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL)")
        database.close()
      })
      const partialBefore = yield* fileSystem.readFile(partial)
      const partialResult = yield* Effect.result(Effect.scoped(Layer.build(Database.layer(partial))))
      expect(partialResult._tag).toBe("Failure")
      if (partialResult._tag === "Failure")
        expect(String(partialResult.failure)).toContain("Use a fresh Rika data root")
      expect([...(yield* fileSystem.readFile(partial))]).toEqual([...partialBefore])

      const extra = `${directory}/extra.db`
      yield* Effect.scoped(Layer.build(Database.layer(extra)))
      yield* Effect.sync(() => {
        const database = new NativeDatabase(extra)
        database.exec(`
          INSERT INTO rika_migrations (migration_id, name) VALUES (14, 'future_schema');
          CREATE TABLE future_product_state (id TEXT PRIMARY KEY);
        `)
        database.close()
      })
      const extraBefore = yield* fileSystem.readFile(extra)
      const extraResult = yield* Effect.result(Effect.scoped(Layer.build(Database.layer(extra))))
      expect(extraResult._tag).toBe("Failure")
      if (extraResult._tag === "Failure") expect(String(extraResult.failure)).toContain("Use a fresh Rika data root")
      expect([...(yield* fileSystem.readFile(extra))]).toEqual([...extraBefore])
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("rejects a corrupt database without changing it", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-corrupt-" })
      const filename = `${directory}/rika.db`
      yield* fileSystem.writeFile(filename, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))
      const before = yield* fileSystem.readFile(filename)
      const result = yield* Effect.result(Effect.scoped(Layer.build(Database.layer(filename))))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(String(result.failure)).toContain("Use a fresh Rika data root")
      expect([...(yield* fileSystem.readFile(filename))]).toEqual([...before])
      expect(yield* fileSystem.readDirectory(directory)).toEqual(["rika.db"])
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

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
        yield* transcripts.replace(turn, Transcript.empty(turn.id, turn.prompt))
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
        yield* turns.setStatus(active.id, "completed", undefined, 7)
        expect((yield* turns.claimNextQueued(id, 8))?.id).toBe(second.id)
        expect((yield* turns.list(id)).map((turn) => turn.id)).toEqual([active.id, second.id])
      }).pipe(provideLayer(layer))
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
            TurnRepository.QueueFull.make({ threadId: id, capacity: 3, count: 3 }),
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
        expect((yield* turns.claimNextQueued(requeueThread, 4))?.id).toBe(accepted.id)

        const copied = yield* turns.copy(
          {
            id: Turn.TurnId.make("sqlite-copied-queued"),
            threadId: copyThread,
            prompt: "copied",
            executionRoute: Turn.testExecutionRoute(),
            status: "queued",
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
                id: overflowId,
                threadId: copyThread,
                prompt: "overflow",
                executionRoute: Turn.testExecutionRoute(),
                status: "queued",
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
        const claimed = yield* turns.claimNextQueued(id, 201)
        expect(claimed?.queue).toMatchObject({ revision: 5, queuedCount: 3 })
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
