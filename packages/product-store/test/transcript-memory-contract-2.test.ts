import {
  expect,
  it,
  TranscriptCorrelation,
  TranscriptProjection,
  Effect,
  TranscriptRepository,
  compareExecutionCheckpoints,
  commitAll,
  event,
  executionCheckpoint,
  invalidCheckpointGraphs,
  nestedProjection,
  projectionVersion,
  turn,
} from "./transcript-memory-behavior-support"

it.layer(TranscriptRepository.memoryLayer)("transcript repository delta contract", (test) => {
  test.effect("atomically couples an attached child to its parent unit", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(150)
      const nested = nestedProjection(target, "child:turn-150:parent")

      expect(
        yield* commitAll(repository, target, nested.projection, undefined, projectionVersion, nested.checkpoints),
      ).toBe("committed")
      const before = yield* repository.get(target.id)
      expect(before?.executionCheckpoints).toHaveLength(2)

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
      expect(yield* repository.get(target.id)).toEqual(before)
    }),
  )

  test.effect("requires a complete root-connected checkpoint graph for refold", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(151)
      const obsolete = TranscriptProjection.Projection.empty(target.id, target.prompt)
      expect(yield* commitAll(repository, target, obsolete, undefined, 2)).toBe("committed")
      const before = yield* repository.get(target.id)
      if (before === undefined) return yield* Effect.die("obsolete projection was not stored")
      const nested = nestedProjection(target, "child:turn-151:parent")

      for (const candidate of invalidCheckpointGraphs(target, nested, "child:turn-151:peer")) {
        const result = yield* Effect.result(
          repository.replaceForRefold(target, nested.projection, {
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

      expect(
        yield* repository.replaceForRefold(target, nested.projection, {
          executionCheckpoints: nested.checkpoints,
          projectionVersion,
          expectedProjectionVersion: 2,
          expectedGeneration: before.checkpointGeneration,
        }),
      ).toMatchObject({ _tag: "Committed" })
      const stored = yield* repository.get(target.id)
      expect(stored?.units).toEqual(nested.projection.units)
      expect(stored?.executionCheckpoints).toEqual(nested.checkpoints.toSorted(compareExecutionCheckpoints))
      expect(stored?.projectionVersion).toBe(projectionVersion)
    }),
  )

  test.effect("rejects checkpoint cursors that contradict exact fold state", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(200)
      const projection = TranscriptProjection.Projection.project(target.id, target.prompt, [event(0)])
      yield* commitAll(repository, target, projection, undefined)
      const before = yield* repository.get(target.id)
      const key = TranscriptCorrelation.executionKey(String(target.id))
      const result = yield* Effect.result(
        repository.commitDelta(
          target,
          TranscriptProjection.Projection.projectionState(projection),
          { upsert: [], remove: [] },
          {
            executionCheckpoints: [
              { ...executionCheckpoint(target, projection), executionKey: key, cursor: "contradictory" },
            ],
            projectionVersion,
            expectedGeneration: before?.checkpointGeneration,
          },
        ),
      )
      expect(result._tag).toBe("Failure")
      expect(yield* repository.get(target.id)).toEqual(before)
    }),
  )

  test.effect("advances checkpoint authority without inventing a source-event revision", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      const target = turn(300)
      const projection = TranscriptProjection.Projection.project(target.id, target.prompt, [event(0)])
      yield* commitAll(repository, target, projection, undefined)
      const initial = yield* repository.get(target.id)
      if (initial === undefined) return yield* Effect.die("initial projection was not stored")
      const assistant = initial.units.find(
        (candidate) => candidate.content._tag === "Entry" && candidate.content.role === "assistant",
      )
      if (assistant === undefined || assistant.content._tag !== "Entry")
        return yield* Effect.die("assistant unit was not stored")
      const updated = { ...assistant, content: { ...assistant.content, text: "same-event update" } }
      expect(
        yield* repository.commitDelta(
          target,
          TranscriptProjection.Projection.projectionState(projection),
          { upsert: [updated], remove: [] },
          {
            executionCheckpoints: [executionCheckpoint(target, projection)],
            projectionVersion,
            expectedGeneration: initial.checkpointGeneration,
          },
        ),
      ).toBe("committed")
      const committed = yield* repository.get(target.id)
      expect(committed?.revision).toBe(projection.revision)
      expect(committed?.checkpointGeneration).toBe(initial.checkpointGeneration + 1)
      expect(
        yield* repository.commitDelta(
          target,
          TranscriptProjection.Projection.projectionState(projection),
          { upsert: [], remove: [updated.key] },
          {
            executionCheckpoints: [executionCheckpoint(target, projection)],
            projectionVersion,
            expectedGeneration: initial.checkpointGeneration,
          },
        ),
      ).toBe("stale")
      expect(yield* repository.get(target.id)).toEqual(committed)
    }),
  )
})
