import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { TurnId } from "@rika/product/turn-record"
import { invalidatedProjectionVersion, RepositoryError } from "./transcript-repository"

const error = (cause: unknown) => RepositoryError.make({ message: String(cause) })

export const invalidateProjection = Effect.fn("TranscriptRepositoryTest.invalidateProjection")(function* (
  turnId: TurnId,
) {
  const sql = yield* SqlClient
  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql`UPDATE rika_transcript_checkpoints
        SET projection_version = ${invalidatedProjectionVersion}, model_phase = -1,
          usable_completion_sequence = NULL,
          oldest_cursor = NULL, checkpoint_cursor = NULL, cost_usd = NULL, usage_cursors_json = NULL,
          pricing_version = NULL
        WHERE turn_id = ${turnId}
        RETURNING turn_id`
        if (rows.length !== 1)
          return yield* RepositoryError.make({ message: `Transcript projection ${turnId} does not exist` })
        yield* sql`DELETE FROM rika_transcript_execution_checkpoints WHERE turn_id = ${turnId}`
        yield* sql`DELETE FROM rika_transcript_units WHERE turn_id = ${turnId}`
      }),
    )
    .pipe(Effect.mapError(error))
})
