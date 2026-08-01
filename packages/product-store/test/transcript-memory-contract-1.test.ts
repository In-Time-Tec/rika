import {
  expect,
  it,
  TranscriptOrdering,
  TranscriptProjection,
  TranscriptProjectionModel,
  Effect,
  Thread,
  TranscriptRepository,
  Turn,
  commitAll,
  event,
  executionCheckpoint,
  projectionVersion,
  turn,
} from "./transcript-memory-behavior-support"

it.layer(TranscriptRepository.memoryLayer)("transcript repository delta contract", (test) => {
  test.effect("restricts durable tuple identifiers to SQLite-stable ASCII text", () =>
    Effect.sync(() => {
      expect(() => Thread.ThreadId.make("thread-\ue000")).toThrow()
      expect(() => Thread.ThreadId.make("thread with space")).toThrow()
      expect(() => Turn.TurnId.make("turn-\u{10000}")).toThrow()
      expect(() => Turn.TurnId.make("turn\nline")).toThrow()
    }),
  )

  test.effect("rejects projection scalars outside the shared durable domain", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const cases: ReadonlyArray<{
        readonly name: string
        readonly version?: number
        readonly update: (state: TranscriptProjectionModel.ProjectionState) => TranscriptProjectionModel.ProjectionState
      }> = [
        { name: "projection-version", version: 0, update: (state) => state },
        { name: "revision", update: (state) => ({ ...state, revision: -2 }) },
        { name: "model-phase", update: (state) => ({ ...state, modelPhase: -2 }) },
        {
          name: "completion-sequence",
          update: (state) => ({ ...state, usableCompletionSequence: -1 }),
        },
        { name: "cost", update: (state) => ({ ...state, costUsd: -0.01 }) },
        {
          name: "unsafe-revision",
          update: (state) => ({ ...state, revision: Number.MAX_SAFE_INTEGER + 1 }),
        },
      ]

      for (const [index, candidate] of cases.entries()) {
        const target = turn(600 + index)
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
    }),
  )

  test.effect("upserts and removes only named units while preserving every omitted unit", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(1)
      const initial = TranscriptProjection.Projection.project(target.id, target.prompt, [event(0), event(1)])
      expect(yield* commitAll(repository, target, initial, undefined)).toBe("committed")
      const stored = yield* repository.get(target.id)
      if (stored === undefined) return yield* Effect.die("initial projection was not stored")
      const assistant = stored.units.find(
        (candidate) => candidate.content._tag === "Entry" && candidate.content.role === "assistant",
      )
      if (assistant === undefined || assistant.content._tag !== "Entry")
        return yield* Effect.die("assistant unit was not stored")
      const updated = {
        ...assistant,
        revision: 2,
        content: { ...assistant.content, text: "updated once" },
      }
      expect(
        yield* repository.commitDelta(
          target,
          TranscriptProjection.Projection.projectionState({ ...initial, revision: 2 }),
          { upsert: [updated], remove: [] },
          {
            executionCheckpoints: [executionCheckpoint(target, { ...initial, revision: 2 })],
            projectionVersion,
            expectedGeneration: stored.checkpointGeneration,
          },
        ),
      ).toBe("committed")
      const afterUpdate = yield* repository.get(target.id)
      expect(afterUpdate?.units).toHaveLength(stored.units.length)
      expect(afterUpdate?.units.find((candidate) => candidate.key === updated.key)).toEqual(updated)
      expect(afterUpdate?.units.find((candidate) => candidate.key !== updated.key)).toEqual(
        stored.units.find((candidate) => candidate.key !== updated.key),
      )
      const moved = { ...updated, order: TranscriptOrdering.unitOrder(updated.key, 50) }
      const movedResult = yield* Effect.result(
        repository.commitDelta(
          target,
          TranscriptProjection.Projection.projectionState({ ...initial, revision: 3 }),
          { upsert: [moved], remove: [] },
          {
            executionCheckpoints: [executionCheckpoint(target, { ...initial, revision: 3 })],
            projectionVersion,
            expectedGeneration: afterUpdate?.checkpointGeneration,
          },
        ),
      )
      expect(movedResult._tag).toBe("Failure")
      expect(yield* repository.get(target.id)).toEqual(afterUpdate)
      expect(
        yield* repository.commitDelta(
          target,
          TranscriptProjection.Projection.projectionState({ ...initial, revision: 3 }),
          { upsert: [], remove: [updated.key] },
          {
            executionCheckpoints: [executionCheckpoint(target, { ...initial, revision: 3 })],
            projectionVersion,
            expectedGeneration: afterUpdate?.checkpointGeneration,
          },
        ),
      ).toBe("committed")
      expect((yield* repository.get(target.id))?.units.map((candidate) => candidate.key)).not.toContain(updated.key)
    }),
  )

  test.effect("uses an exact checkpoint compare-and-swap and changes nothing on conflict", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(2)
      const initial = { ...TranscriptProjection.Projection.project(target.id, target.prompt, [event(0)]), revision: 4 }
      yield* commitAll(repository, target, initial, undefined)
      const before = yield* repository.get(target.id)
      const replacement = TranscriptProjection.Projection.project(target.id, target.prompt, [event(0), event(1)])
      const result = yield* repository.commitDelta(
        target,
        TranscriptProjection.Projection.projectionState({ ...replacement, revision: 6 }),
        { upsert: replacement.units, remove: [] },
        {
          executionCheckpoints: [executionCheckpoint(target, { ...replacement, revision: 6 })],
          projectionVersion,
          expectedGeneration: 3,
        },
      )
      expect(result).toBe("stale")
      expect(yield* repository.get(target.id)).toEqual(before)
      expect(
        yield* repository.commitDelta(
          target,
          TranscriptProjection.Projection.projectionState({ ...replacement, revision: 3 }),
          { upsert: replacement.units, remove: [] },
          {
            executionCheckpoints: [executionCheckpoint(target, { ...replacement, revision: 3 })],
            projectionVersion,
            expectedGeneration: 0,
          },
        ),
      ).toBe("stale")
      expect(yield* repository.get(target.id)).toEqual(before)
    }),
  )
})
