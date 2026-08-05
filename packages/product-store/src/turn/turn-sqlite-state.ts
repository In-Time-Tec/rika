import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { RepositoryError } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
import { decodeAgent } from "./turn-row-codec"
import { missing, repositoryError } from "./turn-memory-errors"
import { turnRowJson } from "./turn-row-json-codec"
export const makeTurnSqliteState = (
  sql: SqlClient,
): Pick<Interface, "setStatus" | "attachExecutionLink" | "startAccepted" | "cancelAccepted"> => ({
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
  attachExecutionLink: Effect.fn("TurnRepository.attachExecutionLink")(function* (id, link, now) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const encoded = yield* Schema.encodeEffect(turnRowJson.executionLink)(link)
          const rows = yield* sql`UPDATE rika_turns SET execution_link_json = ${encoded}, updated_at = ${now}
          WHERE id = ${id} AND turn_kind = 'AgentExecution' AND execution_link_json IS NULL RETURNING *`
          if (rows[0] !== undefined) return yield* decodeAgent(rows[0])
          const existing = yield* sql`SELECT * FROM rika_turns WHERE id = ${id} AND turn_kind = 'AgentExecution'`
          if (existing[0] === undefined) return yield* missing(id)
          const turn = yield* decodeAgent(existing[0])
          if (
            turn.executionLink === undefined ||
            turn.executionLink.runId !== link.runId ||
            turn.executionLink.turnId !== link.turnId ||
            turn.executionLink.threadId !== link.threadId
          )
            return yield* RepositoryError.make({ message: `Turn ${id} already has a different execution link` })
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
  cancelAccepted: Effect.fn("TurnRepository.cancelAccepted")(function* (id, now) {
    const rows = yield* sql`UPDATE rika_turns SET status = 'cancelled', updated_at = ${now}
      WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status = 'accepted'
      RETURNING id`.pipe(Effect.mapError(repositoryError))
    return rows[0] !== undefined
  }),
})
