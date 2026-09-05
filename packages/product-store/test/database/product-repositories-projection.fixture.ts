import { expect } from "@effect/vitest"
import { Effect } from "effect"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import type { AgentExecutionTurn } from "@rika/product/turn-record"

export const assertProjectionRebase = (transcripts: TranscriptRepository.Interface, turn: AgentExecutionTurn) =>
  Effect.gen(function* () {
    const recovered = yield* transcripts.get(turn.id)
    if (recovered === undefined) return yield* Effect.die("Expected a repaired projection")
    const rebased: ExecutionProjection.Snapshot = {
      _tag: "ProjectionSnapshot",
      baseRevision: recovered.revision,
      revision: recovered.revision + 1,
      units: recovered.units,
      hasOlder: false,
      state: recovered.state,
    }
    expect(yield* transcripts.commitProjection(turn, rebased)).toBe("committed")
    // A competing watcher with the same old base must not overwrite the winning state,
    // even if its independently generated snapshot carries a larger revision.
    expect(
      yield* transcripts.commitProjection(turn, {
        ...rebased,
        revision: rebased.revision + 100,
        state: { ...rebased.state, status: "running" },
      }),
    ).toBe("stale")
    expect(yield* transcripts.get(turn.id)).toMatchObject({
      revision: rebased.revision,
      state: { status: "completed" },
    })
  })

export const assertProjectionRebaseAcrossStores = (
  transcripts: TranscriptRepository.Interface,
  turn: AgentExecutionTurn,
) =>
  Effect.gen(function* () {
    const initial = yield* transcripts.get(turn.id)
    if (initial === undefined) return yield* Effect.die("Expected an existing projection")
    const memory = yield* TranscriptRepository.makeMemory({ initial: [initial] })
    yield* assertProjectionRebase(memory, turn)
    yield* assertProjectionRebase(transcripts, turn)
  })
