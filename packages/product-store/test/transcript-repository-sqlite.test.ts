import * as BunServices from "@effect/platform-bun/BunServices"
import * as Transcript from "@rika/transcript/transcript-unit"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "../src/thread-repository"
import * as TranscriptRepository from "../src/transcript-repository"
import * as TurnRepository from "../src/turn-repository"
import * as Turn from "@rika/product/turn-record"
import {
  attachedExecutionCheckpoint,
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

const UnitJson = Schema.fromJsonString(Transcript.Unit)

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
              Transcript.projectionState(nested.projection),
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

const usageEvent: Transcript.SourceEvent = {
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
            readonly update: (state: Transcript.ProjectionState) => Transcript.ProjectionState
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
            const projection = Transcript.empty(target.id, target.prompt)
            const state = candidate.update(Transcript.projectionState(projection))
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
            ...Transcript.project(target.id, target.prompt, [event(0)]),
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
              Transcript.projectionState(initial),
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
              Transcript.projectionState(initial),
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
              Transcript.projectionState({ ...initial, revision: 3 }),
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
              Transcript.projectionState({ ...initial, revision: 2 }),
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
          const moved = { ...updated, order: Transcript.unitOrder(updated.key, 50) }
          const movedResult = yield* Effect.result(
            repository.commitDelta(
              target,
              Transcript.projectionState({ ...initial, revision: 2 }),
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
          } as unknown as Transcript.Unit
          const malformedResult = yield* Effect.result(
            repository.commitDelta(
              target,
              Transcript.projectionState({ ...initial, revision: 2 }),
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
              executionKey: Transcript.executionKey(String(turnId)),
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
              Transcript.projectionState(nested.projection),
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
          const obsolete = Transcript.empty(target.id, target.prompt)
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
      const replacement = Transcript.project(turnId, "refold", [event(2)])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(threadId, turnId, "refold")
          const obsolete = { ...Transcript.project(turnId, target.prompt, [event(0), event(1)]), revision: 70 }
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
            const obsolete = Transcript.project(turnId, target.prompt, [event(0), event(1)])
            yield* commitAll(repository, target, obsolete, undefined, 2)
            const before = yield* repository.get(turnId)
            if (before === undefined) return yield* Effect.die("obsolete projection was not stored")
            const replacement = Transcript.project(turnId, target.prompt, [
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

it.effect("rejects a refold when the SQLite Turn tuple advanced concurrently", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-refold-stale-turn-" })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const turns = yield* TurnRepository.Service
          const target = yield* createTurn(
            Thread.ThreadId.make("thread-refold-stale-turn"),
            Turn.TurnId.make("turn-refold-stale-turn"),
            "refold stale turn",
          )
          const obsolete = Transcript.project(target.id, target.prompt, [event(0), event(1)])
          yield* commitAll(repository, target, obsolete, undefined, 2)
          const before = yield* repository.get(target.id)
          if (before === undefined) return yield* Effect.die("obsolete projection was not stored")
          expect(yield* turns.repairCursor(target.id, "completed", undefined, "newer-cursor")).toBe(true)
          const newer = yield* turns.get(target.id)
          const preserved = yield* repository.get(target.id)
          const replacement = Transcript.project(target.id, target.prompt, [
            { cursor: "refold-failed", sequence: 0, type: "execution.failed", createdAt: 10, text: "failed" },
          ])

          expect(
            yield* repository.replaceForRefold(target, replacement, {
              executionCheckpoints: [executionCheckpoint(target, replacement, "failed")],
              projectionVersion,
              expectedProjectionVersion: 2,
              expectedGeneration: before.checkpointGeneration,
            }),
          ).toEqual({ _tag: "Stale" })
          expect(yield* turns.get(target.id)).toEqual(newer)
          expect(yield* repository.get(target.id)).toEqual(preserved)
        }).pipe(provideLayer(sqliteLayer(`${directory}/rika.db`))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("rejects contradictory durable checkpoint and projected terminal outcomes during refold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-refold-contradiction-" })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const turns = yield* TurnRepository.Service
          const target = yield* createTurn(
            Thread.ThreadId.make("thread-refold-contradiction"),
            Turn.TurnId.make("turn-refold-contradiction"),
            "refold contradiction",
          )
          const obsolete = Transcript.project(target.id, target.prompt, [event(0), event(1)])
          yield* commitAll(repository, target, obsolete, undefined, 2)
          const before = yield* repository.get(target.id)
          if (before === undefined) return yield* Effect.die("obsolete projection was not stored")
          const replacement = Transcript.project(target.id, target.prompt, [
            { cursor: "cancelled", sequence: 0, type: "execution.cancelled", createdAt: 10 },
          ])
          const rejected = yield* Effect.result(
            repository.replaceForRefold(target, replacement, {
              executionCheckpoints: [executionCheckpoint(target, replacement, "failed")],
              projectionVersion,
              expectedProjectionVersion: 2,
              expectedGeneration: before.checkpointGeneration,
            }),
          )
          expect(rejected._tag).toBe("Failure")
          if (rejected._tag === "Failure")
            expect(rejected.failure.message).toContain("contradictory terminal root outcomes")
          expect(yield* turns.get(target.id)).toEqual(target)
          expect(yield* repository.get(target.id)).toEqual(before)
        }).pipe(provideLayer(sqliteLayer(`${directory}/rika.db`))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("persists a terminal outcome appended after the initial projection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-outcome-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-outcome")
      const turnId = Turn.TurnId.make("turn-outcome")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(threadId, turnId, "outcome")
          const initial = Transcript.project(turnId, target.prompt, [event(0)])
          yield* commitAll(repository, target, initial, undefined)
          const stored = yield* repository.get(turnId)
          if (stored === undefined) return yield* Effect.die("initial projection was not stored")
          const completed = Transcript.applyEvent(initial, event(2))
          const previous = new Map(initial.units.map((candidate) => [candidate.key, candidate]))
          const changed = completed.units.filter(
            (candidate) => JSON.stringify(candidate) !== JSON.stringify(previous.get(candidate.key)),
          )
          expect(
            yield* repository.commitDelta(
              target,
              Transcript.projectionState(completed),
              { upsert: changed, remove: [] },
              {
                executionCheckpoints: [executionCheckpoint(target, completed, "completed")],
                projectionVersion,
                expectedGeneration: stored.checkpointGeneration,
              },
            ),
          ).toBe("committed")
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const reopened = yield* repository.get(turnId)
          if (reopened === undefined) return yield* Effect.die("terminal projection was not reopened")
          if (!Turn.isAgentExecution(reopened.turn))
            return yield* Effect.die("terminal projection did not reopen an agent execution")
          expect(reopened?.units.find((candidate) => candidate.key === `turn:${turnId}:user`)).toMatchObject({
            revision: 2,
            executionOutcome: { status: "complete" },
          })
          expect(reopened.executionCheckpoints).toContainEqual(
            executionCheckpoint(reopened.turn, reopened, "completed"),
          )
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("restores usage dedup state before a redelivered usage event", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-usage-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-usage")
      const turnId = Turn.TurnId.make("turn-usage")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(threadId, turnId, "usage")
          yield* commitAll(repository, target, Transcript.project(turnId, target.prompt, [usageEvent]), undefined)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const reopened = yield* repository.get(turnId)
          if (reopened === undefined) return yield* Effect.die("usage projection was not stored")
          const resumed: Transcript.Projection = { units: reopened.units, ...Transcript.projectionState(reopened) }
          const redelivered = Transcript.applyEvent(resumed, usageEvent)
          expect(Transcript.projectionState(redelivered)).toEqual(Transcript.projectionState(resumed))
          expect(redelivered.usageCursors).toEqual([usageEvent.cursor])
          expect(redelivered.costUsd).toBe(resumed.costUsd)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("filters every SQLite keyset page by exact projection version", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-version-filter-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-version-filter")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const stale = yield* createTurn(threadId, Turn.TurnId.make("turn-filter-stale"), "stale")
          const currentOlder = yield* createTurn(threadId, Turn.TurnId.make("turn-filter-current-a"), "current older")
          const currentNewer = yield* createTurn(threadId, Turn.TurnId.make("turn-filter-current-b"), "current newer")
          for (const [target, version] of [
            [stale, 2],
            [currentOlder, projectionVersion],
            [currentNewer, projectionVersion],
          ] as const)
            yield* commitAll(repository, target, Transcript.empty(target.id, target.prompt), undefined, version)

          const newest = yield* repository.page(threadId, { limit: 1, projectionVersion })
          expect(newest.entries.map((entry) => entry.turn.id)).toEqual([currentNewer.id])
          expect(newest.hasOlder).toBe(true)
          if (newest.oldestCursor === undefined) return yield* Effect.die("filtered page had no oldest cursor")

          const older = yield* repository.page(threadId, {
            before: newest.oldestCursor,
            limit: 1,
            projectionVersion,
          })
          expect(older.entries.map((entry) => entry.turn.id)).toEqual([currentOlder.id])
          expect(older.hasOlder).toBe(false)
          if (older.newestCursor === undefined) return yield* Effect.die("filtered page had no newest cursor")

          const newer = yield* repository.page(threadId, {
            after: older.newestCursor,
            limit: 1,
            projectionVersion,
          })
          expect(newer.entries.map((entry) => entry.turn.id)).toEqual([currentNewer.id])
          expect(newer.hasNewer).toBe(false)
          expect(
            (yield* repository.page(threadId, { limit: 10, projectionVersion: 2 })).entries.map(
              (entry) => entry.turn.id,
            ),
          ).toEqual([stale.id])
          expect((yield* repository.page(threadId, { limit: 10, projectionVersion: 4 })).entries).toEqual([])
          expect(
            new Set((yield* repository.page(threadId, { limit: 10 })).entries.map((entry) => entry.turn.id)),
          ).toEqual(new Set([stale.id, currentOlder.id, currentNewer.id]))
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("keyset-paginates a reopened nested intrinsic-order transcript without duplicates", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-page-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-page")
      const turnId = Turn.TurnId.make("turn-page")
      const parentProjection = Transcript.project(turnId, "page", [
        {
          cursor: "parent",
          sequence: 0,
          type: "tool.call.requested",
          createdAt: 0,
          data: { tool_call_id: "parent", tool_name: "task", input: {} },
        },
      ])
      const parent = parentProjection.units.find(
        (candidate) => candidate.content._tag === "Block" && candidate.content.block._tag === "ToolCall",
      )
      if (parent?.content._tag !== "Block" || parent.content.block._tag !== "ToolCall")
        return yield* Effect.die("page transcript had no parent tool")
      const parentId = parent.content.block.id
      const generated = Array.from({ length: 125 }, (_, index) => {
        const local = unit(turnId, index, 0, `page-unit-${String(index).padStart(3, "0")}`)
        if (index % 2 === 0) return local
        const executionId = `child-${String(index).padStart(3, "0")}`
        return {
          ...local,
          turnId: executionId,
          parentId,
          order: Transcript.childOrder(parent.order, executionId, local.order),
        }
      })
      const units = [parent, ...generated]

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(threadId, turnId, "page")
          const projection = { ...Transcript.empty(turnId, target.prompt), units, revision: 124, costUsd: 4.5 }
          const checkpoints = [
            executionCheckpoint(target, projection),
            ...generated.flatMap((candidate) =>
              candidate.turnId === turnId
                ? []
                : [
                    attachedExecutionCheckpoint(
                      candidate.turnId,
                      { revision: candidate.revision, modelPhase: -1 },
                      Transcript.executionKey(String(turnId)),
                      parent,
                    ),
                  ],
            ),
          ]
          yield* commitAll(repository, target, projection, undefined, projectionVersion, checkpoints)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const keys: Array<string> = []
          let before: TranscriptRepository.PageCursor | undefined
          while (true) {
            const page = yield* repository.page(threadId, {
              ...(before === undefined ? {} : { before }),
              limit: 17,
            })
            keys.push(...page.entries.map((entry) => entry.unit.key))
            expect(page.threadCostUsd).toBe(4.5)
            if (!page.hasOlder || page.oldestCursor === undefined) break
            before = page.oldestCursor
          }
          expect(keys).toHaveLength(units.length)
          expect(new Set(keys).size).toBe(units.length)
          expect(new Set(keys)).toEqual(new Set(units.map((candidate) => candidate.key)))
          const newest = yield* repository.page(threadId, { limit: 3 })
          if (newest.oldestCursor === undefined) return yield* Effect.die("newest page had no cursor")
          const older = yield* repository.page(threadId, { before: newest.oldestCursor, limit: 3 })
          if (older.newestCursor === undefined) return yield* Effect.die("older page had no cursor")
          const newer = yield* repository.page(threadId, { after: older.newestCursor, limit: 3 })
          expect(new Set([...older.entries, ...newer.entries].map((entry) => entry.unit.key)).size).toBe(
            older.entries.length + newer.entries.length,
          )
          const olderAgain = yield* repository.page(threadId, { before: newest.oldestCursor, limit: 3 })
          expect(olderAgain.entries.map((entry) => entry.unit.key)).toEqual(
            older.entries.map((entry) => entry.unit.key),
          )
          expect(
            (yield* Effect.result(
              repository.page(threadId, { before: newest.oldestCursor, after: older.newestCursor, limit: 3 }),
            ))._tag,
          ).toBe("Failure")
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("orders Unicode and nested order segments exactly like SQLite BINARY", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-collation-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-collation")
      const turnId = Turn.TurnId.make("turn-collation")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const sql = yield* SqlClient
          const target = yield* createTurn(threadId, turnId, "collation")
          const flat = ["a", "aa", "\ud7ff", "\u{10000}", "\ue000"].map((key) => unit(turnId, 1, 0, key))
          const parentProjection = Transcript.project(turnId, target.prompt, [
            {
              cursor: "parent",
              sequence: 0,
              type: "tool.call.requested",
              createdAt: 0,
              data: { tool_call_id: "parent", tool_name: "task", input: {} },
            },
          ])
          const parent = parentProjection.units.find(
            (candidate) => candidate.content._tag === "Block" && candidate.content.block._tag === "ToolCall",
          )
          if (parent?.content._tag !== "Block" || parent.content.block._tag !== "ToolCall")
            return yield* Effect.die("collation transcript had no parent tool")
          const parentId = parent.content.block.id
          const nested = ["child-\ud7ff", "child-\u{10000}", "child-\ue000"].map((executionId, index) => {
            const local = unit(turnId, 1, 0, `nested-${index}`)
            return Object.assign({}, local, {
              turnId: executionId,
              parentId,
              order: Transcript.childOrder(parent.order, executionId, local.order),
            })
          })
          const units = [parent, ...flat, ...nested]
          const projection = { ...Transcript.empty(turnId, target.prompt), units, revision: 1 }
          yield* commitAll(repository, target, projection, undefined, projectionVersion, [
            executionCheckpoint(target, projection),
            ...nested.map((candidate) =>
              attachedExecutionCheckpoint(
                candidate.turnId,
                { revision: candidate.revision, modelPhase: -1 },
                Transcript.executionKey(String(turnId)),
                parent,
              ),
            ),
          ])
          const expected = units
            .toSorted((left, right) => Transcript.compareUnitOrder(left.order, right.order))
            .map((candidate) => candidate.key)
          const durable = yield* sql`SELECT unit_key FROM rika_transcript_units
            WHERE turn_id = ${turnId} ORDER BY unit_order_key COLLATE BINARY`
          expect(durable.map((row) => row.unit_key)).toEqual(expected)
          expect((yield* repository.get(turnId))?.units.map((candidate) => candidate.key)).toEqual(expected)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("returns typed errors for malformed durable transcript state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-order-corrupt-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-corrupt")
      const turnId = Turn.TurnId.make("turn-corrupt")
      const projection = Transcript.project(turnId, "corrupt", [
        event(0),
        {
          cursor: "cursor-tool",
          sequence: 1,
          type: "tool.call.requested",
          createdAt: 1,
          data: { tool_call_id: "tool", tool_name: "read", input: { path: "a.ts" } },
        },
      ])
      const firstUnit = projection.units[0]!
      const toolUnit = projection.units.find(
        (candidate) => candidate.content._tag === "Block" && candidate.content.block._tag === "ToolCall",
      )!
      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const sql = yield* SqlClient
          const target = yield* createTurn(threadId, turnId, "corrupt")
          yield* commitAll(repository, target, projection, undefined)
          yield* sql`UPDATE rika_transcript_units SET unit_order_key = unit_order_key || '0'
            WHERE turn_id = ${turnId} AND unit_key = ${firstUnit.key}`
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const sql = yield* SqlClient
          const failure = yield* Effect.flip(repository.get(turnId))
          expect(failure).toBeInstanceOf(TranscriptRepository.RepositoryError)
          expect(failure._tag).toBe("TranscriptRepositoryError")
          const pageFailure = yield* Effect.flip(repository.page(threadId, { limit: 200 }))
          expect(pageFailure).toBeInstanceOf(TranscriptRepository.RepositoryError)
          yield* sql`UPDATE rika_transcript_units
            SET unit_order_key = ${Transcript.encodeUnitOrder(firstUnit.order)}, unit_key = 'wrong-key'
            WHERE turn_id = ${turnId} AND unit_key = ${firstUnit.key}`
          expect(yield* Effect.flip(repository.get(turnId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          expect(yield* Effect.flip(repository.page(threadId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          yield* sql`UPDATE rika_transcript_units
            SET unit_key = ${firstUnit.key}, unit_order_key = ${Transcript.encodeUnitOrder(firstUnit.order)}, unit_json = ${"{"}
            WHERE turn_id = ${turnId} AND unit_key = 'wrong-key'`
          const unitJsonFailure = yield* Effect.flip(repository.get(turnId))
          expect(unitJsonFailure).toBeInstanceOf(TranscriptRepository.RepositoryError)
          const firstUnitJson = yield* Schema.encodeEffect(UnitJson)(firstUnit)
          const forgedParentJson = yield* Schema.encodeEffect(UnitJson)({ ...firstUnit, parentId: "forged-parent" })
          yield* sql`UPDATE rika_transcript_units SET unit_json = ${firstUnitJson}
            WHERE turn_id = ${turnId} AND unit_key = ${firstUnit.key}`
          yield* sql`UPDATE rika_transcript_units SET unit_json = ${forgedParentJson}
            WHERE turn_id = ${turnId} AND unit_key = ${firstUnit.key}`
          expect(yield* Effect.flip(repository.get(turnId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          expect(yield* Effect.flip(repository.page(threadId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          yield* sql`UPDATE rika_transcript_units SET unit_json = ${firstUnitJson}
            WHERE turn_id = ${turnId} AND unit_key = ${firstUnit.key}`
          yield* sql`UPDATE rika_transcript_units SET parent_id = 'forged-parent'
            WHERE turn_id = ${turnId} AND unit_key = ${firstUnit.key}`
          expect(yield* Effect.flip(repository.get(turnId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          expect(yield* Effect.flip(repository.page(threadId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          yield* sql`UPDATE rika_transcript_units SET parent_id = NULL
            WHERE turn_id = ${turnId} AND unit_key = ${firstUnit.key}`
          if (toolUnit.content._tag !== "Block" || toolUnit.content.block._tag !== "ToolCall")
            return yield* Effect.die("corrupt transcript had no tool")
          const forgedToolJson = yield* Schema.encodeEffect(UnitJson)({
            ...toolUnit,
            content: {
              _tag: "Block",
              block: { ...toolUnit.content.block, id: "forged-tool" },
            },
          })
          const toolUnitJson = yield* Schema.encodeEffect(UnitJson)(toolUnit)
          yield* sql`UPDATE rika_transcript_units SET unit_json = ${forgedToolJson}
            WHERE turn_id = ${turnId} AND unit_key = ${toolUnit.key}`
          expect(yield* Effect.flip(repository.get(turnId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          expect(yield* Effect.flip(repository.page(threadId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          yield* sql`UPDATE rika_transcript_units SET unit_json = ${toolUnitJson}, tool_id = 'forged-tool'
            WHERE turn_id = ${turnId} AND unit_key = ${toolUnit.key}`
          expect(yield* Effect.flip(repository.get(turnId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          expect(yield* Effect.flip(repository.page(threadId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          yield* sql`UPDATE rika_transcript_units SET tool_id = ${toolUnit.content.block.id}
            WHERE turn_id = ${turnId} AND unit_key = ${toolUnit.key}`
          const rootKey = Transcript.executionKey(String(turnId))
          yield* sql`UPDATE rika_transcript_execution_checkpoints
            SET usage_cursors_json = ${"{"}
            WHERE turn_id = ${turnId} AND execution_key = ${rootKey}`
          expect(yield* Effect.flip(repository.get(turnId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          yield* sql`UPDATE rika_transcript_execution_checkpoints SET usage_cursors_json = NULL
            WHERE turn_id = ${turnId} AND execution_key = ${rootKey}`
          yield* sql`UPDATE rika_transcript_checkpoints
            SET model_phase = model_phase + 1
            WHERE turn_id = ${turnId}`
          expect(yield* Effect.flip(repository.get(turnId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
