import * as ThreadResult from "@rika/product/thread-result"
import { expect, test } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Database from "@rika/product-store/product-database-layer"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as ThreadSummaryRepository from "@rika/product-store/sqlite-thread-summary-repository"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as Turn from "@rika/product/turn-record"
import { id, create, provideLayer } from "./sqlite-schema-support"
import { createPreBranchDatabase } from "./sqlite-schema-migration-fixtures"
import { commitAll, executionCheckpoint, projectionVersion } from "./transcript-repository-fixtures"

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
          const storedAgentTurns = storedTurns.filter(ThreadResult.TurnResult.isAgentExecution)
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
        if (storedTurn === undefined || !ThreadResult.TurnResult.isAgentExecution(storedTurn))
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
              result.turn !== undefined && ThreadResult.TurnResult.isAgentExecution(result.turn)
                ? result.turn.lastCursor
                : undefined,
            ).toBe("cursor-a")
            expect(
              result.turn !== undefined && ThreadResult.TurnResult.isAgentExecution(result.turn)
                ? result.turn.extensionPin
                : undefined,
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
