import * as BunServices from "@effect/platform-bun/BunServices"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { StartTurn } from "@rika/product/execution-gateway"
import { ExecutionRouteSnapshot, testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { SteeringAdmission } from "@rika/product/turn-repository-steering"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { layer } from "../src/database/product-database-layer"
import { schemaFingerprint } from "../src/database/product-schema"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const ExecutionRouteJson = Schema.fromJsonString(ExecutionRouteSnapshot)
const StartTurnJson = Schema.fromJsonString(StartTurn)
const SteeringAdmissionJson = Schema.fromJsonString(SteeringAdmission)

const legacyExecutionRoute = (version: 1 | 2) => {
  type MutableModel = Record<string, unknown> & {
    selection?: unknown
    alias?: unknown
    candidates: Array<{ providerConnection: Record<string, unknown> }>
  }
  const route = structuredClone(testExecutionRoute()) as unknown as {
    version: number
    subagents?: unknown
    main: MutableModel
    oracle: MutableModel
    title: MutableModel
    compactionSummary: MutableModel
    agents: Record<string, MutableModel>
  }
  route.version = version
  if (version === 1) delete route.subagents
  for (const model of [
    route.main,
    route.oracle,
    route.title,
    route.compactionSummary,
    ...Object.values(route.agents),
  ]) {
    model.alias = model.selection
    delete model.selection
    for (const candidate of model.candidates) {
      candidate.providerConnection = {
        provider: "openai",
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        authentication: "api-key",
        apiKeyEnvironment: "OPENAI_API_KEY",
      }
    }
  }
  return route
}

it.layer(BunServices.layer)("product database", (test) => {
  test.effect("builds the one current schema in a fresh database", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-product-database-" })
        const context = yield* Layer.build(layer(`${directory}/rika.db`))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          const objects = yield* sql`SELECT name FROM sqlite_schema
            WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
            ORDER BY name`
          const names = objects.map((row) => String((row as { readonly name: unknown }).name))
          expect(names).toContain("rika_thread_queue_state")
          expect(
            (yield* sql`PRAGMA table_info(rika_thread_queue_state)`).map((row) =>
              String((row as { readonly name: unknown }).name),
            ),
          ).toEqual(["thread_id", "revision", "queued_count"])
          expect(names).toContain("rika_turns_queue")
          expect(names).toContain("rika_turns_queue_claim")
          expect(names).toContain("rika_turn_admission_outbox")
          expect(
            (yield* sql`PRAGMA table_info(rika_turn_admission_outbox)`).map((row) =>
              String((row as { readonly name: unknown }).name),
            ),
          ).toEqual(["turn_id", "start_input_json", "prepared_at"])
          expect(names).toContain("rika_turn_steering_outbox")
          expect(
            (yield* sql`PRAGMA table_info(rika_turn_steering_outbox)`).map((row) =>
              String((row as { readonly name: unknown }).name),
            ),
          ).toEqual([
            "request_id",
            "target_turn_id",
            "source_turn_id",
            "thread_id",
            "admission_json",
            "source_withdrawn",
            "status",
            "prepared_at",
          ])
          expect(names).toContain("rika_transcript_units")
          expect(names).toContain("rika_transcript_checkpoints")
          expect(names).not.toContain("rika_transcript_execution_checkpoints")
          expect(names).not.toContain("rika_transcript_entries")
          expect(names).toContain("rika_thread_search")
          expect(names).toContain("rika_thread_search_files")
          expect(names).not.toContain("rika_usage_repairs")
          expect(names).not.toContain("rika_turn_usage")
          expect(names).not.toContain("rika_turn_usage_thread")
          expect(names).toContain("rika_thread_picker_summary")
          expect(names).toContain("rika_turns_thread_updated")
          expect(names).toContain("rika_turns_thread_nonqueued")
          const updatedPlan = yield* sql`EXPLAIN QUERY PLAN
            SELECT MAX(updated_at) FROM rika_turns WHERE thread_id = 'thread-a'`
          expect(updatedPlan.map((row) => String((row as { readonly detail: unknown }).detail)).join(" ")).toContain(
            "rika_turns_thread_updated",
          )
          const previewPlan = yield* sql`EXPLAIN QUERY PLAN SELECT * FROM rika_turns
            WHERE thread_id = 'thread-a' AND status <> 'queued'
            ORDER BY created_at DESC, id DESC LIMIT 4`
          expect(previewPlan.map((row) => String((row as { readonly detail: unknown }).detail)).join(" ")).toContain(
            "rika_turns_thread_nonqueued",
          )
          const checkpointColumns = yield* sql`PRAGMA table_info(rika_transcript_checkpoints)`
          const columnNames = checkpointColumns.map((row) => String((row as { readonly name: unknown }).name))
          expect(columnNames).toEqual([
            "turn_id",
            "thread_id",
            "checkpoint_generation",
            "revision",
            "projection_version",
            "state_json",
            "projector_version",
            "projector_cursor",
            "projector_state",
            "updated_at",
          ])
          const unitColumns = yield* sql`PRAGMA table_info(rika_transcript_units)`
          expect(unitColumns.map((row) => String((row as { readonly name: unknown }).name))).toEqual([
            "turn_id",
            "unit_key",
            "thread_id",
            "unit_order_key",
            "parent_id",
            "revision",
            "unit_json",
            "created_at",
            "updated_at",
          ])
          const turnColumns = yield* sql`PRAGMA table_info(rika_turns)`
          const turnColumnNames = turnColumns.map((row) => String((row as { readonly name: unknown }).name))
          expect(turnColumnNames).toContain("queue_claim_token")
          expect(turnColumnNames).toContain("turn_kind")
          expect(turnColumnNames).toContain("shell_command")
          expect(turnColumnNames).toContain("shell_result_text")
          expect(turnColumnNames).toContain("shell_result_truncated")
          expect(turnColumnNames).toContain("shell_result_exit_code")
          expect(turnColumnNames).not.toContain("extension_pin_json")
          expect(turnColumnNames).not.toContain("review_fan_out_id")
          expect(turnColumnNames).toContain("execution_link_json")
          expect(yield* sql`PRAGMA foreign_keys`).toEqual([{ foreign_keys: 1 }])
        }).pipe(Effect.provide(context))
      }),
    ),
  )

  test.effect("rejects another existing database without modifying it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-product-database-reject-" })
        const filename = `${directory}/rika.db`
        const foreign = yield* Layer.build(SqliteClient.layer({ filename }))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          yield* sql`CREATE TABLE foreign_data (value TEXT NOT NULL)`
          yield* sql`INSERT INTO foreign_data (value) VALUES ('preserve')`
        }).pipe(Effect.provide(foreign))

        const result = yield* Layer.build(layer(filename)).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect(
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient
            return yield* sql`SELECT value FROM foreign_data`
          }).pipe(Effect.provide(foreign)),
        ).toEqual([{ value: "preserve" }])
      }),
    ),
  )

  test.effect("rejects drift from the current schema without modifying it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-product-database-drift-" })
        const filename = `${directory}/rika.db`
        yield* Effect.scoped(Layer.build(layer(filename)))
        const client = yield* Layer.build(SqliteClient.layer({ filename }))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          yield* sql`ALTER TABLE rika_workspaces ADD COLUMN unexpected TEXT`
          yield* sql`INSERT INTO rika_workspaces (owner_id, path, created_at, unexpected)
            VALUES ('local', '/preserve', 1, 'value')`
        }).pipe(Effect.provide(client))

        expect((yield* Layer.build(layer(filename)).pipe(Effect.exit))._tag).toBe("Failure")
        expect(
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient
            return yield* sql`SELECT unexpected FROM rika_workspaces WHERE path = '/preserve'`
          }).pipe(Effect.provide(client)),
        ).toEqual([{ unexpected: "value" }])
      }),
    ),
  )

  test.effect("migrates persisted v1 and v2 execution routes once at the schema boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-product-route-upgrade-" })
        const filename = `${directory}/rika.db`
        yield* Effect.scoped(Layer.build(layer(filename)))
        const client = yield* Layer.build(SqliteClient.layer({ filename }))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          yield* sql`DROP TABLE rika_execution_route_contract`
          const objects = yield* sql`SELECT type, name, tbl_name AS table_name, sql
            FROM sqlite_schema
            WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'
            ORDER BY type ASC, name ASC`
          yield* sql`UPDATE rika_schema_identity SET fingerprint = ${schemaFingerprint(objects as never)} WHERE id = 1`
          yield* sql`INSERT INTO rika_workspaces (owner_id, path, created_at) VALUES ('local', '/preserved', 1)`
          yield* sql`INSERT INTO rika_threads (id, owner_id, workspace, title, labels_json, created_at, updated_at)
            VALUES ('t1', 'local', '/preserved', 'Keep', '[]', 1, 1)`
          yield* sql`INSERT INTO rika_turns (id, thread_id, turn_kind, status, prompt, created_at, updated_at, execution_route_json)
            VALUES ('v1', 't1', 'AgentExecution', 'completed', 'v1', 1, 1, ${encodeJson(legacyExecutionRoute(1))})`
          yield* sql`INSERT INTO rika_turns (id, thread_id, turn_kind, status, prompt, created_at, updated_at, execution_route_json)
            VALUES ('v2', 't1', 'AgentExecution', 'completed', 'v2', 2, 2, ${encodeJson(legacyExecutionRoute(2))})`
          yield* sql`INSERT INTO rika_turn_admission_outbox (turn_id, start_input_json, prepared_at)
            VALUES ('v1', ${encodeJson({
              threadId: "t1",
              turnId: "v1",
              workspace: "/preserved",
              prompt: "v1",
              executionRoute: legacyExecutionRoute(1),
            })}, 3)`
          yield* sql`INSERT INTO rika_turn_steering_outbox
            (request_id, target_turn_id, source_turn_id, thread_id, admission_json, source_withdrawn, status, prepared_at)
            VALUES ('steer-v2', 'v2', 'v1', 't1', ${encodeJson({
              target: { runId: "run-v2", turnId: "v2", threadId: "t1" },
              input: { text: "steer", idempotencyKey: "steer-v2" },
              source: {
                _tag: "AgentExecution",
                id: "v1",
                threadId: "t1",
                prompt: "v1",
                status: "completed",
                executionRoute: legacyExecutionRoute(2),
                author: { _tag: "Human" },
                lineage: { _tag: "Original" },
                createdAt: 1,
                updatedAt: 1,
              },
              preparedAt: 4,
              outcome: { _tag: "Pending" },
            })}, 0, 'pending', 4)`
        }).pipe(Effect.provide(client))

        const reopened = yield* Layer.build(layer(filename))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          const marker = yield* sql`SELECT version FROM rika_execution_route_contract WHERE id = 1`
          const rows = yield* sql`SELECT id, execution_route_json FROM rika_turns ORDER BY id`
          const admissionRows = yield* sql`SELECT start_input_json FROM rika_turn_admission_outbox`
          const steeringRows = yield* sql`SELECT admission_json FROM rika_turn_steering_outbox`
          const routes = yield* Effect.forEach(rows, (row) =>
            Schema.decodeUnknownEffect(ExecutionRouteJson)(String(row.execution_route_json)),
          )
          const admission = yield* Schema.decodeUnknownEffect(StartTurnJson)(String(admissionRows[0]?.start_input_json))
          const steeringAdmission = yield* Schema.decodeUnknownEffect(SteeringAdmissionJson)(
            String(steeringRows[0]?.admission_json),
          )
          expect(marker).toEqual([{ version: 3 }])
          expect(routes.map((route) => route.version)).toEqual([3, 3])
          expect(routes.map((route) => route.main.selection)).toEqual(["test", "test"])
          expect(routes.map((route) => route.main.candidates[0]?.providerConnection.protocol)).toEqual([
            "openai-responses",
            "openai-responses",
          ])
          for (const route of routes) {
            const models = [
              route.main,
              route.oracle,
              route.title,
              route.compactionSummary,
              ...Object.values(route.agents),
            ]
            expect(
              models
                .flatMap((model) => model.candidates)
                .every(({ providerConnection }) => providerConnection.protocol === "openai-responses"),
            ).toBe(true)
          }
          expect(routes.map((route) => route.subagents)).toEqual([
            { maxDepth: 1, maxSubagents: 4 },
            { maxDepth: 1, maxSubagents: 4 },
          ])
          expect(admission.executionRoute).toMatchObject({
            version: 3,
            subagents: { maxDepth: 1, maxSubagents: 4 },
            main: { selection: "test", candidates: [{ providerConnection: { protocol: "openai-responses" } }] },
          })
          expect(steeringAdmission.source?.executionRoute).toMatchObject({
            version: 3,
            subagents: { maxDepth: 1, maxSubagents: 4 },
            main: { selection: "test", candidates: [{ providerConnection: { protocol: "openai-responses" } }] },
          })
          for (const row of rows) expect(String(row.execution_route_json)).not.toContain('"alias"')
          expect(String(admissionRows[0]?.start_input_json)).not.toContain('"alias"')
          expect(String(steeringRows[0]?.admission_json)).not.toContain('"alias"')
        }).pipe(Effect.provide(reopened))
      }),
    ),
  )

  test.effect("brings a database made before durable steering admission up to the current schema", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A data root outlives the version that made it, so a release that adds a table has to bring
        // it rather than tell a user their history is unreadable.
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-product-upgrade-" })
        const filename = `${directory}/rika.db`
        const built = yield* Layer.build(layer(filename))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          yield* sql`DROP TABLE rika_execution_route_contract`
          yield* sql`DROP TABLE rika_turn_steering_outbox`
          yield* sql`DROP TRIGGER rika_tombstoned_thread_turn_insert`
          yield* sql`DROP TABLE rika_thread_deletion_outbox`
          yield* sql`DROP TABLE rika_goals`
          const objects = yield* sql`SELECT type, name, tbl_name AS table_name, sql
            FROM sqlite_schema
            WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'
            ORDER BY type ASC, name ASC`
          yield* sql`UPDATE rika_schema_identity SET fingerprint = ${schemaFingerprint(objects as never)} WHERE id = 1`
        }).pipe(Effect.provide(built))
        const reopened = yield* Layer.build(layer(filename))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          const rows =
            yield* sql`SELECT name FROM sqlite_schema WHERE name IN ('rika_goals', 'rika_thread_deletion_outbox', 'rika_tombstoned_thread_turn_insert', 'rika_turn_steering_outbox')`
          expect(rows).toHaveLength(4)
        }).pipe(Effect.provide(reopened))
      }),
    ),
  )

  test.effect("upgrades the exact schema before durable steering admission and refuses drift", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-product-database-predecessor-" })
        const filename = `${directory}/rika.db`

        yield* Effect.scoped(Layer.build(layer(filename)))
        const client = yield* Layer.build(SqliteClient.layer({ filename }))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          yield* sql`DROP TABLE rika_execution_route_contract`
          yield* sql`DROP TABLE rika_turn_steering_outbox`
          const objects = yield* sql`SELECT type, name, tbl_name AS table_name, sql
            FROM sqlite_schema
            WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'
            ORDER BY type ASC, name ASC`
          yield* sql`UPDATE rika_schema_identity SET fingerprint = ${schemaFingerprint(objects as never)} WHERE id = 1`
          yield* sql`INSERT INTO rika_workspaces (owner_id, path, created_at) VALUES ('local', '/preserved', 1)`
          yield* sql`INSERT INTO rika_threads (id, owner_id, workspace, title, labels_json, created_at, updated_at)
            VALUES ('t1', 'local', '/preserved', 'Keep', '[]', 1, 1)`
          yield* sql`INSERT INTO rika_turns (id, thread_id, turn_kind, status, prompt, created_at, updated_at, execution_route_json)
            VALUES ('turn-1', 't1', 'AgentExecution', 'completed', 'keep me', 1, 1, '{}')`
        }).pipe(Effect.provide(client))

        // Reopening must accept the exact predecessor and apply only the missing additions.
        const reopened = yield* Layer.build(layer(filename))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          const names = yield* sql`SELECT name FROM sqlite_schema WHERE name = 'rika_turn_steering_outbox'`
          expect(names).toHaveLength(1)
          const rows = yield* sql`SELECT workspace FROM rika_threads WHERE id = 't1'`
          expect(rows).toEqual([{ workspace: "/preserved" }])
        }).pipe(Effect.provide(reopened))

        // An unrelated drift on top of the predecessor must be refused and left untouched.
        const drifted = `${directory}/drifted.db`
        yield* Effect.scoped(Layer.build(layer(drifted)))
        const driftedClient = yield* Layer.build(SqliteClient.layer({ filename: drifted }))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          yield* sql`DROP TABLE rika_execution_route_contract`
          yield* sql`DROP TABLE rika_turn_steering_outbox`
          const objects = yield* sql`SELECT type, name, tbl_name AS table_name, sql
            FROM sqlite_schema
            WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'
            ORDER BY type ASC, name ASC`
          yield* sql`UPDATE rika_schema_identity SET fingerprint = ${schemaFingerprint(objects as never)} WHERE id = 1`
          yield* sql`ALTER TABLE rika_workspaces ADD COLUMN unexpected TEXT`
          yield* sql`INSERT INTO rika_workspaces (owner_id, path, created_at, unexpected)
            VALUES ('local', '/drift', 1, 'value')`
        }).pipe(Effect.provide(driftedClient))
        expect((yield* Layer.build(layer(drifted)).pipe(Effect.exit))._tag).toBe("Failure")
        const preserved = yield* Layer.build(SqliteClient.layer({ filename: drifted }))
        expect(
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient
            return yield* sql`SELECT path FROM rika_workspaces`
          }).pipe(Effect.provide(preserved)),
        ).toEqual([{ path: "/drift" }])
      }),
    ),
  )
})
