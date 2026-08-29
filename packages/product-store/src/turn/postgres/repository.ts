import { PageCursor, Service, RepositoryError, defaultPageSize, maximumPageSize } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
type PageResult = Effect.Success<ReturnType<Interface["page"]>>
export { Service, RepositoryError }
import { and, asc, desc, eq, inArray, lt, ne, or } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Layer } from "effect"
import { TurnId } from "@rika/product/turn-record"
import { rikaTurns } from "../../database/schema/product"
import { repositoryError } from "./errors"
import { decode, decodeAgent } from "./row-codec"
import { readTurn, turnRowSelection } from "./reader"
import { listAgentTurns } from "./queries"
import * as TurnSqlQueue from "./queue"
import * as TurnSqlAdmission from "./admission"
import * as TurnSqlSteeringAdmission from "./steering-admission"
import * as TurnSqlState from "./state"
import * as TurnSqlSubmission from "./submission"
import * as TurnSqlRecordedShell from "./recorded-shell"

const pageSize = (limit: number | undefined) =>
  Math.min(maximumPageSize, Math.max(1, Math.floor(limit ?? defaultPageSize)))
const cursorFor = (turn: import("@rika/product/turn-record").Turn | undefined) =>
  turn === undefined ? undefined : PageCursor.make({ createdAt: turn.createdAt, id: turn.id })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.makeWithDefaults()
    const get = Effect.fn("TurnRepository.get")((id: TurnId) => readTurn(db, id))
    return Service.of({
      ...TurnSqlSubmission.makeTurnSqlSubmission(db),
      ...TurnSqlRecordedShell.makeTurnSqlRecordedShell(db),
      ...TurnSqlQueue.makeTurnSqlQueue(db),
      ...TurnSqlAdmission.makeTurnSqlAdmission(db),
      ...TurnSqlSteeringAdmission.makeTurnSqlSteeringAdmission(db),
      ...TurnSqlState.makeTurnSqlState(db),
      get,
      list: Effect.fn("TurnRepository.list")(function* (threadId): Effect.fn.Return<
        ReadonlyArray<import("@rika/product/turn-record").Turn>,
        import("@rika/product/turn-repository").RepositoryError
      > {
        const rows = yield* db
          .select(turnRowSelection)
          .from(rikaTurns)
          .where(eq(rikaTurns.threadId, threadId))
          .orderBy(asc(rikaTurns.createdAt), asc(rikaTurns.id))
          .pipe(Effect.mapError(repositoryError))
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
          const rows = yield* db
            .select(turnRowSelection)
            .from(rikaTurns)
            .where(and(eq(rikaTurns.threadId, threadId), ne(rikaTurns.status, "queued")))
            .orderBy(desc(rikaTurns.createdAt), desc(rikaTurns.id))
            .limit(Math.max(0, Math.floor(limit)))
            .pipe(Effect.mapError(repositoryError))
          return (yield* Effect.all(rows.map(decode))).toReversed()
        },
      ),
      page: Effect.fn("TurnRepository.page")(function* (
        threadId,
        options = {},
      ): Effect.fn.Return<PageResult, import("@rika/product/turn-repository").RepositoryError> {
        const limit = pageSize(options.limit)
        const cursor = options.before
        const rows = yield* db
          .select(turnRowSelection)
          .from(rikaTurns)
          .where(
            and(
              eq(rikaTurns.threadId, threadId),
              cursor === undefined
                ? undefined
                : or(
                    lt(rikaTurns.createdAt, cursor.createdAt),
                    and(eq(rikaTurns.createdAt, cursor.createdAt), lt(rikaTurns.id, cursor.id)),
                  ),
            ),
          )
          .orderBy(desc(rikaTurns.createdAt), desc(rikaTurns.id))
          .limit(limit + 1)
          .pipe(Effect.mapError(repositoryError))
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
        const rows = yield* db
          .select(turnRowSelection)
          .from(rikaTurns)
          .where(
            and(
              eq(rikaTurns.threadId, threadId),
              eq(rikaTurns.turnKind, "AgentExecution"),
              inArray(rikaTurns.status, ["accepted", "running", "waiting", "cancelling"]),
            ),
          )
          .orderBy(asc(rikaTurns.createdAt), asc(rikaTurns.id))
          .limit(1)
          .pipe(Effect.mapError(repositoryError))
        return rows[0] === undefined ? undefined : yield* decodeAgent(rows[0])
      }),
      listNonterminal: listAgentTurns(db, repositoryError).pipe(Effect.withSpan("TurnRepository.listNonterminal")),
    })
  }),
)
