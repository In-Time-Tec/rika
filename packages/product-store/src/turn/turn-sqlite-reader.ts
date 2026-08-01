import { Effect } from "effect"
import type { SqlClient as SqlClientType } from "effect/unstable/sql/SqlClient"
import { TurnId } from "@rika/product/turn-record"
import type { Turn } from "@rika/product/turn-record"
import { RepositoryError } from "@rika/product/turn-repository"
import { decode } from "./turn-row-codec"

export function readTurn(sql: SqlClientType): (id: TurnId) => Effect.Effect<Turn | undefined, RepositoryError>
export function readTurn(sql: SqlClientType, id: TurnId): Effect.Effect<Turn | undefined, RepositoryError>
export function readTurn(
  sql: SqlClientType,
  id?: TurnId,
):
  | Effect.Effect<Turn | undefined, RepositoryError>
  | ((id: TurnId) => Effect.Effect<Turn | undefined, RepositoryError>) {
  if (id === undefined) return (nextId) => readTurn(sql, nextId)
  return sql`SELECT * FROM rika_turns WHERE id = ${id}`.pipe(
    Effect.mapError((cause) => RepositoryError.make({ message: String(cause) })),
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(null).pipe(Effect.as(undefined)) : decode(rows[0]),
    ),
  )
}
