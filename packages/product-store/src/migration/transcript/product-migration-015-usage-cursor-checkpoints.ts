import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration015 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_transcript_checkpoints ADD COLUMN usage_cursors_json TEXT`
})
