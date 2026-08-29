import * as ExecutionGateway from "@rika/product/execution-gateway"
import { RepositoryError } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
import { TurnId } from "@rika/product/turn-record"
import { and, asc, eq, isNull, sql } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Schema } from "effect"
import { rikaTurnAdmissionOutbox, rikaTurns } from "../../database/schema/product"
import { decodeAgent } from "./row-codec"
import { turnRowJson } from "./row-json-codec"
import { missing, repositoryError } from "./errors"

const OutboxRow = Schema.Struct({
  turn_id: Schema.String,
  start_input_json: Schema.String,
  prepared_at: Schema.Finite,
})

const equivalentStartTurn = Schema.toEquivalence(ExecutionGateway.StartTurn)
const admissionFields = {
  turn_id: rikaTurnAdmissionOutbox.turnId,
  start_input_json: rikaTurnAdmissionOutbox.startInputJson,
  prepared_at: rikaTurnAdmissionOutbox.preparedAt,
}
const turnFields = {
  id: rikaTurns.id,
  thread_id: rikaTurns.threadId,
  turn_kind: rikaTurns.turnKind,
  prompt: rikaTurns.prompt,
  status: rikaTurns.status,
  execution_route_json: rikaTurns.executionRouteJson,
  execution_link_json: rikaTurns.executionLinkJson,
  prompt_parts_json: rikaTurns.promptPartsJson,
  shell_command: rikaTurns.shellCommand,
  shell_result_text: rikaTurns.shellResultText,
  shell_result_truncated: rikaTurns.shellResultTruncated,
  shell_result_exit_code: rikaTurns.shellResultExitCode,
  author_json: rikaTurns.authorJson,
  lineage_json: rikaTurns.lineageJson,
  created_at: rikaTurns.createdAt,
  updated_at: rikaTurns.updatedAt,
}

const decodeStartTurn = <Row>(row: Row) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(OutboxRow)(row)
    return yield* Schema.decodeEffect(turnRowJson.startTurn)(decoded.start_input_json)
  })

export const makeTurnSqlAdmission = (
  db: PgDrizzle.EffectPgDatabase,
): Pick<Interface, "prepareExecutionAdmission" | "listUnlinkedExecutionAdmissions" | "attachExecutionLink"> => ({
  prepareExecutionAdmission: Effect.fn("TurnRepository.prepareExecutionAdmission")(function* (input, now) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const prepared = yield* Schema.decodeEffect(ExecutionGateway.StartTurn)(input)
          const turnId = yield* Schema.decodeEffect(TurnId)(prepared.turnId)
          const encoded = yield* Schema.encodeEffect(turnRowJson.startTurn)(prepared)
          const source = tx
            .select({
              turnId: rikaTurns.id,
              startInputJson: sql<string>`${encoded}`.as("start_input_json"),
              preparedAt: sql<number>`${now}`.as("prepared_at"),
            })
            .from(rikaTurns)
            .where(
              and(
                eq(rikaTurns.id, turnId),
                eq(rikaTurns.threadId, prepared.threadId),
                eq(rikaTurns.turnKind, "AgentExecution"),
              ),
            )
          const inserted = yield* tx
            .insert(rikaTurnAdmissionOutbox)
            .select(source)
            .onConflictDoNothing({ target: rikaTurnAdmissionOutbox.turnId })
            .returning(admissionFields)
          const row =
            inserted[0] ??
            (yield* tx
              .select(admissionFields)
              .from(rikaTurnAdmissionOutbox)
              .where(eq(rikaTurnAdmissionOutbox.turnId, turnId)))[0]
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
    const rows = yield* db
      .select(admissionFields)
      .from(rikaTurnAdmissionOutbox)
      .innerJoin(rikaTurns, eq(rikaTurns.id, rikaTurnAdmissionOutbox.turnId))
      .where(isNull(rikaTurns.executionLinkJson))
      .orderBy(asc(rikaTurnAdmissionOutbox.preparedAt), asc(rikaTurnAdmissionOutbox.turnId))
    return yield* Effect.all(rows.map(decodeStartTurn))
  }).pipe(Effect.mapError(repositoryError), Effect.withSpan("TurnRepository.listUnlinkedExecutionAdmissions")),
  attachExecutionLink: Effect.fn("TurnRepository.attachExecutionLink")(function* (id, link, now) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const existingRows = yield* tx
            .select(turnFields)
            .from(rikaTurns)
            .where(and(eq(rikaTurns.id, id), eq(rikaTurns.turnKind, "AgentExecution")))
          if (existingRows[0] === undefined) return yield* missing(id)
          const existing = yield* decodeAgent(existingRows[0])
          if (existing.executionLink !== undefined) {
            if (
              existing.executionLink.runId !== link.runId ||
              existing.executionLink.turnId !== link.turnId ||
              existing.executionLink.threadId !== link.threadId
            )
              return yield* RepositoryError.make({ message: `Turn ${id} already has a different execution link` })
            yield* tx.delete(rikaTurnAdmissionOutbox).where(eq(rikaTurnAdmissionOutbox.turnId, id))
            return existing
          }
          const admissionRows = yield* tx
            .select(admissionFields)
            .from(rikaTurnAdmissionOutbox)
            .where(eq(rikaTurnAdmissionOutbox.turnId, id))
          if (admissionRows[0] === undefined)
            return yield* RepositoryError.make({ message: `Turn ${id} has no prepared execution admission` })
          const admission = yield* decodeStartTurn(admissionRows[0])
          if (link.turnId !== admission.turnId || link.threadId !== admission.threadId)
            return yield* RepositoryError.make({
              message: `Execution link does not identify prepared admission for Turn ${id}`,
            })
          const encoded = yield* Schema.encodeEffect(turnRowJson.executionLink)(link)
          const rows = yield* tx
            .update(rikaTurns)
            .set({ executionLinkJson: encoded, updatedAt: now })
            .where(
              and(eq(rikaTurns.id, id), eq(rikaTurns.turnKind, "AgentExecution"), isNull(rikaTurns.executionLinkJson)),
            )
            .returning(turnFields)
          if (rows[0] === undefined)
            return yield* RepositoryError.make({ message: `Turn ${id} execution link changed while attaching` })
          const turn = yield* decodeAgent(rows[0])
          yield* tx.delete(rikaTurnAdmissionOutbox).where(eq(rikaTurnAdmissionOutbox.turnId, id))
          return turn
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
})
