import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { isAgentExecution } from "@rika/product/turn-record"
import type { RunningRecordedShellTurn, TerminalRecordedShellTurn } from "@rika/product/turn-record"
import { RepositoryError } from "@rika/product/transcript-repository"
import type { Interface } from "@rika/product/transcript-repository"
import { support } from "./transcript-repository-support"
import type { makeTranscriptSqliteCheckpoints } from "./transcript-sqlite-checkpoints"

const {
  error,
  refoldStale,
  isRefoldStale,
  refoldTurn,
  recordedShellProjection,
  validateRecordedShellProjection,
  validateUnits,
  validateCheckpoint,
  validateAttachmentSet,
  validateDelta,
} = support

const makeTranscriptSqliteWrites = (
  sql: SqlClient,
  checkpoints: ReturnType<typeof makeTranscriptSqliteCheckpoints>,
  get: Interface["get"],
): Pick<
  Interface,
  "commitDelta" | "replaceForRefold" | "createRecordedShell" | "copyRecordedShell" | "settleRecordedShell"
> => {
  const {
    commitCheckpoint,
    replaceCheckpointForRefold,
    loadExecutionCheckpoints,
    loadAttachmentUnits,
    validateDurableUnitRemoval,
    storeUnit,
    storeExecutionCheckpoint,
  } = checkpoints
  const insertRecordedShell = Effect.fn("TranscriptRepository.insertRecordedShell")(function* (
    turn: RunningRecordedShellTurn | TerminalRecordedShellTurn,
    projectionVersion: number,
  ) {
    const projection = recordedShellProjection(turn)
    yield* validateUnits(projection.units)
    yield* validateRecordedShellProjection(turn, projection, projectionVersion)
    const result = turn.status === "running" ? undefined : turn.result
    let resultTruncated: number | null = null
    if (result !== undefined) resultTruncated = result.truncated ? 1 : 0
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO rika_turns (
            id, thread_id, turn_kind, prompt, shell_command, status, stop_intent,
            shell_result_text, shell_result_truncated, shell_result_exit_code,
            author_json, lineage_json, created_at, updated_at
          ) VALUES (
            ${turn.id}, ${turn.threadId}, 'RecordedShell', ${turn.prompt}, ${turn.command},
            ${turn.status}, 'none', ${result?.text ?? null},
            ${resultTruncated}, ${result?.exitCode ?? null},
            '{"_tag":"Human"}', '{"_tag":"Original"}', ${turn.createdAt}, ${turn.updatedAt}
          )`
          const committed = yield* commitCheckpoint(turn, TranscriptProjection.Projection.projectionState(projection), {
            executionCheckpoints: [],
            projectionVersion,
            expectedGeneration: undefined,
          })
          if (!committed)
            return yield* RepositoryError.make({ message: `Recorded shell transcript ${turn.id} already exists` })
          yield* Effect.forEach(projection.units, (unit) => storeUnit(turn, unit), { discard: true })
          const stored = yield* get(turn.id)
          if (stored === undefined)
            return yield* RepositoryError.make({ message: `Recorded shell transcript ${turn.id} was not stored` })
          return stored
        }),
      )
      .pipe(Effect.mapError(error))
  })
  return {
    commitDelta: Effect.fn("TranscriptRepository.commitDelta")(function* (turn, state, delta, options) {
      yield* validateDelta(delta)
      yield* validateCheckpoint(turn, state, options)
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            if (!(yield* commitCheckpoint(turn, state, options))) return "stale" as const
            const storedCheckpoints = new Map(
              (yield* loadExecutionCheckpoints(turn.id)).map((checkpoint) => [checkpoint.executionKey, checkpoint]),
            )
            for (const checkpoint of options.executionCheckpoints)
              storedCheckpoints.set(checkpoint.executionKey, checkpoint)
            const merged = [...storedCheckpoints.values()]
            yield* validateCheckpoint(
              turn,
              state,
              { executionCheckpoints: merged, projectionVersion: options.projectionVersion },
              true,
            )
            const attachmentUnits = yield* loadAttachmentUnits(turn, delta, merged)
            yield* validateAttachmentSet(turn, attachmentUnits, merged)
            yield* Effect.forEach(
              delta.remove,
              (key) =>
                Effect.gen(function* () {
                  yield* validateDurableUnitRemoval(turn, key)
                  yield* sql`DELETE FROM rika_transcript_units WHERE turn_id = ${turn.id} AND unit_key = ${key}`
                }).pipe(Effect.mapError(error)),
              { discard: true },
            )
            yield* Effect.forEach(delta.upsert, (unit) => storeUnit(turn, unit), { discard: true })
            yield* Effect.forEach(
              options.executionCheckpoints,
              (checkpoint) => storeExecutionCheckpoint(turn, checkpoint),
              { discard: true },
            )
            return "committed" as const
          }),
        )
        .pipe(Effect.mapError(error))
    }),
    replaceForRefold: Effect.fn("TranscriptRepository.replaceForRefold")(function* (turn, projection, options) {
      yield* validateUnits(projection.units)
      yield* validateCheckpoint(turn, TranscriptProjection.Projection.projectionState(projection), options, true)
      yield* validateAttachmentSet(turn, projection.units, options.executionCheckpoints)
      const replacementTurn = yield* refoldTurn(turn, projection, options)
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const adopted = yield* sql`UPDATE rika_turns
          SET status = ${replacementTurn.status}, last_cursor = ${replacementTurn.lastCursor}
          WHERE id = ${turn.id} AND status = ${turn.status}
            AND last_cursor IS ${turn.lastCursor ?? null}
          RETURNING id`
            if (adopted.length === 0) return yield* refoldStale
            if (!(yield* replaceCheckpointForRefold(replacementTurn, projection, options))) return yield* refoldStale
            yield* sql`DELETE FROM rika_transcript_execution_checkpoints WHERE turn_id = ${turn.id}`.pipe(
              Effect.mapError(error),
            )
            yield* sql`DELETE FROM rika_transcript_units WHERE turn_id = ${turn.id}`.pipe(Effect.mapError(error))
            yield* Effect.forEach(projection.units, (unit) => storeUnit(replacementTurn, unit), { discard: true })
            yield* Effect.forEach(
              options.executionCheckpoints,
              (checkpoint) => storeExecutionCheckpoint(replacementTurn, checkpoint),
              { discard: true },
            )
            const committed = yield* get(turn.id)
            if (committed === undefined)
              return yield* RepositoryError.make({ message: `Transcript ${turn.id} disappeared during refold` })
            if (!isAgentExecution(committed.turn))
              return yield* RepositoryError.make({ message: `Transcript ${turn.id} changed turn kind during refold` })
            return { _tag: "Committed", turn: committed.turn } as const
          }),
        )
        .pipe(
          Effect.catch((failure) =>
            isRefoldStale(failure) ? Effect.succeed({ _tag: "Stale" } as const) : Effect.fail(error(failure)),
          ),
        )
    }),
    createRecordedShell: insertRecordedShell,
    copyRecordedShell: insertRecordedShell,
    settleRecordedShell: Effect.fn("TranscriptRepository.settleRecordedShell")(
      function* (expected, turn, expectedGeneration, projectionVersion) {
        if (
          turn.id !== expected.id ||
          turn.threadId !== expected.threadId ||
          turn.prompt !== expected.prompt ||
          turn.command !== expected.command ||
          turn.createdAt !== expected.createdAt ||
          turn.updatedAt < expected.updatedAt
        )
          return yield* RepositoryError.make({
            message: `Recorded shell turn ${turn.id} changed its intrinsic identity`,
          })
        const projection = recordedShellProjection(turn)
        yield* validateUnits(projection.units)
        yield* validateRecordedShellProjection(turn, projection, projectionVersion)
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const updated = yield* sql`UPDATE rika_turns SET
              status = ${turn.status}, shell_result_text = ${turn.result.text},
              shell_result_truncated = ${turn.result.truncated ? 1 : 0},
              shell_result_exit_code = ${turn.result.exitCode ?? null}, updated_at = ${turn.updatedAt}
            WHERE id = ${expected.id} AND turn_kind = 'RecordedShell' AND status = 'running'
              AND thread_id = ${expected.threadId} AND prompt = ${expected.prompt}
              AND shell_command = ${expected.command} AND created_at = ${expected.createdAt}
              AND updated_at = ${expected.updatedAt}
            RETURNING id`
              if (updated.length === 0) return yield* refoldStale
              const committed = yield* commitCheckpoint(
                turn,
                TranscriptProjection.Projection.projectionState(projection),
                {
                  executionCheckpoints: [],
                  projectionVersion,
                  expectedGeneration,
                },
              )
              if (!committed) return yield* refoldStale
              yield* Effect.forEach(projection.units, (unit) => storeUnit(turn, unit), { discard: true })
              const stored = yield* get(turn.id)
              if (stored === undefined)
                return yield* RepositoryError.make({
                  message: `Recorded shell transcript ${turn.id} disappeared`,
                })
              return { _tag: "Committed" as const, projection: stored }
            }),
          )
          .pipe(
            Effect.catch((failure) =>
              isRefoldStale(failure) ? Effect.succeed({ _tag: "Stale" } as const) : Effect.fail(error(failure)),
            ),
          )
      },
    ),
  }
}

export const transcriptSqliteWrites = { make: makeTranscriptSqliteWrites }
