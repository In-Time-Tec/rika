import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration022 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_transcript_checkpoints ADD COLUMN child_tree_reconciled INTEGER NOT NULL DEFAULT 0
    CHECK (child_tree_reconciled IN (0, 1))`
  yield* sql`ALTER TABLE rika_transcript_checkpoints ADD COLUMN projection_generation INTEGER NOT NULL DEFAULT 0
    CHECK (projection_generation >= 0)`
})

