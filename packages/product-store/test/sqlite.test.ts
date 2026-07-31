import * as BunServices from "@effect/platform-bun/BunServices"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptNestedProjection from "@rika/transcript/nested-transcript-projection"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import { expect, test } from "vitest"
import { Database as NativeDatabase } from "bun:sqlite"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Database from "@rika/product-store/product-database-layer"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as ThreadSummaryRepository from "@rika/product-store/sqlite-thread-summary-repository"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as Turn from "@rika/product/turn-record"
import {
  attachedExecutionCheckpoint,
  commitAll,
  executionCheckpoint,
  projectionVersion,
} from "./transcript-repository-fixtures"

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

test("migrates a pre-branch database while invalidating its rebuildable transcript projection", () => {
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
          const storedAgentTurns = storedTurns.filter(Turn.isAgentExecution)
          expect(storedTurns.map((turn) => String(turn.id))).toEqual([
            "completed-turn",
            "legacy-unpinned-turn",
            "queued-turn",
          ])
          const migratedRoute = storedAgentTurns.find((turn) => turn.id === "completed-turn")?.executionRoute
          expect(migratedRoute).toMatchObject({
            main: {
              providerConnection: {
                provider: "test",
                protocol: "test",
                baseUrl: "test://model",
                authentication: "api-key",
                apiKeyEnvironment: "TEST_API_KEY",
              },
            },
            oracle: { providerConnection: { authentication: "api-key", apiKeyEnvironment: "TEST_API_KEY" } },
            title: { providerConnection: { authentication: "api-key", apiKeyEnvironment: "TEST_API_KEY" } },
            compactionSummary: { providerConnection: { authentication: "api-key", apiKeyEnvironment: "TEST_API_KEY" } },
            agents: { task: { providerConnection: { authentication: "api-key", apiKeyEnvironment: "TEST_API_KEY" } } },
          })
          expect(migratedRoute?.main.providerOptions).toEqual({ gatewayProtocol: "opaque" })
          expect(migratedRoute?.main).not.toHaveProperty("gatewayProtocol")
          expect(migratedRoute?.main).not.toHaveProperty("gatewayBaseUrl")
          expect(migratedRoute?.main).not.toHaveProperty("gatewayAuth")
          expect(storedAgentTurns.find((turn) => turn.id === "legacy-unpinned-turn")?.executionRoute).toBeDefined()
          expect(yield* transcripts.get(Turn.TurnId.make("completed-turn"))).toMatchObject({
            revision: 1,
            modelPhase: -1,
            checkpointCursor: undefined,
            costUsd: undefined,
            projectionVersion: 2,
            units: [],
          })
          expect(yield* transcripts.page(id)).toMatchObject({ entries: [] })
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
          expect(migrationRows.at(-1)).toEqual({ migration_id: 28, name: "product_route_snapshot" })
          expect(yield* sql`SELECT name FROM sqlite_schema WHERE name = 'rika_transcript_entries'`).toEqual([])
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
            projectionVersion: 2,
            units: [],
          })
          expect(yield* sql`SELECT COUNT(*) AS count FROM rika_migrations`).toEqual([{ count: 28 }])
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
        const summaries = yield* ThreadSummaryRepository.Service
        yield* summaries.ensureTurn(Turn.TurnId.make("turn-a"), id, 100)
        expect((yield* summaries.list())[0]?.lastActivityAt).toBe(3)
        yield* turns.setExtensionPin(Turn.TurnId.make("turn-a"), {
          generation: "generation-a",
          sourceDigest: "source-a",
          configFingerprint: "config-a",
          toolSchemaDigest: "tools-a",
          mcpFingerprint: "mcp-a",
          resolvedContextDigest: "context-a",
        })
        yield* turns.setStatus(Turn.TurnId.make("turn-a"), "completed", "cursor-a", 4)
        expect(yield* turns.repairCursor(Turn.TurnId.make("turn-a"), "completed", "stale", "cursor-repaired")).toBe(
          false,
        )
        expect(yield* turns.repairCursor(Turn.TurnId.make("turn-a"), "completed", "cursor-a", "cursor-repaired")).toBe(
          true,
        )
        expect(yield* turns.get(Turn.TurnId.make("turn-a"))).toMatchObject({
          lastCursor: "cursor-repaired",
          updatedAt: 4,
        })
        expect(yield* turns.repairCursor(Turn.TurnId.make("turn-a"), "completed", "cursor-repaired", "cursor-a")).toBe(
          true,
        )
        yield* summaries.replaceTurn({
          turnId: Turn.TurnId.make("turn-a"),
          threadId: id,
          projectedCursor: "cursor-a",
          complete: true,
          editTotals: { added: 3, modified: 2, removed: 1 },
          lastEventAt: 5,
          now: 101,
        })
        yield* summaries.markRead(id, 6)
        yield* summaries.markRead(id, 1)
        yield* repository.setPinned(id, true, 100)
        expect(yield* summaries.list()).toMatchObject([
          { id, pinned: true, unread: false, lastActivityAt: 5, editTotals: { added: 3, modified: 2, removed: 1 } },
        ])
        yield* summaries.replaceTurn({
          turnId: Turn.TurnId.make("turn-a"),
          threadId: id,
          projectedCursor: "cursor-a",
          complete: false,
          editTotals: { added: 99, modified: 99, removed: 99 },
          lastEventAt: 5,
          now: 102,
        })
        expect((yield* summaries.list())[0]?.editTotals).toBeUndefined()
        expect(yield* summaries.listRepairCandidates()).toMatchObject([{ turnId: "turn-a", lastCursor: "cursor-a" }])
        yield* summaries.replaceTurn({
          turnId: Turn.TurnId.make("turn-a"),
          threadId: id,
          projectedCursor: "cursor-a",
          complete: true,
          editTotals: { added: 3, modified: 2, removed: 1 },
          lastEventAt: 5,
          now: 103,
        })
        expect(yield* turns.repairCursor(Turn.TurnId.make("turn-a"), "completed", "cursor-a", "")).toBe(true)
        yield* summaries.replaceTurn({
          turnId: Turn.TurnId.make("turn-a"),
          threadId: id,
          complete: true,
          editTotals: { added: 3, modified: 2, removed: 1 },
          lastEventAt: 5,
          now: 104,
        })
        expect((yield* summaries.list())[0]?.editTotals).toBeUndefined()
        expect(yield* summaries.listRepairCandidates()).toMatchObject([{ lastCursor: "" }])
        expect(yield* turns.repairCursor(Turn.TurnId.make("turn-a"), "completed", "", undefined)).toBe(true)
        yield* summaries.replaceTurn({
          turnId: Turn.TurnId.make("turn-a"),
          threadId: id,
          projectedCursor: "",
          complete: true,
          editTotals: { added: 3, modified: 2, removed: 1 },
          lastEventAt: 5,
          now: 105,
        })
        expect((yield* summaries.list())[0]?.editTotals).toBeUndefined()
        const missingCursorCandidates = yield* summaries.listRepairCandidates()
        expect(missingCursorCandidates).toHaveLength(1)
        expect(missingCursorCandidates[0]).not.toHaveProperty("lastCursor")
        expect(yield* turns.repairCursor(Turn.TurnId.make("turn-a"), "completed", undefined, "cursor-a")).toBe(true)
        yield* summaries.replaceTurn({
          turnId: Turn.TurnId.make("turn-a"),
          threadId: id,
          projectedCursor: "cursor-a",
          complete: true,
          editTotals: { added: 3, modified: 2, removed: 1 },
          lastEventAt: 5,
          now: 106,
        })
        const transcript = yield* TranscriptRepository.Service
        const storedTurn = yield* turns.get(Turn.TurnId.make("turn-a"))
        if (storedTurn === undefined || !Turn.isAgentExecution(storedTurn))
          return yield* Effect.die("turn-a was not stored as an agent execution")
        const projection = TranscriptProjection.Projection.project(storedTurn.id, storedTurn.prompt, [
          { cursor: "cursor-a", sequence: 1, type: "execution.completed", createdAt: 4 },
        ])
        yield* commitAll(transcript, storedTurn, projection, undefined)
        yield* transcript.commitDelta(
          storedTurn,
          TranscriptProjection.Projection.projectionState({ ...projection, revision: 2, checkpointCursor: "cursor-b" }),
          { upsert: [], remove: [] },
          {
            executionCheckpoints: [
              executionCheckpoint(storedTurn, { ...projection, revision: 2, checkpointCursor: "cursor-b" }),
            ],
            projectionVersion,
            expectedGeneration: 0,
          },
        )
        const beforeRejectedReplacement = yield* transcript.get(storedTurn.id)
        const malformed = {
          ...TranscriptProjection.Projection.project(storedTurn.id, storedTurn.prompt, [
            { cursor: "cursor-c", sequence: 3, type: "model.output.completed", createdAt: 6, text: "invalid" },
          ]),
          units: [
            {
              key: "invalid",
              turnId: storedTurn.id,
              order: { sequence: 3, part: 0 },
              revision: 3,
              content: { _tag: "Entry", role: "invalid", text: "invalid" },
            },
          ],
        } as unknown as TranscriptProjectionModel.Projection
        expect(
          (yield* Effect.result(
            transcript.commitDelta(
              storedTurn,
              TranscriptProjection.Projection.projectionState(malformed),
              { upsert: malformed.units, remove: [] },
              {
                executionCheckpoints: [executionCheckpoint(storedTurn, malformed)],
                projectionVersion,
                expectedGeneration: 1,
              },
            ),
          ))._tag,
        ).toBe("Failure")
        expect(yield* transcript.get(storedTurn.id)).toEqual(beforeRejectedReplacement)
        const sql = yield* SqlClient
        const queryPlan = yield* sql`EXPLAIN QUERY PLAN
          SELECT u.unit_json, c.revision, t.prompt
          FROM rika_transcript_units u
          JOIN rika_transcript_checkpoints c ON c.turn_id = u.turn_id
          JOIN rika_turns t ON t.id = u.turn_id
          WHERE u.thread_id = ${id}
          ORDER BY u.created_at DESC, u.turn_id DESC, u.unit_order_key DESC
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
            (u.created_at, u.turn_id, u.unit_order_key) <
            (${storedTurn.createdAt}, ${storedTurn.id}, ${TranscriptOrdering.encodeUnitOrder(projection.units[0]!.order)})
          ORDER BY u.created_at DESC, u.turn_id DESC, u.unit_order_key DESC
          LIMIT 51`
        const decodedCursorPlan = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ detail: Schema.String })),
        )(cursorPlan)
        const cursorDetails = decodedCursorPlan.map((row) => row.detail).join("\n")
        expect(cursorDetails).toContain("rika_transcript_units_page")
        expect(cursorDetails).toContain("(created_at,turn_id,unit_order_key)<")
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
            expect(
              result.turn !== undefined && Turn.isAgentExecution(result.turn) ? result.turn.lastCursor : undefined,
            ).toBe("cursor-a")
            expect(
              result.turn !== undefined && Turn.isAgentExecution(result.turn) ? result.turn.extensionPin : undefined,
            ).toEqual({
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
          const parent = TranscriptProjection.Projection.project(target.id, target.prompt, [
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
          const child = TranscriptProjection.Projection.project(childId, "", [
            {
              cursor: "answer",
              sequence: 0,
              type: "model.output.completed",
              createdAt: 3,
              text: "## Complete\n\n**Checks passed.**",
            },
            { cursor: "child-done", sequence: 1, type: "execution.completed", createdAt: 3 },
          ])
          const projection = TranscriptNestedProjection.withNestedProjections(parent, [
            { parentId: `${target.id}:agent`, projection: child },
          ])
          const parentTool = parent.units.find(
            (unit) => unit.content._tag === "Block" && unit.content.block._tag === "ToolCall",
          )
          if (parentTool === undefined) return yield* Effect.die("nested transcript had no parent tool")
          yield* commitAll(transcripts, completed, projection, undefined, projectionVersion, [
            executionCheckpoint(completed, projection),
            attachedExecutionCheckpoint(
              childId,
              child,
              TranscriptCorrelation.executionKey(String(target.id)),
              parentTool,
              "completed",
            ),
          ])
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
          INSERT INTO rika_migrations (migration_id, name) VALUES (15, 'future_schema');
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

