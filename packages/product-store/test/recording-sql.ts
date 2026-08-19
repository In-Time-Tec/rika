import { Effect, Layer, Stream } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError"
import { makeCompilerSqlite } from "effect/unstable/sql/Statement"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"

export interface RecordedStatement {
  readonly sql: string
  readonly parameters: ReadonlyArray<unknown>
}

type Outcome =
  | { readonly _tag: "Rows"; readonly rows: ReadonlyArray<object> }
  | { readonly _tag: "Error"; readonly error: SqlError }

export interface RecordingSql {
  readonly statements: Array<RecordedStatement>
  readonly rows: (...rows: ReadonlyArray<object>) => void
  readonly error: (message: string) => void
  readonly layer: Layer.Layer<SqlClient.SqlClient>
}

export const makeRecordingSql = (): RecordingSql => {
  const statements: Array<RecordedStatement> = []
  const outcomes: Array<Outcome> = []
  const execute = (sql: string, parameters: ReadonlyArray<unknown>) => {
    const normalized = sql.replace(/\s+/g, " ").trim()
    if (/^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/.test(normalized)) return Effect.succeed([])
    statements.push({ sql: normalized, parameters })
    const outcome = outcomes.shift() ?? { _tag: "Rows", rows: [] }
    return outcome._tag === "Rows" ? Effect.succeed(outcome.rows) : Effect.fail(outcome.error)
  }
  const connection: Connection = {
    execute: (sql, parameters) => execute(sql, parameters),
    executeRaw: (sql, parameters) => execute(sql, parameters),
    executeStream: (sql, parameters) => Stream.unwrap(Effect.map(execute(sql, parameters), Stream.fromIterable)),
    executeValues: (sql, parameters) => Effect.map(execute(sql, parameters), () => []),
    executeValuesUnprepared: (sql, parameters) => Effect.map(execute(sql, parameters), () => []),
    executeUnprepared: (sql, parameters) => execute(sql, parameters),
  }
  return {
    statements,
    rows: (...rows) => outcomes.push({ _tag: "Rows", rows }),
    error: (message) =>
      outcomes.push({
        _tag: "Error",
        error: SqlError.make({ reason: UnknownError.make({ cause: message, message }) }),
      }),
    layer: Layer.effect(
      SqlClient.SqlClient,
      SqlClient.make({
        acquirer: Effect.succeed(connection),
        compiler: makeCompilerSqlite(),
        spanAttributes: [],
      }),
    ).pipe(Layer.provide(Layer.effect(Reactivity.Reactivity, Reactivity.make))),
  }
}
