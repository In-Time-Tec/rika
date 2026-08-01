import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration019 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_turns ADD COLUMN stop_intent TEXT NOT NULL DEFAULT 'none'
    CHECK (stop_intent IN ('none', 'requested'))`
})

