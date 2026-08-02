import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration016 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_transcript_checkpoints ADD COLUMN pricing_version TEXT`
})
