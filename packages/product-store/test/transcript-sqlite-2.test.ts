import {
  expect,
  it,
  BunServices,
  TranscriptCorrelation,
  TranscriptOrdering,
  TranscriptProjection,
  TranscriptProjectionModel,
  TranscriptUnit,
  Effect,
  FileSystem,
  SqlClient,
  Thread,
  TranscriptRepository,
  Turn,
  createTurn,
  commitAll,
  event,
  executionCheckpoint,
  projectionVersion,
  provideLayer,
  sqliteLayer,
  unit,
} from "./transcript-sqlite-support"

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
