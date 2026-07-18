import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator"
import { Cause, Effect, Exit, FileSystem, Layer, Path, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

const baseline = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE rika_workspaces (
    path TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL
  )`
  yield* sql`CREATE TABLE rika_threads (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL UNIQUE,
    workspace TEXT NOT NULL REFERENCES rika_workspaces(path),
    title TEXT NOT NULL,
    labels_json TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`CREATE INDEX rika_threads_listing ON rika_threads (pinned DESC, updated_at DESC, id ASC)`
})

const turns = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE rika_turns (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
    last_cursor TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`CREATE INDEX rika_turns_thread ON rika_turns (thread_id, created_at ASC, id ASC)`
})

const queuedTurns = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE rika_turns_next (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
    last_cursor TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`INSERT INTO rika_turns_next SELECT * FROM rika_turns`
  yield* sql`DROP TABLE rika_turns`
  yield* sql`ALTER TABLE rika_turns_next RENAME TO rika_turns`
  yield* sql`CREATE INDEX rika_turns_thread ON rika_turns (thread_id, created_at ASC, id ASC)`
})

const executionExtensionPins = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_turns ADD COLUMN extension_pin_json TEXT`
})

const turnPromptParts = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_turns ADD COLUMN prompt_parts_json TEXT`
})

const dropThreadSessionId = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE rika_threads_next (
    id TEXT PRIMARY KEY NOT NULL,
    workspace TEXT NOT NULL REFERENCES rika_workspaces(path),
    title TEXT NOT NULL,
    labels_json TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`INSERT INTO rika_threads_next SELECT id, workspace, title, labels_json, pinned, archived, created_at, updated_at FROM rika_threads`
  yield* sql`DROP TABLE rika_threads`
  yield* sql`ALTER TABLE rika_threads_next RENAME TO rika_threads`
  yield* sql`CREATE INDEX rika_threads_listing ON rika_threads (pinned DESC, updated_at DESC, id ASC)`
})

const executionRoutePins = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_turns ADD COLUMN execution_route_json TEXT`
})

const reviewFanOutOwners = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_turns ADD COLUMN review_fan_out_id TEXT`
})

const transcriptProjection = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE rika_transcript_entries (
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
  )`
  yield* sql`CREATE INDEX rika_transcript_page ON rika_transcript_entries (thread_id, created_at DESC, turn_id DESC)`
})

const threadSummaries = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE rika_thread_turn_activity (
    turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    projected_cursor TEXT,
    complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
    added INTEGER NOT NULL DEFAULT 0 CHECK (added >= 0),
    modified INTEGER NOT NULL DEFAULT 0 CHECK (modified >= 0),
    removed INTEGER NOT NULL DEFAULT 0 CHECK (removed >= 0),
    last_event_at INTEGER,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`CREATE INDEX rika_thread_turn_activity_summary ON rika_thread_turn_activity (thread_id, last_event_at DESC)`
  yield* sql`CREATE TABLE rika_thread_read_state (
    thread_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    last_read_at INTEGER NOT NULL
  )`
})

const semanticTranscriptProjection = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE rika_transcript_checkpoints (
    turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    drafts_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT -1,
    projection_version INTEGER NOT NULL DEFAULT 2,
    oldest_cursor TEXT,
    checkpoint_cursor TEXT,
    cost_usd REAL,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`CREATE TABLE rika_transcript_units (
    unit_key TEXT PRIMARY KEY NOT NULL,
    turn_id TEXT NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    unit_sequence INTEGER NOT NULL,
    unit_part INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    unit_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`CREATE INDEX rika_transcript_units_page ON rika_transcript_units (
    thread_id, created_at DESC, turn_id DESC, unit_sequence DESC, unit_part DESC, unit_key DESC
  )`
  yield* sql`CREATE INDEX rika_transcript_units_turn ON rika_transcript_units (
    turn_id, unit_sequence ASC, unit_part ASC, unit_key ASC
  )`
})

const legacyExecutionRoute = JSON.stringify({
  version: 1,
  mode: "test",
  main: {
    role: "main",
    alias: "legacy-unavailable",
    provider: "legacy-unavailable",
    model: "legacy-unavailable",
    registrationKey: "legacy-unavailable",
    gatewayProtocol: "test",
    gatewayBaseUrl: "test://legacy-unavailable",
    gatewayAuth: "none",
    effort: "medium",
    fast: false,
    requestVariant: "legacy-unavailable",
    compaction: { contextWindow: 1, reserveTokens: 0, keepRecentTokens: 0 },
  },
  oracle: {
    role: "oracle",
    alias: "legacy-unavailable",
    provider: "legacy-unavailable",
    model: "legacy-unavailable",
    registrationKey: "legacy-unavailable",
    gatewayProtocol: "test",
    gatewayBaseUrl: "test://legacy-unavailable",
    gatewayAuth: "none",
    effort: "medium",
    fast: false,
    requestVariant: "legacy-unavailable",
    compaction: { contextWindow: 1, reserveTokens: 0, keepRecentTokens: 0 },
  },
})

const queueStateAndCurrentTranscripts = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`UPDATE rika_turns SET execution_route_json = ${legacyExecutionRoute} WHERE execution_route_json IS NULL`
  yield* sql`ALTER TABLE rika_transcript_checkpoints ADD COLUMN model_phase INTEGER NOT NULL DEFAULT -1`
  yield* sql`CREATE INDEX rika_turns_queue ON rika_turns (thread_id, status, created_at ASC, id ASC)`
  yield* sql`CREATE TABLE rika_thread_queue_state (
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    queued_count INTEGER NOT NULL DEFAULT 0 CHECK (queued_count >= 0),
    wake_generation INTEGER NOT NULL DEFAULT 0 CHECK (wake_generation >= 0),
    wake_pending INTEGER NOT NULL DEFAULT 0 CHECK (wake_pending IN (0, 1)),
    PRIMARY KEY (thread_id)
  )`
  yield* sql`INSERT INTO rika_thread_queue_state (thread_id, revision, queued_count)
    SELECT thread_id, COUNT(*), COUNT(*)
    FROM rika_turns
    WHERE status = 'queued'
    GROUP BY thread_id`
})

const rewriteModelRouteProvider = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  const source = value as Record<string, unknown>
  const result = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => key !== "gatewayProtocol" && key !== "gatewayBaseUrl" && key !== "gatewayAuth",
    ),
  )
  if (typeof source.gatewayProtocol === "string") result.providerProtocol = source.gatewayProtocol
  if (typeof source.gatewayBaseUrl === "string") result.providerBaseUrl = source.gatewayBaseUrl
  if (typeof source.gatewayAuth === "string" && source.gatewayAuth.startsWith("bearer-env:"))
    result.providerApiKeyEnv = source.gatewayAuth.slice("bearer-env:".length)
  return result
}

const providerExecutionRoutes = Effect.gen(function* () {
  const sql = yield* SqlClient
  const rows = yield* sql<{ readonly id: string; readonly route: string }>`
    SELECT id, execution_route_json AS route FROM rika_turns WHERE execution_route_json IS NOT NULL
  `
  for (const row of rows) {
    const source = (yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(row.route)) as Record<
      string,
      unknown
    >
    const agents = source.agents as Record<string, unknown> | undefined
    const route = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
      ...source,
      main: rewriteModelRouteProvider(source.main),
      oracle: rewriteModelRouteProvider(source.oracle),
      ...(source.title === undefined ? {} : { title: rewriteModelRouteProvider(source.title) }),
      ...(source.compactionSummary === undefined
        ? {}
        : { compactionSummary: rewriteModelRouteProvider(source.compactionSummary) }),
      ...(agents === undefined
        ? {}
        : {
            agents: Object.fromEntries(
              Object.entries(agents).map(([name, value]) => [name, rewriteModelRouteProvider(value)]),
            ),
          }),
    })
    yield* sql`UPDATE rika_turns SET execution_route_json = ${route} WHERE id = ${row.id}`
  }
})

const durableQueueClaims = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_turns ADD COLUMN queue_claim_token TEXT`
  yield* sql`CREATE UNIQUE INDEX rika_turns_queue_claim ON rika_turns (thread_id) WHERE queue_claim_token IS NOT NULL`
})

const migrationNames = [
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
  "queue_state_and_current_transcripts",
  "provider_execution_routes",
  "durable_queue_claims",
] as const

const migrations = SqliteMigrator.fromRecord({
  "1_product_baseline": baseline,
  "2_turns": turns,
  "3_queued_turn_status": queuedTurns,
  "4_execution_extension_pins": executionExtensionPins,
  "5_turn_prompt_parts": turnPromptParts,
  "6_drop_thread_session_id": dropThreadSessionId,
  "7_execution_route_pins": executionRoutePins,
  "8_review_fan_out_owners": reviewFanOutOwners,
  "9_transcript_projection": transcriptProjection,
  "10_thread_summaries": threadSummaries,
  "11_semantic_transcript_projection": semanticTranscriptProjection,
  "12_queue_state_and_current_transcripts": queueStateAndCurrentTranscripts,
  "13_provider_execution_routes": providerExecutionRoutes,
  "14_durable_queue_claims": durableQueueClaims,
})

const migrationTableObjects = ["table:rika_migrations"]
const baselineObjects = [
  ...migrationTableObjects,
  "table:rika_workspaces",
  "table:rika_threads",
  "index:rika_threads_listing",
]
const turnObjects = [...baselineObjects, "table:rika_turns", "index:rika_turns_thread"]
const transcriptObjects = [...turnObjects, "table:rika_transcript_entries", "index:rika_transcript_page"]
const summaryObjects = [
  ...transcriptObjects,
  "table:rika_thread_turn_activity",
  "index:rika_thread_turn_activity_summary",
  "table:rika_thread_read_state",
]
const semanticTranscriptObjects = [
  ...summaryObjects,
  "table:rika_transcript_checkpoints",
  "table:rika_transcript_units",
  "index:rika_transcript_units_page",
  "index:rika_transcript_units_turn",
]
const queueObjects = [...semanticTranscriptObjects, "index:rika_turns_queue", "table:rika_thread_queue_state"]
const currentObjects = [...queueObjects, "index:rika_turns_queue_claim"]
const schemaObjectsByMigration: ReadonlyArray<ReadonlyArray<string>> = [
  migrationTableObjects,
  baselineObjects,
  turnObjects,
  turnObjects,
  turnObjects,
  turnObjects,
  turnObjects,
  turnObjects,
  turnObjects,
  transcriptObjects,
  summaryObjects,
  semanticTranscriptObjects,
  queueObjects,
  queueObjects,
  currentObjects,
]

const SchemaObject = Schema.Struct({ type: Schema.String, name: Schema.String })
const MigrationRow = Schema.Struct({ migration_id: Schema.Finite, name: Schema.String })

export class ProductDatabaseError extends Schema.TaggedErrorClass<ProductDatabaseError>()("ProductDatabaseError", {
  message: Schema.String,
}) {}

const incompatible = "Rika product database does not match the current schema. Use a fresh Rika data root."
const fail = (message: string) => ProductDatabaseError.make({ message })
const inspectDatabase = Effect.fn("ProductDatabase.inspect")(function* () {
  const sql = yield* SqlClient
  const objects = yield* sql`SELECT type, name
    FROM sqlite_schema
    WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'
    ORDER BY type ASC, name ASC`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SchemaObject))),
    Effect.mapError((error) => fail(`Could not inspect the Rika product database: ${String(error)}`)),
  )
  const hasMigrationTable = objects.some((object) => object.type === "table" && object.name === "rika_migrations")
  const migrationRows = hasMigrationTable
    ? yield* sql`SELECT migration_id, name FROM rika_migrations ORDER BY migration_id ASC`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MigrationRow))),
        Effect.mapError((error) => fail(`Could not inspect Rika product database migrations: ${String(error)}`)),
      )
    : []
  return { objects, migrationRows }
})

const validateKnown = (state: Effect.Success<ReturnType<typeof inspectDatabase>>) =>
  Effect.gen(function* () {
    if (state.objects.length === 0) return "fresh" as const
    for (const [index, row] of state.migrationRows.entries())
      if (row.migration_id !== index + 1 || row.name !== migrationNames[index]) return yield* fail(incompatible)
    const expected = schemaObjectsByMigration[state.migrationRows.length]
    if (expected === undefined) return yield* fail(incompatible)
    const actual = new Set(state.objects.map((object) => `${object.type}:${object.name}`))
    if (actual.size !== expected.length || expected.some((key) => !actual.has(key))) return yield* fail(incompatible)
    return "tracked" as const
  })

const inspectExisting = (filename: string) =>
  Effect.gen(function* () {
    const inspect = (candidate: string) =>
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              SqliteClient.layer({
                filename: candidate,
                readonly: true,
                readwrite: false,
                create: false,
                disableWAL: true,
              }),
            )
            return yield* inspectDatabase().pipe(Effect.provide(context))
          }),
        ),
      )
    const initial = yield* inspect(filename)
    const outcome = yield* Exit.match(initial, {
      onSuccess: (value) => Effect.succeed(Exit.succeed(value)),
      onFailure: () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          if (yield* fileSystem.exists(`${filename}-wal`)) return initial
          const path = yield* Path.Path
          const fileUrl = yield* path
            .toFileUrl(filename)
            .pipe(
              Effect.mapError((error) => fail(`Could not resolve the Rika product database path: ${String(error)}`)),
            )
          fileUrl.searchParams.set("immutable", "1")
          return yield* inspect(fileUrl.href)
        }),
    })
    if (Exit.isFailure(outcome))
      return yield* fail(
        `Could not open the Rika product database without changing it: ${Cause.pretty(outcome.cause)}. Use a fresh Rika data root.`,
      )
    return outcome.value
  })

const sqliteHeader = new TextEncoder().encode("SQLite format 3\u0000")
const isFreshDatabaseFile = Effect.fn("ProductDatabase.isFreshDatabaseFile")(function* (filename: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const bytes = yield* fileSystem
    .readFile(filename)
    .pipe(Effect.mapError((error) => fail(`Could not inspect the Rika product database file: ${String(error)}`)))
  const structurallyFresh = (() => {
    if (bytes.length === 0) return true
    if (bytes.length < 105 || sqliteHeader.some((byte, index) => bytes[index] !== byte)) return false
    const pageCount = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(28)
    const cellCount = ((bytes[103] ?? 0) << 8) | (bytes[104] ?? 0)
    return pageCount === 1 && bytes[100] === 13 && cellCount === 0
  })()
  if (!structurallyFresh) return false
  const [walExists, shmExists] = yield* Effect.all([
    fileSystem.exists(`${filename}-wal`),
    fileSystem.exists(`${filename}-shm`),
  ]).pipe(Effect.mapError((error) => fail(`Could not inspect the Rika product database files: ${String(error)}`)))
  if (!walExists && !shmExists) return true
  if (bytes.length === 0 || !walExists) return yield* fail(incompatible)
  const wal = yield* fileSystem
    .readFile(`${filename}-wal`)
    .pipe(Effect.mapError((error) => fail(`Could not inspect the Rika product database WAL: ${String(error)}`)))
  if (wal.length < 32) return yield* fail(incompatible)
  const walMagic = new DataView(wal.buffer, wal.byteOffset, wal.byteLength).getUint32(0)
  if (walMagic !== 0x377f0682 && walMagic !== 0x377f0683) return yield* fail(incompatible)
  return false
})

const preflight = Effect.fn("ProductDatabase.preflight")(function* (filename: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const exists = yield* fileSystem
    .exists(filename)
    .pipe(Effect.mapError((error) => fail(`Could not inspect the Rika product database path: ${String(error)}`)))
  if (!exists) return "fresh" as const
  if (yield* isFreshDatabaseFile(filename)) return "fresh" as const
  return yield* validateKnown(yield* inspectExisting(filename))
})

const enableForeignKeys = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`PRAGMA foreign_keys = ON`.pipe(
    Effect.mapError((error) => fail(`Could not enable Rika product database constraints: ${String(error)}`)),
  )
})

const validateCurrent = Effect.gen(function* () {
  const state = yield* inspectDatabase()
  yield* validateKnown(state)
  if (state.migrationRows.length !== migrationNames.length) return yield* fail(incompatible)
})

const prepare = SqliteMigrator.run({ loader: migrations, table: "rika_migrations" }).pipe(
  Effect.mapError((error) => fail(`Could not migrate the Rika product database: ${String(error)}`)),
  Effect.andThen(enableForeignKeys),
  Effect.andThen(validateCurrent),
)

const directoryLayer = (filename: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fileSystem.makeDirectory(path.dirname(filename), { recursive: true })
    }),
  )

const currentLayer = (filename: string) =>
  Layer.effectDiscard(prepare).pipe(Layer.provideMerge(SqliteClient.layer({ filename })))

export const layer = (filename: string) =>
  Layer.unwrap(preflight(filename).pipe(Effect.as(currentLayer(filename)))).pipe(
    Layer.provideMerge(directoryLayer(filename)),
  )
