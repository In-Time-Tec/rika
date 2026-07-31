import { Service } from "@rika/product/turn-repository"
import {
  decode,
  decodeAgent,
  decodeQueueState,
  encodeExtensionPin,
  decodeStoredTurn,
  StoredTurnRow,
  ExtensionPinJson,
  PromptPartsJson,
  ExecutionRouteJson,
  AuthorJson,
  LineageJson,
} from "./turn-row-codec"
import {
  clone,
  cursorFor,
  isTerminalStatus,
  missing,
  pageSize,
  queuedTurnUnavailable,
  repositoryError,
  submissionError,
  takeQueuedError,
} from "./turn-memory-support"
export { Service }
import { Effect, Layer, Ref, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { ThreadId } from "@rika/product/thread-record"
import * as ExecutionStatus from "@rika/product/execution-status"
import {
  AgentExecutionTurn,
  ExecutionExtensionPin,
  ExecutionRoutePin,
  PromptPart,
  RecordedShellTurn,
  Status,
  StopIntent,
  Turn,
  TurnAuthor,
  TurnId,
  TurnLineage,
  isAgentExecution,
  isRunningRecordedShell,
} from "@rika/product/turn-record"
import type { RunningRecordedShellTurn } from "@rika/product/turn-record"

export { RepositoryError, QueueFull, QueuedTurnUnavailable } from "@rika/product/turn-repository"
import { RepositoryError, QueueFull, QueuedTurnUnavailable } from "@rika/product/turn-repository"

export interface CreateInput {
  readonly id: TurnId
  readonly threadId: ThreadId
  readonly prompt: string
  readonly promptParts?: ReadonlyArray<PromptPart>
  readonly executionRoute: ExecutionRoutePin
  readonly reviewFanOutId?: string
  readonly author?: TurnAuthor
  readonly lineage?: TurnLineage
  readonly queueCapacity: number
  readonly now: number
}

export const PageCursor = Schema.Struct({ createdAt: Schema.Finite, id: TurnId })
export interface PageCursor extends Schema.Schema.Type<typeof PageCursor> {}

export interface PageOptions {
  readonly before?: PageCursor | undefined
  readonly limit?: number
}

export interface PageResult {
  readonly turns: ReadonlyArray<Turn>
  readonly hasOlder: boolean
  readonly oldestCursor: PageCursor | undefined
  readonly newestCursor: PageCursor | undefined
}

export interface QueueItemChange {
  readonly threadId: ThreadId
  readonly revision: number
  readonly queuedCount: number
  readonly becameNonempty: boolean
  readonly change:
    | { readonly _tag: "Added"; readonly turn: AgentExecutionTurn }
    | { readonly _tag: "Updated"; readonly turn: AgentExecutionTurn }
    | { readonly _tag: "Removed"; readonly turnId: TurnId }
}

export interface QueueSnapshot {
  readonly threadId: ThreadId
  readonly revision: number
  readonly queuedCount: number
  readonly turns: ReadonlyArray<AgentExecutionTurn>
}

export type Submission = AgentExecutionTurn & { readonly queue?: QueueItemChange }

export interface QueueClaim {
  readonly turn: AgentExecutionTurn
  readonly token: string
}

export type QueueClaimFinish =
  | { readonly _tag: "Transitioned"; readonly turn: AgentExecutionTurn; readonly queue: QueueItemChange }
  | { readonly _tag: "Unavailable" }

export interface QueuedTurnTake {
  readonly turn: AgentExecutionTurn
  readonly queue: QueueItemChange
}

export interface QueueWake {
  readonly threadId: ThreadId
  readonly generation: number
  readonly queueRevision: number
}

export const defaultPageSize = 50
export const maximumPageSize = 200

export interface Interface {
  readonly createForSubmission: (input: CreateInput) => Effect.Effect<Submission, RepositoryError | QueueFull>
  readonly copy: (
    turn: AgentExecutionTurn,
    queueCapacity: number,
  ) => Effect.Effect<Submission, RepositoryError | QueueFull>
  readonly get: (id: TurnId) => Effect.Effect<Turn | undefined, RepositoryError>
  readonly list: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Turn>, RepositoryError>
  readonly listRecentNonqueued: (
    threadId: ThreadId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<Turn>, RepositoryError>
  readonly page: (threadId: ThreadId, options?: PageOptions) => Effect.Effect<PageResult, RepositoryError>
  readonly findActive: (threadId: ThreadId) => Effect.Effect<AgentExecutionTurn | undefined, RepositoryError>
  readonly readQueue: (threadId: ThreadId) => Effect.Effect<QueueSnapshot, RepositoryError>
  readonly listNonterminal: Effect.Effect<ReadonlyArray<AgentExecutionTurn>, RepositoryError>
  readonly listStopRequested: Effect.Effect<ReadonlyArray<AgentExecutionTurn>, RepositoryError>
  readonly requestStop: (id: TurnId, now: number) => Effect.Effect<AgentExecutionTurn | undefined, RepositoryError>
  readonly claimNextQueued: (threadId: ThreadId, now: number) => Effect.Effect<QueueClaim | undefined, RepositoryError>
  readonly finishQueuedClaim: (
    claim: QueueClaim,
    status: "running" | "failed",
    lastCursor: string | undefined,
    extensionPin: ExecutionExtensionPin | undefined,
    now: number,
  ) => Effect.Effect<QueueClaimFinish, RepositoryError>
  readonly releaseQueuedClaim: (claim: QueueClaim) => Effect.Effect<void, RepositoryError>
  readonly resetQueueClaims: Effect.Effect<void, RepositoryError>
  readonly editQueued: (
    id: TurnId,
    prompt: string,
    now: number,
  ) => Effect.Effect<AgentExecutionTurn & { readonly queue: QueueItemChange }, RepositoryError>
  readonly takeQueued: (id: TurnId) => Effect.Effect<QueuedTurnTake, RepositoryError | QueuedTurnUnavailable>
  readonly dequeue: (id: TurnId) => Effect.Effect<QueueItemChange, RepositoryError>
  readonly requeueAccepted: (
    id: TurnId,
    queueCapacity: number,
    now: number,
  ) => Effect.Effect<AgentExecutionTurn & { readonly queue: QueueItemChange }, RepositoryError | QueueFull>
  readonly requestQueueWake: (threadId: ThreadId) => Effect.Effect<QueueWake | undefined, RepositoryError>
  readonly consumeQueueWake: (threadId: ThreadId, generation: number) => Effect.Effect<boolean, RepositoryError>
  readonly setExtensionPin: (
    id: TurnId,
    pin: ExecutionExtensionPin,
  ) => Effect.Effect<AgentExecutionTurn, RepositoryError>
  readonly setStatus: (
    id: TurnId,
    status: Status,
    lastCursor: string | undefined,
    now: number,
  ) => Effect.Effect<AgentExecutionTurn, RepositoryError>
  readonly startAccepted: (id: TurnId, now: number) => Effect.Effect<boolean, RepositoryError>
  readonly cancelAccepted: (id: TurnId, now: number) => Effect.Effect<boolean, RepositoryError>
  readonly repairCursor: (
    id: TurnId,
    status: Status,
    expectedCursor: string | undefined,
    cursor: string | undefined,
  ) => Effect.Effect<boolean, RepositoryError>
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const get = Effect.fn("TurnRepository.get")(function* (id: TurnId) {
      const rows = yield* sql`SELECT * FROM rika_turns WHERE id = ${id}`.pipe(Effect.mapError(repositoryError))
      return rows[0] === undefined ? undefined : yield* decode(rows[0])
    })
    return Service.of({
      createForSubmission: Effect.fn("TurnRepository.createForSubmission")(function* (input) {
        const promptParts =
          input.promptParts === undefined
            ? null
            : yield* Schema.encodeEffect(PromptPartsJson)(input.promptParts).pipe(Effect.mapError(repositoryError))
        const executionRoute = yield* Schema.encodeEffect(ExecutionRouteJson)(input.executionRoute).pipe(
          Effect.mapError(repositoryError),
        )
        const author = yield* Schema.encodeEffect(AuthorJson)(input.author ?? { _tag: "Human" }).pipe(
          Effect.mapError(repositoryError),
        )
        const lineage = yield* Schema.encodeEffect(LineageJson)(input.lineage ?? { _tag: "Original" }).pipe(
          Effect.mapError(repositoryError),
        )
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO rika_turns (id, thread_id, turn_kind, prompt, prompt_parts_json, execution_route_json, review_fan_out_id, author_json, lineage_json, status, created_at, updated_at)
                VALUES (${input.id}, ${input.threadId}, 'AgentExecution', ${input.prompt}, ${promptParts}, ${executionRoute}, ${input.reviewFanOutId ?? null}, ${author}, ${lineage},
                  CASE WHEN EXISTS (SELECT 1 FROM rika_turns WHERE thread_id = ${input.threadId} AND turn_kind = 'AgentExecution' AND status IN ('queued', 'accepted', 'running', 'waiting')) THEN 'queued' ELSE 'accepted' END,
                  ${input.now}, ${input.now})`
              const rows = yield* sql`SELECT * FROM rika_turns WHERE id = ${input.id}`
              if (rows[0] === undefined) return yield* missing(input.id)
              const turn = yield* decodeAgent(rows[0])
              if (turn.status !== "queued") return turn
              yield* sql`INSERT INTO rika_thread_queue_state (thread_id) VALUES (${input.threadId}) ON CONFLICT (thread_id) DO NOTHING`
              const queueRows = yield* sql`UPDATE rika_thread_queue_state
                SET revision = revision + 1, queued_count = queued_count + 1
                WHERE thread_id = ${input.threadId} AND queued_count < ${input.queueCapacity}
                RETURNING *`
              if (queueRows[0] === undefined) {
                const stateRows = yield* sql`SELECT * FROM rika_thread_queue_state WHERE thread_id = ${input.threadId}`
                if (stateRows[0] === undefined)
                  return yield* repositoryError(`Queue state ${input.threadId} does not exist`)
                const state = yield* decodeQueueState(stateRows[0])
                return yield* QueueFull.make({
                  threadId: input.threadId,
                  capacity: input.queueCapacity,
                  count: state.queued_count,
                })
              }
              const state = yield* decodeQueueState(queueRows[0])
              return {
                ...turn,
                queue: {
                  threadId: input.threadId,
                  revision: state.revision,
                  queuedCount: state.queued_count,
                  becameNonempty: state.queued_count === 1,
                  change: { _tag: "Added" as const, turn },
                },
              }
            }),
          )
          .pipe(Effect.mapError(submissionError))
      }),
      copy: Effect.fn("TurnRepository.copy")(function* (turn, queueCapacity) {
        const promptParts =
          turn.promptParts === undefined
            ? null
            : yield* Schema.encodeEffect(PromptPartsJson)(turn.promptParts).pipe(Effect.mapError(repositoryError))
        const extensionPin =
          turn.extensionPin === undefined
            ? null
            : yield* Schema.encodeEffect(ExtensionPinJson)(turn.extensionPin).pipe(Effect.mapError(repositoryError))
        const executionRoute = yield* Schema.encodeEffect(ExecutionRouteJson)(turn.executionRoute).pipe(
          Effect.mapError(repositoryError),
        )
        const author = yield* Schema.encodeEffect(AuthorJson)(turn.author).pipe(Effect.mapError(repositoryError))
        const lineage = yield* Schema.encodeEffect(LineageJson)(turn.lineage).pipe(Effect.mapError(repositoryError))
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO rika_turns (id, thread_id, turn_kind, prompt, prompt_parts_json, status, last_cursor, extension_pin_json, execution_route_json, review_fan_out_id, author_json, lineage_json, created_at, updated_at)
                VALUES (${turn.id}, ${turn.threadId}, 'AgentExecution', ${turn.prompt}, ${promptParts}, ${turn.status}, ${turn.lastCursor ?? null}, ${extensionPin}, ${executionRoute}, ${turn.reviewFanOutId ?? null}, ${author}, ${lineage}, ${turn.createdAt}, ${turn.updatedAt})`
              if (turn.status !== "queued") return turn
              yield* sql`INSERT INTO rika_thread_queue_state (thread_id) VALUES (${turn.threadId}) ON CONFLICT (thread_id) DO NOTHING`
              const queueRows = yield* sql`UPDATE rika_thread_queue_state
                SET revision = revision + 1, queued_count = queued_count + 1
                WHERE thread_id = ${turn.threadId} AND queued_count < ${queueCapacity}
                RETURNING *`
              if (queueRows[0] === undefined) {
                const stateRows = yield* sql`SELECT * FROM rika_thread_queue_state WHERE thread_id = ${turn.threadId}`
                if (stateRows[0] === undefined)
                  return yield* repositoryError(`Queue state ${turn.threadId} does not exist`)
                const state = yield* decodeQueueState(stateRows[0])
                return yield* QueueFull.make({
                  threadId: turn.threadId,
                  capacity: queueCapacity,
                  count: state.queued_count,
                })
              }
              const state = yield* decodeQueueState(queueRows[0])
              return {
                ...turn,
                queue: {
                  threadId: turn.threadId,
                  revision: state.revision,
                  queuedCount: state.queued_count,
                  becameNonempty: state.queued_count === 1,
                  change: { _tag: "Added" as const, turn },
                },
              }
            }),
          )
          .pipe(Effect.mapError(submissionError))
      }),
      get,
      list: Effect.fn("TurnRepository.list")(function* (threadId) {
        const rows =
          yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} ORDER BY created_at ASC, rowid ASC`.pipe(
            Effect.mapError(repositoryError),
          )
        return yield* Effect.all(rows.map(decode))
      }),
      listRecentNonqueued: Effect.fn("TurnRepository.listRecentNonqueued")(function* (threadId, limit) {
        const rows = yield* sql`SELECT * FROM rika_turns
          WHERE thread_id = ${threadId} AND status <> 'queued'
          ORDER BY created_at DESC, id DESC LIMIT ${Math.max(0, Math.floor(limit))}`.pipe(
          Effect.mapError(repositoryError),
        )
        return (yield* Effect.all(rows.map(decode))).toReversed()
      }),
      page: Effect.fn("TurnRepository.page")(function* (threadId, options = {}) {
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
      findActive: Effect.fn("TurnRepository.findActive")(function* (threadId) {
        const rows =
          yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} AND turn_kind = 'AgentExecution' AND status IN ('accepted', 'running', 'waiting') ORDER BY created_at ASC, rowid ASC LIMIT 1`.pipe(
            Effect.mapError(repositoryError),
          )
        return rows[0] === undefined ? undefined : yield* decodeAgent(rows[0])
      }),
      readQueue: Effect.fn("TurnRepository.readQueue")(function* (threadId) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const stateRows = yield* sql`SELECT * FROM rika_thread_queue_state WHERE thread_id = ${threadId}`
              const state = stateRows[0] === undefined ? undefined : yield* decodeQueueState(stateRows[0])
              const rows =
                yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} AND turn_kind = 'AgentExecution' AND status = 'queued' ORDER BY created_at ASC, rowid ASC`
              const turns = yield* Effect.all(rows.map(decodeAgent))
              return {
                threadId,
                revision: state?.revision ?? 0,
                queuedCount: state?.queued_count ?? 0,
                turns,
              }
            }),
          )
          .pipe(Effect.mapError(repositoryError))
      }),
      listNonterminal: Effect.gen(function* () {
        const rows =
          yield* sql`SELECT * FROM rika_turns WHERE turn_kind = 'AgentExecution' AND status IN ('queued', 'accepted', 'running', 'waiting') AND stop_intent = 'none' ORDER BY created_at ASC, rowid ASC`.pipe(
            Effect.mapError(repositoryError),
          )
        return yield* Effect.all(rows.map(decodeAgent))
      }).pipe(Effect.withSpan("TurnRepository.listNonterminal")),
      listStopRequested: Effect.gen(function* () {
        const rows =
          yield* sql`SELECT * FROM rika_turns WHERE turn_kind = 'AgentExecution' AND status IN ('queued', 'accepted', 'running', 'waiting') AND stop_intent = 'requested' ORDER BY created_at ASC, rowid ASC`.pipe(
            Effect.mapError(repositoryError),
          )
        return yield* Effect.all(rows.map(decodeAgent))
      }).pipe(Effect.withSpan("TurnRepository.listStopRequested")),
      requestStop: Effect.fn("TurnRepository.requestStop")(function* (id, now) {
        const rows = yield* sql`UPDATE rika_turns SET stop_intent = 'requested', updated_at = ${now}
          WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status IN ('queued', 'accepted', 'running', 'waiting') RETURNING *`.pipe(
          Effect.mapError(repositoryError),
        )
        const row = rows[0]
        return row === undefined ? undefined : yield* decodeAgent(row)
      }),
      claimNextQueued: Effect.fn("TurnRepository.claimNextQueued")(function* (threadId, _now) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql`UPDATE rika_turns SET queue_claim_token = hex(randomblob(16))
                WHERE id = (SELECT id FROM rika_turns WHERE thread_id = ${threadId} AND turn_kind = 'AgentExecution' AND status = 'queued' AND queue_claim_token IS NULL ORDER BY created_at ASC, rowid ASC LIMIT 1)
                AND turn_kind = 'AgentExecution'
                AND NOT EXISTS (SELECT 1 FROM rika_turns WHERE thread_id = ${threadId} AND turn_kind = 'AgentExecution' AND status IN ('accepted', 'running', 'waiting'))
                AND NOT EXISTS (SELECT 1 FROM rika_turns WHERE thread_id = ${threadId} AND turn_kind = 'AgentExecution' AND queue_claim_token IS NOT NULL)
                RETURNING *`
              if (rows[0] === undefined) return undefined
              const turn = yield* decodeAgent(rows[0])
              return { turn, token: String((rows[0] as { queue_claim_token: unknown }).queue_claim_token) }
            }),
          )
          .pipe(Effect.mapError(repositoryError))
      }),
      finishQueuedClaim: Effect.fn("TurnRepository.finishQueuedClaim")(
        function* (claim, status, lastCursor, extensionPin, now) {
          const encodedPin = extensionPin === undefined ? undefined : yield* encodeExtensionPin(extensionPin)
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const rows = yield* sql`UPDATE rika_turns
            SET status = ${status}, last_cursor = ${lastCursor ?? null}, extension_pin_json = COALESCE(extension_pin_json, ${encodedPin ?? null}), updated_at = ${now}, queue_claim_token = NULL
            WHERE id = ${claim.turn.id} AND turn_kind = 'AgentExecution' AND status = 'queued' AND queue_claim_token = ${claim.token} RETURNING *`
                if (rows[0] === undefined) return { _tag: "Unavailable" as const }
                const turn = yield* decodeAgent(rows[0])
                const queueRows = yield* sql`UPDATE rika_thread_queue_state
            SET revision = revision + 1, queued_count = MAX(queued_count - 1, 0)
            WHERE thread_id = ${turn.threadId} RETURNING *`
                if (queueRows[0] === undefined)
                  return yield* repositoryError(`Queue state ${turn.threadId} does not exist`)
                const state = yield* decodeQueueState(queueRows[0])
                return {
                  _tag: "Transitioned" as const,
                  turn,
                  queue: {
                    threadId: turn.threadId,
                    revision: state.revision,
                    queuedCount: state.queued_count,
                    becameNonempty: false,
                    change: { _tag: "Removed" as const, turnId: turn.id },
                  },
                }
              }),
            )
            .pipe(Effect.mapError(repositoryError))
        },
      ),
      releaseQueuedClaim: Effect.fn("TurnRepository.releaseQueuedClaim")(function* (claim) {
        yield* sql`UPDATE rika_turns SET queue_claim_token = NULL
          WHERE id = ${claim.turn.id} AND turn_kind = 'AgentExecution' AND status = 'queued' AND queue_claim_token = ${claim.token}`.pipe(
          Effect.asVoid,
          Effect.mapError(repositoryError),
        )
      }),
      resetQueueClaims:
        sql`UPDATE rika_turns SET queue_claim_token = NULL WHERE turn_kind = 'AgentExecution' AND queue_claim_token IS NOT NULL`.pipe(
          Effect.asVoid,
          Effect.mapError(repositoryError),
        ),
      editQueued: Effect.fn("TurnRepository.editQueued")(function* (id, prompt, now) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const rows =
                yield* sql`UPDATE rika_turns SET prompt = ${prompt}, prompt_parts_json = NULL, updated_at = ${now}, queue_claim_token = NULL WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status = 'queued' RETURNING *`
              if (rows[0] === undefined) return yield* RepositoryError.make({ message: `Turn ${id} is not queued` })
              const turn = yield* decodeAgent(rows[0])
              const queueRows = yield* sql`UPDATE rika_thread_queue_state
                SET revision = revision + 1
                WHERE thread_id = ${turn.threadId}
                RETURNING *`
              if (queueRows[0] === undefined)
                return yield* repositoryError(`Queue state ${turn.threadId} does not exist`)
              const state = yield* decodeQueueState(queueRows[0])
              return {
                ...turn,
                queue: {
                  threadId: turn.threadId,
                  revision: state.revision,
                  queuedCount: state.queued_count,
                  becameNonempty: false,
                  change: { _tag: "Updated" as const, turn },
                },
              }
            }),
          )
          .pipe(Effect.mapError(repositoryError))
      }),
      takeQueued: Effect.fn("TurnRepository.takeQueued")(function* (id) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const rows =
                yield* sql`DELETE FROM rika_turns WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status = 'queued' RETURNING *`
              if (rows[0] === undefined) return yield* queuedTurnUnavailable(id)
              const turn = yield* decodeAgent(rows[0])
              const queueRows = yield* sql`UPDATE rika_thread_queue_state
                SET revision = revision + 1, queued_count = MAX(queued_count - 1, 0)
                WHERE thread_id = ${turn.threadId}
                RETURNING *`
              if (queueRows[0] === undefined)
                return yield* repositoryError(`Queue state ${turn.threadId} does not exist`)
              const state = yield* decodeQueueState(queueRows[0])
              return {
                turn,
                queue: {
                  threadId: turn.threadId,
                  revision: state.revision,
                  queuedCount: state.queued_count,
                  becameNonempty: false,
                  change: { _tag: "Removed" as const, turnId: turn.id },
                },
              }
            }),
          )
          .pipe(Effect.mapError(takeQueuedError))
      }),
      dequeue: Effect.fn("TurnRepository.dequeue")(function* (id) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const rows =
                yield* sql`DELETE FROM rika_turns WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status = 'queued' RETURNING *`
              if (rows[0] === undefined) return yield* RepositoryError.make({ message: `Turn ${id} is not queued` })
              const turn = yield* decodeAgent(rows[0])
              const queueRows = yield* sql`UPDATE rika_thread_queue_state
                SET revision = revision + 1, queued_count = MAX(queued_count - 1, 0)
                WHERE thread_id = ${turn.threadId}
                RETURNING *`
              if (queueRows[0] === undefined)
                return yield* repositoryError(`Queue state ${turn.threadId} does not exist`)
              const state = yield* decodeQueueState(queueRows[0])
              return {
                threadId: turn.threadId,
                revision: state.revision,
                queuedCount: state.queued_count,
                becameNonempty: false,
                change: { _tag: "Removed" as const, turnId: turn.id },
              }
            }),
          )
          .pipe(Effect.mapError(repositoryError))
      }),
      requeueAccepted: Effect.fn("TurnRepository.requeueAccepted")(function* (id, queueCapacity, now) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const currentRows =
                yield* sql`SELECT * FROM rika_turns WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status = 'accepted'`
              if (currentRows[0] === undefined)
                return yield* RepositoryError.make({ message: `Turn ${id} is not an unowned accepted turn` })
              const current = yield* decodeAgent(currentRows[0])
              const otherActive = yield* sql`SELECT id FROM rika_turns
                WHERE thread_id = ${current.threadId} AND turn_kind = 'AgentExecution' AND id != ${id} AND status IN ('accepted', 'running', 'waiting') LIMIT 1`
              if (otherActive[0] !== undefined)
                return yield* RepositoryError.make({ message: `Turn ${id} is not an unowned accepted turn` })
              yield* sql`INSERT INTO rika_thread_queue_state (thread_id) VALUES (${current.threadId}) ON CONFLICT (thread_id) DO NOTHING`
              const queueRows = yield* sql`UPDATE rika_thread_queue_state
                SET revision = revision + 1, queued_count = queued_count + 1
                WHERE thread_id = ${current.threadId} AND queued_count < ${queueCapacity}
                RETURNING *`
              if (queueRows[0] === undefined) {
                const stateRows =
                  yield* sql`SELECT * FROM rika_thread_queue_state WHERE thread_id = ${current.threadId}`
                if (stateRows[0] === undefined)
                  return yield* repositoryError(`Queue state ${current.threadId} does not exist`)
                const state = yield* decodeQueueState(stateRows[0])
                return yield* QueueFull.make({
                  threadId: current.threadId,
                  capacity: queueCapacity,
                  count: state.queued_count,
                })
              }
              const updatedRows = yield* sql`UPDATE rika_turns SET status = 'queued', updated_at = ${now}
                WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status = 'accepted' RETURNING *`
              if (updatedRows[0] === undefined)
                return yield* RepositoryError.make({ message: `Turn ${id} is not an unowned accepted turn` })
              const turn = yield* decodeAgent(updatedRows[0])
              const state = yield* decodeQueueState(queueRows[0])
              return {
                ...turn,
                queue: {
                  threadId: turn.threadId,
                  revision: state.revision,
                  queuedCount: state.queued_count,
                  becameNonempty: state.queued_count === 1,
                  change: { _tag: "Added" as const, turn },
                },
              }
            }),
          )
          .pipe(Effect.mapError(submissionError))
      }),
      requestQueueWake: Effect.fn("TurnRepository.requestQueueWake")(function* (threadId) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO rika_thread_queue_state (thread_id) VALUES (${threadId}) ON CONFLICT (thread_id) DO NOTHING`
              const existingRows = yield* sql`SELECT * FROM rika_thread_queue_state WHERE thread_id = ${threadId}`
              if (existingRows[0] === undefined) return yield* repositoryError(`Queue state ${threadId} does not exist`)
              const existing = yield* decodeQueueState(existingRows[0])
              if (existing.queued_count === 0) return undefined
              if (existing.wake_pending === 1)
                return { threadId, generation: existing.wake_generation, queueRevision: existing.revision }
              const rows = yield* sql`UPDATE rika_thread_queue_state
                SET wake_generation = wake_generation + 1, wake_pending = 1
                WHERE thread_id = ${threadId} AND queued_count > 0 AND wake_pending = 0
                RETURNING *`
              if (rows[0] === undefined) return undefined
              const state = yield* decodeQueueState(rows[0])
              return { threadId, generation: state.wake_generation, queueRevision: state.revision }
            }),
          )
          .pipe(Effect.mapError(repositoryError))
      }),
      consumeQueueWake: Effect.fn("TurnRepository.consumeQueueWake")(function* (threadId, generation) {
        const rows = yield* sql`UPDATE rika_thread_queue_state SET wake_pending = 0
          WHERE thread_id = ${threadId} AND wake_pending = 1 AND wake_generation = ${generation}
          RETURNING thread_id`.pipe(Effect.mapError(repositoryError))
        return rows[0] !== undefined
      }),
      setExtensionPin: Effect.fn("TurnRepository.setExtensionPin")(function* (id, pin) {
        const encoded = yield* Schema.encodeEffect(ExtensionPinJson)(pin).pipe(Effect.mapError(repositoryError))
        const rows = yield* sql`UPDATE rika_turns SET extension_pin_json = ${encoded}
          WHERE id = ${id} AND turn_kind = 'AgentExecution'
            AND (extension_pin_json IS NULL OR extension_pin_json = ${encoded}) RETURNING *`.pipe(
          Effect.mapError(repositoryError),
        )
        if (rows[0] === undefined)
          return yield* RepositoryError.make({
            message: `Turn ${id} extension pin is immutable or turn does not exist`,
          })
        return yield* decodeAgent(rows[0])
      }),
      setStatus: Effect.fn("TurnRepository.setStatus")(function* (id, status, lastCursor, now) {
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
              const rows =
                yield* sql`UPDATE rika_turns SET status = ${status}, last_cursor = ${lastCursor ?? null}, updated_at = ${now}
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
      cancelAccepted: Effect.fn("TurnRepository.cancelAccepted")(function* (id, now) {
        const rows = yield* sql`UPDATE rika_turns SET status = 'cancelled', updated_at = ${now}
          WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status = 'accepted'
          RETURNING id`.pipe(Effect.mapError(repositoryError))
        return rows[0] !== undefined
      }),
      repairCursor: Effect.fn("TurnRepository.repairCursor")(function* (id, status, expectedCursor, cursor) {
        const rows = yield* sql`UPDATE rika_turns SET last_cursor = ${cursor ?? null}
          WHERE id = ${id}
            AND turn_kind = 'AgentExecution'
            AND status = ${status}
            AND (last_cursor = ${expectedCursor ?? null} OR (last_cursor IS NULL AND ${expectedCursor ?? null} IS NULL))
          RETURNING id`.pipe(Effect.mapError(repositoryError))
        return rows[0] !== undefined
      }),
    })
  }),
)

export { makeMemory, memoryLayer, memoryCoordinator } from "./memory-turn-repository"
export type { MemoryRefoldWrite } from "./turn-memory-support"

export { decodeStoredTurn } from "./turn-row-codec"
