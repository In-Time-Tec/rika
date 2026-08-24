import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { RepositoryError } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
import { decodeAgent } from "./row-codec"
import { missing, repositoryError } from "../memory/errors"
export const makeTurnSqlState = (
  sql: SqlClient,
): Pick<Interface, "setStatus" | "startAccepted" | "cancelUnlinked"> => ({
  setStatus: Effect.fn("TurnRepository.setStatus")(function* (id, status, now) {
    if (status === "queued")
      return yield* RepositoryError.make({
        message: `Turn ${id} cannot transition into 'queued' via setStatus`,
      })
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const before = yield* sql`SELECT * FROM rika_turns WHERE id = ${id} AND turn_kind = 'AgentExecution'`
          if (before[0] === undefined) return yield* missing(id)
          const wasQueued = String((before[0] as { status?: unknown }).status) === "queued"
          if (wasQueued)
            return yield* RepositoryError.make({
              message: `Turn ${id} cannot transition into or out of 'queued' via setStatus`,
            })
          const rows = yield* sql`UPDATE rika_turns SET status = ${status}, updated_at = ${now}
            WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status NOT IN ('completed', 'failed', 'cancelled')
            RETURNING *`
          if (rows[0] === undefined) return yield* decodeAgent(before[0])
          const turn = yield* decodeAgent(rows[0])
          return turn
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
  startAccepted: Effect.fn("TurnRepository.startAccepted")(function* (id, now) {
    const rows = yield* sql`UPDATE rika_turns SET status = 'running', updated_at = ${now}
      WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status = 'accepted'
      RETURNING id`.pipe(Effect.mapError(repositoryError))
    return rows[0] !== undefined
  }),
  cancelUnlinked: Effect.fn("TurnRepository.cancelUnlinked")(function* (id, now) {
    const rows = yield* sql`UPDATE rika_turns SET status = 'cancelled', updated_at = ${now}
      WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status IN ('accepted', 'running')
        AND execution_link_json IS NULL
      RETURNING id`.pipe(Effect.mapError(repositoryError))
    return rows[0] !== undefined
  }),
})
