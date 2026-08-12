import { Service, RepositoryError } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
type PageResult = Effect.Success<ReturnType<Interface["page"]>>
export { Service, RepositoryError }
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { TurnId } from "@rika/product/turn-record"
import { repositoryError } from "./turn-memory-errors"
import { cursorFor, pageSize } from "./turn-memory-state"
import { decode, decodeAgent } from "./turn-row-codec"
import { readTurn } from "./turn-sqlite-reader"
import { listAgentTurns } from "./turn-sqlite-queries"
import { makeTurnSqliteQueue } from "./turn-sqlite-queue"
import { makeTurnSqliteAdmission } from "./turn-sqlite-admission"
import { makeTurnSqliteSteeringAdmission } from "./turn-sqlite-steering-admission"
import { makeTurnSqliteState } from "./turn-sqlite-state"
import { makeTurnSqliteSubmission } from "./turn-sqlite-submission"
import { makeTurnSqliteRecordedShell } from "./turn-sqlite-recorded-shell"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const get = Effect.fn("TurnRepository.get")((id: TurnId) => readTurn(sql, id))
    return Service.of({
      ...makeTurnSqliteSubmission(sql),
      ...makeTurnSqliteRecordedShell(sql),
      ...makeTurnSqliteQueue(sql),
      ...makeTurnSqliteAdmission(sql),
      ...makeTurnSqliteSteeringAdmission(sql),
      ...makeTurnSqliteState(sql),
      get,
      list: Effect.fn("TurnRepository.list")(function* (threadId): Effect.fn.Return<
        ReadonlyArray<import("@rika/product/turn-record").Turn>,
        import("@rika/product/turn-repository").RepositoryError
      > {
        const rows =
          yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} ORDER BY created_at ASC, rowid ASC`.pipe(
            Effect.mapError(repositoryError),
          )
        return yield* Effect.all(rows.map(decode))
      }),
      listRecentNonqueued: Effect.fn("TurnRepository.listRecentNonqueued")(
        function* (
          threadId,
          limit,
        ): Effect.fn.Return<
          ReadonlyArray<import("@rika/product/turn-record").Turn>,
          import("@rika/product/turn-repository").RepositoryError
        > {
          const rows = yield* sql`SELECT * FROM rika_turns
          WHERE thread_id = ${threadId} AND status <> 'queued'
          ORDER BY created_at DESC, id DESC LIMIT ${Math.max(0, Math.floor(limit))}`.pipe(
            Effect.mapError(repositoryError),
          )
          return (yield* Effect.all(rows.map(decode))).toReversed()
        },
      ),
      page: Effect.fn("TurnRepository.page")(function* (
        threadId,
        options = {},
      ): Effect.fn.Return<PageResult, import("@rika/product/turn-repository").RepositoryError> {
        const limit = pageSize(options.limit)
        const rows =
          options.before === undefined
            ? yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`.pipe(
                Effect.mapError(repositoryError),
              )
            : yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} AND (created_at < ${options.before.createdAt} OR (created_at = ${options.before.createdAt} AND id < ${options.before.id})) ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`.pipe(
                Effect.mapError(repositoryError),
              )
        const turns = (yield* Effect.all(rows.slice(0, limit).map(decode))).toReversed()
        return {
          turns,
          hasOlder: rows.length > limit,
          oldestCursor: cursorFor(turns[0]),
          newestCursor: cursorFor(turns.at(-1)),
        }
      }),
      findActive: Effect.fn("TurnRepository.findActive")(function* (threadId): Effect.fn.Return<
        import("@rika/product/turn-record").AgentExecutionTurn | undefined,
        import("@rika/product/turn-repository").RepositoryError
      > {
        const rows =
          yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} AND turn_kind = 'AgentExecution' AND status IN ('accepted', 'running', 'waiting', 'cancelling') ORDER BY created_at ASC, rowid ASC LIMIT 1`.pipe(
            Effect.mapError(repositoryError),
          )
        return rows[0] === undefined ? undefined : yield* decodeAgent(rows[0])
      }),
      listNonterminal: listAgentTurns(sql, repositoryError).pipe(Effect.withSpan("TurnRepository.listNonterminal")),
    })
  }),
)
export { makeMemory, memoryLayer, memoryCoordinator } from "./memory-turn-repository"
