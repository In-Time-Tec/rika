import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import type { Interface } from "@rika/product/turn-repository"
import { decode } from "./turn-row-codec"
import { repositoryError } from "./turn-memory-errors"
import { TurnResult } from "@rika/product/thread-result"

const insert = (
  sql: SqlClient,
  turn: Parameters<Interface["copyRecordedShell"]>[0] | Parameters<Interface["createRecordedShell"]>[0],
) => {
  const result = turn.status === "running" ? undefined : turn.result
  const truncated = result?.truncated === true ? 1 : 0
  return sql`INSERT INTO rika_turns (
      id, thread_id, turn_kind, prompt, shell_command, shell_result_text, shell_result_truncated,
      shell_result_exit_code, author_json, lineage_json, status, created_at, updated_at
    ) VALUES (
      ${turn.id}, ${turn.threadId}, 'RecordedShell', ${turn.prompt}, ${turn.command},
      ${result?.text ?? null},
      ${result === undefined ? null : truncated},
      ${result?.exitCode ?? null},
      ${JSON.stringify(turn.author)}, ${JSON.stringify(turn.lineage)}, ${turn.status}, ${turn.createdAt}, ${turn.updatedAt}
    ) RETURNING *`
}

export const makeTurnSqliteRecordedShell = (
  sql: SqlClient,
): Pick<Interface, "createRecordedShell" | "settleRecordedShell" | "copyRecordedShell"> => ({
  createRecordedShell: Effect.fn("TurnRepository.createRecordedShell")(function* (turn) {
    const rows = yield* insert(sql, turn).pipe(Effect.mapError(repositoryError))
    const decoded = yield* decode(rows[0])
    if (!TurnResult.isRunningRecordedShell(decoded))
      return yield* repositoryError(`Turn ${turn.id} is not a running recorded shell`)
    return decoded
  }),
  copyRecordedShell: Effect.fn("TurnRepository.copyRecordedShell")(function* (turn) {
    const rows = yield* insert(sql, turn).pipe(Effect.mapError(repositoryError))
    const decoded = yield* decode(rows[0])
    if (!TurnResult.isTerminalRecordedShell(decoded))
      return yield* repositoryError(`Turn ${turn.id} is not a terminal recorded shell`)
    return decoded
  }),
  settleRecordedShell: Effect.fn("TurnRepository.settleRecordedShell")(function* (expected, turn) {
    const rows = yield* sql`UPDATE rika_turns SET
      status = ${turn.status}, shell_result_text = ${turn.result.text},
      shell_result_truncated = ${turn.result.truncated ? 1 : 0},
      shell_result_exit_code = ${turn.result.exitCode ?? null}, updated_at = ${turn.updatedAt}
      WHERE id = ${expected.id} AND thread_id = ${expected.threadId} AND turn_kind = 'RecordedShell'
        AND status = 'running' AND prompt = ${expected.prompt} AND shell_command = ${expected.command}
      RETURNING *`.pipe(Effect.mapError(repositoryError))
    if (rows[0] === undefined) return undefined
    const decoded = yield* decode(rows[0])
    if (!TurnResult.isTerminalRecordedShell(decoded))
      return yield* repositoryError(`Turn ${turn.id} did not settle as a recorded shell`)
    return decoded
  }),
})
