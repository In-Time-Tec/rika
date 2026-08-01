import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { QueueFull } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
import {
  decodeAgent,
  decodeQueueState,
  ExtensionPinJson,
  PromptPartsJson,
  ExecutionRouteJson,
  AuthorJson,
  LineageJson,
} from "./turn-row-codec"
import { missing, repositoryError, submissionError } from "./turn-memory-support"

export const makeTurnSqliteSubmission = (sql: SqlClient): Pick<Interface, "createForSubmission" | "copy"> => ({
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
            if (stateRows[0] === undefined) return yield* repositoryError(`Queue state ${turn.threadId} does not exist`)
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
})
