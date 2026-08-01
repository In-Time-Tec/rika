import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration005 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_turns ADD COLUMN prompt_parts_json TEXT`
})
