import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { Database as NativeDatabase } from "bun:sqlite"
import { Effect, FileSystem, Layer } from "effect"
import * as Database from "@rika/product-store/product-database-layer"
import * as Thread from "@rika/product/thread-record"
import * as TurnContract from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"

const _id = Thread.ThreadId.make("thread-a")

const _create = (
  repository: TurnContract.Interface,
  input: Omit<Parameters<TurnContract.Interface["createForSubmission"]>[0], "executionRoute" | "queueCapacity"> & {
    readonly queueCapacity?: number
  },
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

const legacyModel = (model: ExecutionRouteSnapshot.ExecutionModelRoute) => {
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
