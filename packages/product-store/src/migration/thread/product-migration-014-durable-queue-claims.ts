import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration014 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_turns ADD COLUMN queue_claim_token TEXT`
  yield* sql`CREATE UNIQUE INDEX rika_turns_queue_claim ON rika_turns (thread_id) WHERE queue_claim_token IS NOT NULL`
})

