import * as BunServices from "@effect/platform-bun/BunServices"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "../src/thread/sqlite-thread-repository"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import {
  commitAll,
  event,
  executionCheckpoint,
  invalidCheckpointGraphs,
  type NestedProjectionFixture,
  nestedProjection,
  projectionVersion,
  provideLayer,
  sqliteLayer,
  unit,
} from "./transcript-repository-fixtures"

const _UnitJson = Schema.fromJsonString(TranscriptUnit.Unit)

const compareExecutionCheckpoints = (
  left: TranscriptRepository.ExecutionCheckpoint,
  right: TranscriptRepository.ExecutionCheckpoint,
): number => {
  if (left.executionKey < right.executionKey) return -1
  if (left.executionKey > right.executionKey) return 1
  return 0
}

const createTurn = Effect.fn("TranscriptRepositoryTest.createTurn")(function* (
  threadId: Thread.ThreadId,
  turnId: Turn.TurnId,
  prompt: string,
) {
  const threads = yield* ThreadRepository.Service
  const turns = yield* TurnRepository.Service
  if ((yield* threads.get(threadId)) === undefined)
    yield* threads.create({ id: threadId, workspace: `/work/${threadId}`, title: String(threadId), now: 1 })
  yield* turns.createForSubmission({
    id: turnId,
    threadId,
    prompt,
    executionRoute: Turn.testExecutionRoute(),
    queueCapacity: 128,
    now: 2,
  })
  return yield* turns.setStatus(turnId, "completed", undefined, 3)
})

it.effect("lists terminal roots whose current SQLite projection has an unfinished child", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-recovery-" })
      const filename = `${directory}/rika.db`
      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(
            Thread.ThreadId.make("thread-recovery"),
            Turn.TurnId.make("turn-recovery"),
            "recover child",
          )
          const nested = nestedProjection(target, "child:turn-recovery:parent")

          expect(yield* repository.listProjectionRecoveryCandidates(projectionVersion)).toEqual([
            { threadId: target.threadId, turnId: target.id },
          ])
          expect(
            yield* commitAll(repository, target, nested.projection, undefined, projectionVersion, nested.checkpoints),
          ).toBe("committed")
          expect(yield* repository.listProjectionRecoveryCandidates(projectionVersion)).toEqual([
            { threadId: target.threadId, turnId: target.id },
          ])

          const stored = yield* repository.get(target.id)
          if (stored === undefined) return yield* Effect.die("nested projection was not stored")
          const terminal = nested.checkpoints.map((checkpoint) =>
            checkpoint.attachment === undefined ? checkpoint : { ...checkpoint, status: "completed" as const },
          )
          expect(
            yield* repository.commitDelta(
              target,
              TranscriptProjection.Projection.projectionState(nested.projection),
              { upsert: [], remove: [] },
              {
                executionCheckpoints: terminal,
                projectionVersion,
                expectedGeneration: stored.checkpointGeneration,
              },
            ),
          ).toBe("committed")
          expect(yield* repository.listProjectionRecoveryCandidates(projectionVersion)).toEqual([])
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

const _usageEvent: TranscriptSourceEvent.SourceEvent = {
  cursor: "usage-5",
  sequence: 5,
  type: "model.usage.reported",
  createdAt: 5,
  data: {
    provider: "openai",
    model: "gpt-5.6-sol",
    input_tokens: 250_000,
    input_tokens_uncached: 250_000,
    input_tokens_cache_read: 0,
    input_tokens_cache_write: 0,
    output_tokens: 0,
  },
}

it.effect("rejects the same out-of-domain projection scalars before SQLite writes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-scalars-" })
      const filename = `${directory}/rika.db`
      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const cases: ReadonlyArray<{
            readonly name: string
            readonly version?: number
            readonly update: (
              state: TranscriptProjectionModel.ProjectionState,
            ) => TranscriptProjectionModel.ProjectionState
          }> = [
            { name: "projection-version", version: 0, update: (state) => state },
            { name: "revision", update: (state) => ({ ...state, revision: -2 }) },
            { name: "model-phase", update: (state) => ({ ...state, modelPhase: -2 }) },
            {
              name: "completion-sequence",
              update: (state) => ({ ...state, usableCompletionSequence: -1 }),
            },
            { name: "cost", update: (state) => ({ ...state, costUsd: -0.01 }) },
          ]
          for (const [index, candidate] of cases.entries()) {
            const threadId = Thread.ThreadId.make(`thread-scalar-${index}`)
            const turnId = Turn.TurnId.make(`turn-scalar-${index}`)
            const target = yield* createTurn(threadId, turnId, candidate.name)
            const projection = TranscriptProjection.Projection.empty(target.id, target.prompt)
            const state = candidate.update(TranscriptProjection.Projection.projectionState(projection))
            const result = yield* Effect.result(
              repository.commitDelta(
                target,
                state,
                { upsert: projection.units, remove: [] },
                {
                  executionCheckpoints: [executionCheckpoint(target, state)],
                  projectionVersion: candidate.version ?? projectionVersion,
                  expectedGeneration: undefined,
                },
              ),
            )
            expect(result._tag, candidate.name).toBe("Failure")
            expect(yield* repository.get(target.id)).toBeUndefined()
          }
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("persists atomic delta commits without rewriting untouched SQLite rows", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-delta-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-delta")
      const turnId = Turn.TurnId.make("turn-delta")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const sql = yield* SqlClient
          const target = yield* createTurn(threadId, turnId, "persist deltas")
          const initial = {
            ...TranscriptProjection.Projection.project(target.id, target.prompt, [event(0)]),
            costUsd: 1.25,
            usageCursors: ["usage-1"],
            usableCompletionSequence: 0,
          }
          expect(yield* commitAll(repository, target, initial, undefined)).toBe("committed")
          const promptKey = `turn:${turnId}:user`
          const promptBefore = yield* sql`SELECT rowid, unit_json, updated_at FROM rika_transcript_units
            WHERE turn_id = ${turnId} AND unit_key = ${promptKey}`
          const stored = yield* repository.get(turnId)
          const assistant = stored?.units.find(
            (candidate) => candidate.content._tag === "Entry" && candidate.content.role === "assistant",
          )
          if (stored === undefined || assistant === undefined || assistant.content._tag !== "Entry")
            return yield* Effect.die("initial transcript was not stored")
          const updated = {
            ...assistant,
            content: { ...assistant.content, text: "updated" },
          }
          expect(
            yield* repository.commitDelta(
              target,
              TranscriptProjection.Projection.projectionState(initial),
              { upsert: [updated], remove: [] },
              {
                executionCheckpoints: [executionCheckpoint(target, initial)],
                projectionVersion,
                expectedGeneration: 0,
              },
            ),
          ).toBe("committed")
          expect(
            yield* sql`SELECT rowid, unit_json, updated_at FROM rika_transcript_units
              WHERE turn_id = ${turnId} AND unit_key = ${promptKey}`,
          ).toEqual(promptBefore)
          expect(yield* sql`SELECT COUNT(*) AS count FROM rika_transcript_units WHERE turn_id = ${turnId}`).toEqual([
            { count: initial.units.length },
          ])
          expect(
            yield* repository.commitDelta(
              target,
              TranscriptProjection.Projection.projectionState(initial),
              { upsert: [], remove: [] },
              {
                executionCheckpoints: [executionCheckpoint(target, initial)],
                projectionVersion,
                expectedGeneration: 1,
              },
            ),
          ).toBe("committed")
          const beforeConflict = yield* repository.get(turnId)
          expect(beforeConflict).toMatchObject({ revision: 0, checkpointGeneration: 2 })
          expect(
            yield* repository.commitDelta(
              target,
              TranscriptProjection.Projection.projectionState({ ...initial, revision: 3 }),
              { upsert: [], remove: [promptKey] },
              {
                executionCheckpoints: [executionCheckpoint(target, { ...initial, revision: 3 })],
                projectionVersion,
                expectedGeneration: 0,
              },
            ),
          ).toBe("stale")
          expect(yield* repository.get(turnId)).toEqual(beforeConflict)
          const duplicate = unit(turnId, 3, 0, "duplicate")
          const rejected = yield* Effect.result(
            repository.commitDelta(
              target,
              TranscriptProjection.Projection.projectionState({ ...initial, revision: 2 }),
              { upsert: [duplicate, duplicate], remove: [] },
              {
                executionCheckpoints: [executionCheckpoint(target, { ...initial, revision: 2 })],
                projectionVersion,
                expectedGeneration: 2,
              },
            ),
          )
          expect(rejected._tag).toBe("Failure")
          expect(yield* repository.get(turnId)).toEqual(beforeConflict)
          const moved = { ...updated, order: TranscriptOrdering.unitOrder(updated.key, 50) }
          const movedResult = yield* Effect.result(
            repository.commitDelta(
              target,
              TranscriptProjection.Projection.projectionState({ ...initial, revision: 2 }),
              { upsert: [moved], remove: [] },
              {
                executionCheckpoints: [executionCheckpoint(target, { ...initial, revision: 2 })],
                projectionVersion,
                expectedGeneration: 2,
              },
            ),
          )
          expect(movedResult._tag).toBe("Failure")
          expect(yield* repository.get(turnId)).toEqual(beforeConflict)
          const malformed = {
            ...unit(turnId, 2, 0, "malformed"),
            content: { _tag: "Entry", role: "invalid", text: "invalid" },
          } as unknown as TranscriptUnit.Unit
          const malformedResult = yield* Effect.result(
            repository.commitDelta(
              target,
              TranscriptProjection.Projection.projectionState({ ...initial, revision: 2 }),
              { upsert: [malformed], remove: [] },
              {
                executionCheckpoints: [executionCheckpoint(target, { ...initial, revision: 2 })],
                projectionVersion,
                expectedGeneration: 2,
              },
            ),
          )
          expect(malformedResult._tag).toBe("Failure")
          expect(yield* repository.get(turnId)).toEqual(beforeConflict)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const reopened = yield* repository.get(turnId)
          if (reopened === undefined) return yield* Effect.die("delta projection was not reopened")
          expect(reopened?.revision).toBe(0)
          expect(reopened.executionCheckpoints).toEqual([
            expect.objectContaining({
              executionKey: TranscriptCorrelation.executionKey(String(turnId)),
              executionId: String(turnId),
              cursor: "cursor-0",
              sequence: 0,
            }),
          ])
          expect(reopened?.costUsd).toBe(1.25)
          expect(reopened?.usageCursors).toEqual(["usage-1"])
          expect(reopened?.usableCompletionSequence).toBe(0)
          expect(reopened?.executionCheckpoints[0]?.state).toMatchObject({
            revision: 0,
            usableCompletionSequence: 0,
            costUsd: 1.25,
            usageCursors: ["usage-1"],
          })
          expect(
            reopened?.units.some(
              (candidate) =>
                candidate.content._tag === "Entry" &&
                candidate.content.role === "assistant" &&
                candidate.content.text === "updated",
            ),
          ).toBe(true)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("atomically couples an attached child to its parent SQLite unit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-nested-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-nested")
      const turnId = Turn.TurnId.make("turn-nested")
      let before: TranscriptRepository.Projection | undefined

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(threadId, turnId, "nested")
          const nested = nestedProjection(target, "child:turn-nested:parent")

          expect(
            yield* commitAll(repository, target, nested.projection, undefined, projectionVersion, nested.checkpoints),
          ).toBe("committed")
          before = yield* repository.get(turnId)
          expect(before?.executionCheckpoints).toHaveLength(2)
          expect(before?.units).toEqual(nested.projection.units)

          const removal = yield* Effect.result(
            repository.commitDelta(
              target,
              TranscriptProjection.Projection.projectionState(nested.projection),
              { upsert: [], remove: [nested.parent.key] },
              {
                executionCheckpoints: nested.checkpoints,
                projectionVersion,
                expectedGeneration: before?.checkpointGeneration,
              },
            ),
          )
          expect(removal._tag).toBe("Failure")
          if (removal._tag === "Failure") expect(removal.failure).toBeInstanceOf(TranscriptRepository.RepositoryError)
          expect(yield* repository.get(turnId)).toEqual(before)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          expect(yield* repository.get(turnId)).toEqual(before)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("requires a complete root-connected SQLite checkpoint graph for refold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-refold-graph-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-refold-graph")
      const turnId = Turn.TurnId.make("turn-refold-graph")
      let before: TranscriptRepository.Projection | undefined
      let replacement: NestedProjectionFixture | undefined

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(threadId, turnId, "refold graph")
          const obsolete = TranscriptProjection.Projection.empty(target.id, target.prompt)
          expect(yield* commitAll(repository, target, obsolete, undefined, 2)).toBe("committed")
          before = yield* repository.get(target.id)
          if (before === undefined) return yield* Effect.die("obsolete SQLite projection was not stored")
          replacement = nestedProjection(target, "child:turn-refold-graph:parent")

          for (const candidate of invalidCheckpointGraphs(target, replacement, "child:turn-refold-graph:peer")) {
            const result = yield* Effect.result(
              repository.replaceForRefold(target, replacement.projection, {
                executionCheckpoints: candidate.checkpoints,
                projectionVersion,
                expectedProjectionVersion: 2,
                expectedGeneration: before.checkpointGeneration,
              }),
            )
            expect(result._tag, candidate.name).toBe("Failure")
            if (result._tag === "Failure")
              expect(result.failure, candidate.name).toBeInstanceOf(TranscriptRepository.RepositoryError)
            expect(yield* repository.get(target.id), candidate.name).toEqual(before)
          }
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          if (before === undefined || replacement === undefined)
            return yield* Effect.die("refold graph fixture was not retained")
          if (!Turn.isAgentExecution(before.turn))
            return yield* Effect.die("refold graph fixture did not retain an agent execution")
          const repository = yield* TranscriptRepository.Service
          const sql = yield* SqlClient
          expect(yield* repository.get(turnId)).toEqual(before)
          expect(
            yield* repository.replaceForRefold(before.turn, replacement.projection, {
              executionCheckpoints: replacement.checkpoints,
              projectionVersion,
              expectedProjectionVersion: 2,
              expectedGeneration: before.checkpointGeneration,
            }),
          ).toMatchObject({ _tag: "Committed" })
          expect(yield* sql`PRAGMA foreign_key_check`).toEqual([])
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          if (replacement === undefined) return yield* Effect.die("refold graph fixture was not retained")
          const repository = yield* TranscriptRepository.Service
          const reopened = yield* repository.get(turnId)
          expect(reopened?.units).toEqual(replacement.projection.units)
          expect(reopened?.executionCheckpoints).toEqual(replacement.checkpoints.toSorted(compareExecutionCheckpoints))
          expect(reopened?.projectionVersion).toBe(projectionVersion)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("replaces an invalidated SQLite projection authoritatively and persists it across reopen", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-refold-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-refold")
      const turnId = Turn.TurnId.make("turn-refold")
      const replacement = TranscriptProjection.Projection.project(turnId, "refold", [event(2)])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(threadId, turnId, "refold")
          const obsolete = {
            ...TranscriptProjection.Projection.project(turnId, target.prompt, [event(0), event(1)]),
            revision: 70,
          }
          yield* commitAll(repository, target, obsolete, undefined, 2)
          expect(
            yield* repository.replaceForRefold(target, replacement, {
              executionCheckpoints: [executionCheckpoint(target, replacement, "completed")],
              projectionVersion,
              expectedProjectionVersion: 2,
              expectedGeneration: 0,
            }),
          ).toMatchObject({ _tag: "Committed" })
          expect(
            yield* repository.replaceForRefold(target, replacement, {
              executionCheckpoints: [executionCheckpoint(target, replacement, "completed")],
              projectionVersion,
              expectedProjectionVersion: 2,
              expectedGeneration: 0,
            }),
          ).toEqual({ _tag: "Stale" })
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const reopened = yield* repository.get(turnId)
          expect(reopened?.projectionVersion).toBe(projectionVersion)
          expect(reopened?.units).toEqual(replacement.units)
          expect(reopened?.revision).toBe(replacement.revision)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("authoritatively adopts corrected durable terminal outcomes during refold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-refold-outcome-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-refold-outcome")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const turns = yield* TurnRepository.Service
          for (const [suffix, status, type] of [
            ["failed", "failed", "execution.failed"],
            ["cancelled", "cancelled", "execution.cancelled"],
          ] as const) {
            const turnId = Turn.TurnId.make(`turn-refold-${suffix}`)
            const target = yield* createTurn(threadId, turnId, `refold ${suffix}`)
            const obsolete = TranscriptProjection.Projection.project(turnId, target.prompt, [event(0), event(1)])
            yield* commitAll(repository, target, obsolete, undefined, 2)
            const before = yield* repository.get(turnId)
            if (before === undefined) return yield* Effect.die("obsolete projection was not stored")
            const replacement = TranscriptProjection.Projection.project(turnId, target.prompt, [
              {
                cursor: `${status}-cursor`,
                sequence: 0,
                type,
                createdAt: 10,
                ...(status === "failed" ? { text: "failed" } : {}),
              },
            ])
            const options = {
              executionCheckpoints: [executionCheckpoint(target, replacement, status)],
              projectionVersion,
              expectedProjectionVersion: 2,
              expectedGeneration: before.checkpointGeneration,
            }
            expect(yield* repository.replaceForRefold(target, replacement, options)).toMatchObject({
              _tag: "Committed",
              turn: { status, lastCursor: `${status}-cursor` },
            })
            expect(yield* turns.get(turnId)).toMatchObject({ status, lastCursor: `${status}-cursor` })
            expect(yield* repository.get(turnId)).toMatchObject({
              turn: { status, lastCursor: `${status}-cursor` },
              units: replacement.units,
            })
            expect(
              yield* repository.replaceForRefold(target, replacement, {
                ...options,
                projectionVersion: projectionVersion + 1,
                expectedProjectionVersion: projectionVersion,
                expectedGeneration: before.checkpointGeneration + 1,
              }),
            ).toEqual({ _tag: "Stale" })
          }
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
