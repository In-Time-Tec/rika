import * as ExecutionGateway from "@rika/product/execution-gateway"
import { RepositoryError } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
import { TurnId } from "@rika/product/turn-record"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { decodeAgent } from "./turn-row-codec"
import { turnRowJson } from "./turn-row-json-codec"
import { missing, repositoryError } from "./turn-memory-errors"

const OutboxRow = Schema.Struct({
  turn_id: Schema.String,
  start_input_json: Schema.String,
  prepared_at: Schema.Finite,
})

const equivalentStartTurn = Schema.toEquivalence(ExecutionGateway.StartTurn)

const decodeStartTurn = (row: unknown) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(OutboxRow)(row)
    return yield* Schema.decodeUnknownEffect(turnRowJson.startTurn)(decoded.start_input_json)
  })

export const makeTurnSqliteAdmission = (
  sql: SqlClient,
): Pick<Interface, "prepareExecutionAdmission" | "listUnlinkedExecutionAdmissions" | "attachExecutionLink"> => ({
  prepareExecutionAdmission: Effect.fn("TurnRepository.prepareExecutionAdmission")(function* (input, now) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const prepared = yield* Schema.decodeUnknownEffect(ExecutionGateway.StartTurn)(input)
          const turnId = yield* Schema.decodeUnknownEffect(TurnId)(prepared.turnId)
          const encoded = yield* Schema.encodeEffect(turnRowJson.startTurn)(prepared)
          const inserted = yield* sql`INSERT INTO rika_turn_admission_outbox (
              turn_id, start_input_json, prepared_at
            )
            SELECT id, ${encoded}, ${now} FROM rika_turns
            WHERE id = ${turnId} AND thread_id = ${prepared.threadId} AND turn_kind = 'AgentExecution'
            ON CONFLICT(turn_id) DO NOTHING
            RETURNING *`
          const row = inserted[0] ?? (yield* sql`SELECT * FROM rika_turn_admission_outbox WHERE turn_id = ${turnId}`)[0]
          if (row === undefined) return yield* missing(turnId)
          const persisted = yield* decodeStartTurn(row)
          if (!equivalentStartTurn(persisted, prepared))
            return yield* RepositoryError.make({
              message: `Turn ${prepared.turnId} already has different prepared execution admission`,
            })
          return persisted
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
  listUnlinkedExecutionAdmissions: Effect.gen(function* () {
    const rows = yield* sql`SELECT admission.* FROM rika_turn_admission_outbox AS admission
      INNER JOIN rika_turns AS turn ON turn.id = admission.turn_id
      WHERE turn.execution_link_json IS NULL
      ORDER BY admission.prepared_at ASC, admission.turn_id ASC`
    return yield* Effect.all(rows.map(decodeStartTurn))
  }).pipe(Effect.mapError(repositoryError), Effect.withSpan("TurnRepository.listUnlinkedExecutionAdmissions")),
  attachExecutionLink: Effect.fn("TurnRepository.attachExecutionLink")(function* (id, link, now) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existingRows = yield* sql`SELECT * FROM rika_turns WHERE id = ${id} AND turn_kind = 'AgentExecution'`
          if (existingRows[0] === undefined) return yield* missing(id)
          const existing = yield* decodeAgent(existingRows[0])
          if (existing.executionLink !== undefined) {
            if (
              existing.executionLink.runId !== link.runId ||
              existing.executionLink.turnId !== link.turnId ||
              existing.executionLink.threadId !== link.threadId
            )
              return yield* RepositoryError.make({ message: `Turn ${id} already has a different execution link` })
            yield* sql`DELETE FROM rika_turn_admission_outbox WHERE turn_id = ${id}`
            return existing
          }
          const admissionRows = yield* sql`SELECT * FROM rika_turn_admission_outbox WHERE turn_id = ${id}`
          if (admissionRows[0] === undefined)
            return yield* RepositoryError.make({ message: `Turn ${id} has no prepared execution admission` })
          const admission = yield* decodeStartTurn(admissionRows[0])
          if (link.turnId !== admission.turnId || link.threadId !== admission.threadId)
            return yield* RepositoryError.make({
              message: `Execution link does not identify prepared admission for Turn ${id}`,
            })
          const encoded = yield* Schema.encodeEffect(turnRowJson.executionLink)(link)
          const rows = yield* sql`UPDATE rika_turns SET execution_link_json = ${encoded}, updated_at = ${now}
            WHERE id = ${id} AND turn_kind = 'AgentExecution' AND execution_link_json IS NULL RETURNING *`
          if (rows[0] === undefined)
            return yield* RepositoryError.make({ message: `Turn ${id} execution link changed while attaching` })
          const turn = yield* decodeAgent(rows[0])
          yield* sql`DELETE FROM rika_turn_admission_outbox WHERE turn_id = ${id}`
          return turn
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
})
