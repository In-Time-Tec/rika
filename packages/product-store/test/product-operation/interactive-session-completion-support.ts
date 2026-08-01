import { Effect } from "effect"
import * as TurnContract from "@rika/product/turn-repository"
import { Fixtures as RuntimeFixtures } from "./interactive-session-runtime-support"
import { Fixtures as TranscriptFixtures } from "./interactive-session-transcript-support"
import { projectionVersion } from "./interactive-session-base-support"
import { storeProjection } from "../support/product-test-transcript-fixture"

export const storeCompletedTranscript = Effect.fn("InteractiveSessionTest.storeCompletedTranscript")(function* (
  transcripts: RuntimeFixtures.TranscriptRepository.Interface,
  turn: RuntimeFixtures.Turn.AgentExecutionTurn,
  cursor: string,
) {
  const projection = TranscriptFixtures.TranscriptProjection.Projection.project(String(turn.id), turn.prompt, [
    {
      cursor,
      sequence: 0,
      type: "execution.completed",
      createdAt: turn.updatedAt,
    },
  ])
  yield* storeProjection(transcripts, turn, projection, {
    consumed: { [String(turn.id)]: { cursor, sequence: 0, status: "completed" } },
    projectionVersion: projectionVersion,
  })
})

export const completeActive = Effect.fn("InteractiveSessionTest.completeActive")(function* (
  turns: TurnContract.Interface,
  transcripts: RuntimeFixtures.TranscriptRepository.Interface,
  updatedAt: number,
) {
  const turn = yield* turns.setStatus(RuntimeFixtures.Turn.TurnId.make("active"), "completed", "done", updatedAt)
  yield* storeCompletedTranscript(transcripts, turn, "done")
  return turn
})
