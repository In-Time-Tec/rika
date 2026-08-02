import type { Entry } from "@rika/product/transcript-page"
import { TurnResult } from "@rika/product/thread-result"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { TurnId } from "@rika/product/turn-record"
import type { Interface } from "@rika/product/transcript-repository"
import { RepositoryError } from "@rika/product/transcript-repository"
import { decode } from "../turn/turn-row-codec"
import { TranscriptUnitRow } from "./transcript-unit-row-codec"
import { support } from "./transcript-repository-support"

const { error, pageSize, cursorFor, validateRecordedShellProjection, UnitJson, validatePageOptions } = support

export const makeTranscriptSqlitePage = (sql: SqlClient): Pick<Interface, "page" | "globalCostUsd"> => ({
  page: Effect.fn("TranscriptRepository.page")(function* (threadId, options = {}) {
    yield* validatePageOptions(options)
    const limit = pageSize(options.limit)
    let rows
    if (options.before === undefined && options.after === undefined) {
      rows = yield* sql`SELECT u.unit_key, u.execution_key, u.unit_json, u.unit_order_key, u.turn_id,
            u.parent_id AS durable_parent_id, u.tool_id AS durable_tool_id,
            e.execution_id AS checkpoint_execution_id,
            e.is_root AS checkpoint_is_root,
            e.parent_execution_key AS attachment_parent_execution_key,
            e.parent_unit_key AS attachment_parent_unit_key, e.parent_id AS attachment_parent_id,
            e.parent_order_key AS attachment_parent_order_key,
            p.unit_key AS attachment_unit_key, p.execution_key AS attachment_unit_execution_key,
            p.unit_order_key AS attachment_unit_order_key, p.tool_id AS attachment_unit_tool_id,
            p.unit_json AS attachment_unit_json,
            c.revision AS projection_revision, c.model_phase, c.cost_usd, c.projection_version,
            t.*
          FROM rika_transcript_units u
          JOIN rika_transcript_checkpoints c ON c.turn_id = u.turn_id
          JOIN rika_turns t ON t.id = u.turn_id
          LEFT JOIN rika_transcript_execution_checkpoints e
            ON e.turn_id = u.turn_id AND e.execution_key = u.execution_key
          LEFT JOIN rika_transcript_units p
            ON p.turn_id = e.turn_id AND p.unit_key = e.parent_unit_key
          WHERE u.thread_id = ${threadId} AND t.status <> 'queued'
            AND (${options.projectionVersion ?? null} IS NULL OR c.projection_version = ${options.projectionVersion ?? null})
          ORDER BY u.created_at DESC, u.turn_id DESC, u.unit_order_key DESC
          LIMIT ${limit + 1}`.pipe(Effect.mapError(error))
    } else if (options.before !== undefined) {
      rows = yield* sql`SELECT u.unit_key, u.execution_key, u.unit_json, u.unit_order_key, u.turn_id,
            u.parent_id AS durable_parent_id, u.tool_id AS durable_tool_id,
            e.execution_id AS checkpoint_execution_id,
            e.is_root AS checkpoint_is_root,
            e.parent_execution_key AS attachment_parent_execution_key,
            e.parent_unit_key AS attachment_parent_unit_key, e.parent_id AS attachment_parent_id,
            e.parent_order_key AS attachment_parent_order_key,
            p.unit_key AS attachment_unit_key, p.execution_key AS attachment_unit_execution_key,
            p.unit_order_key AS attachment_unit_order_key, p.tool_id AS attachment_unit_tool_id,
            p.unit_json AS attachment_unit_json,
            c.revision AS projection_revision, c.model_phase, c.cost_usd, c.projection_version,
            t.*
          FROM rika_transcript_units u
          JOIN rika_transcript_checkpoints c ON c.turn_id = u.turn_id
          JOIN rika_turns t ON t.id = u.turn_id
          LEFT JOIN rika_transcript_execution_checkpoints e
            ON e.turn_id = u.turn_id AND e.execution_key = u.execution_key
          LEFT JOIN rika_transcript_units p
            ON p.turn_id = e.turn_id AND p.unit_key = e.parent_unit_key
          WHERE u.thread_id = ${threadId} AND t.status <> 'queued'
            AND (${options.projectionVersion ?? null} IS NULL OR c.projection_version = ${options.projectionVersion ?? null}) AND
            (u.created_at, u.turn_id, u.unit_order_key) <
            (${options.before.createdAt}, ${options.before.turnId}, ${options.before.orderKey})
          ORDER BY u.created_at DESC, u.turn_id DESC, u.unit_order_key DESC
          LIMIT ${limit + 1}`.pipe(Effect.mapError(error))
    } else {
      rows = yield* sql`SELECT u.unit_key, u.execution_key, u.unit_json, u.unit_order_key, u.turn_id,
            u.parent_id AS durable_parent_id, u.tool_id AS durable_tool_id,
            e.execution_id AS checkpoint_execution_id,
            e.is_root AS checkpoint_is_root,
            e.parent_execution_key AS attachment_parent_execution_key,
            e.parent_unit_key AS attachment_parent_unit_key, e.parent_id AS attachment_parent_id,
            e.parent_order_key AS attachment_parent_order_key,
            p.unit_key AS attachment_unit_key, p.execution_key AS attachment_unit_execution_key,
            p.unit_order_key AS attachment_unit_order_key, p.tool_id AS attachment_unit_tool_id,
            p.unit_json AS attachment_unit_json,
            c.revision AS projection_revision, c.model_phase, c.cost_usd, c.projection_version,
            t.*
          FROM rika_transcript_units u
          JOIN rika_transcript_checkpoints c ON c.turn_id = u.turn_id
          JOIN rika_turns t ON t.id = u.turn_id
          LEFT JOIN rika_transcript_execution_checkpoints e
            ON e.turn_id = u.turn_id AND e.execution_key = u.execution_key
          LEFT JOIN rika_transcript_units p
            ON p.turn_id = e.turn_id AND p.unit_key = e.parent_unit_key
          WHERE u.thread_id = ${threadId} AND t.status <> 'queued'
            AND (${options.projectionVersion ?? null} IS NULL OR c.projection_version = ${options.projectionVersion ?? null}) AND
            (u.created_at, u.turn_id, u.unit_order_key) >
            (${options.after!.createdAt}, ${options.after!.turnId}, ${options.after!.orderKey})
          ORDER BY u.created_at ASC, u.turn_id ASC, u.unit_order_key ASC
          LIMIT ${limit + 1}`.pipe(Effect.mapError(error))
    }
    const entries = yield* Effect.all(
      rows.slice(0, limit).map((value) =>
        Schema.decodeUnknownEffect(TranscriptUnitRow)(value).pipe(
          Effect.flatMap((row) =>
            Effect.gen(function* () {
              const unit = yield* Schema.decodeUnknownEffect(UnitJson)(row.unit_json)
              const turnId = yield* Schema.decodeUnknownEffect(TurnId)(row.turn_id)
              const turn = yield* decode(value).pipe(Effect.mapError(error))
              const toolId =
                unit.content._tag === "Block" && unit.content.block._tag === "ToolCall" ? unit.content.block.id : null
              if (
                unit.key !== row.unit_key ||
                (TurnResult.isRecordedShell(turn) ? null : TranscriptCorrelation.executionKey(unit.turnId)) !==
                  row.execution_key ||
                !TranscriptOrdering.hasIntrinsicOrder(unit) ||
                TranscriptOrdering.encodeUnitOrder(unit.order) !== row.unit_order_key ||
                (unit.parentId ?? null) !== row.durable_parent_id ||
                toolId !== row.durable_tool_id ||
                turn.id !== turnId
              )
                return yield* RepositoryError.make({
                  message: "Transcript unit order does not match its durable key",
                })
              if (TurnResult.isRecordedShell(turn)) {
                if (
                  row.execution_key !== null ||
                  unit.parentId !== undefined ||
                  row.checkpoint_execution_id !== null ||
                  row.checkpoint_is_root !== null ||
                  row.attachment_parent_execution_key !== null ||
                  row.attachment_parent_unit_key !== null ||
                  row.attachment_parent_id !== null ||
                  row.attachment_parent_order_key !== null ||
                  row.attachment_unit_key !== null
                )
                  return yield* RepositoryError.make({
                    message: "Recorded shell unit has an execution attachment",
                  })
                yield* validateRecordedShellProjection(
                  turn,
                  {
                    units: [unit],
                    revision: row.projection_revision,
                    modelPhase: row.model_phase,
                    ...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
                  },
                  row.projection_version,
                )
              } else {
                if (
                  row.checkpoint_execution_id === null ||
                  TranscriptCorrelation.executionKey(row.checkpoint_execution_id) !== row.execution_key
                )
                  return yield* RepositoryError.make({ message: "Transcript unit has no execution checkpoint" })
                if (row.checkpoint_is_root === 1) {
                  if (
                    row.execution_key !== TranscriptCorrelation.executionKey(String(turnId)) ||
                    unit.parentId !== undefined ||
                    row.attachment_parent_execution_key !== null ||
                    row.attachment_parent_unit_key !== null ||
                    row.attachment_parent_id !== null ||
                    row.attachment_parent_order_key !== null ||
                    row.attachment_unit_key !== null
                  )
                    return yield* RepositoryError.make({
                      message: "Transcript root unit has contradictory durable attachment",
                    })
                } else {
                  if (
                    row.checkpoint_is_root !== 0 ||
                    row.attachment_parent_execution_key === null ||
                    row.attachment_parent_unit_key === null ||
                    row.attachment_parent_id === null ||
                    row.attachment_parent_order_key === null ||
                    row.attachment_unit_key !== row.attachment_parent_unit_key ||
                    row.attachment_unit_execution_key !== row.attachment_parent_execution_key ||
                    row.attachment_unit_order_key !== row.attachment_parent_order_key ||
                    row.attachment_unit_tool_id !== row.attachment_parent_id ||
                    row.attachment_unit_json === null ||
                    unit.parentId !== row.attachment_parent_id
                  )
                    return yield* RepositoryError.make({
                      message: "Transcript child unit has contradictory durable attachment",
                    })
                  const parent = yield* Schema.decodeUnknownEffect(UnitJson)(row.attachment_unit_json)
                  if (
                    parent.key !== row.attachment_parent_unit_key ||
                    TranscriptCorrelation.executionKey(parent.turnId) !== row.attachment_parent_execution_key ||
                    TranscriptOrdering.encodeUnitOrder(parent.order) !== row.attachment_parent_order_key ||
                    parent.content._tag !== "Block" ||
                    parent.content.block._tag !== "ToolCall" ||
                    parent.content.block.id !== row.attachment_parent_id ||
                    TranscriptOrdering.encodeUnitOrder(unit.order) !==
                      TranscriptOrdering.encodeUnitOrder(
                        TranscriptOrdering.childOrder(
                          parent.order,
                          row.checkpoint_execution_id,
                          TranscriptOrdering.localOrder(unit.order),
                        ),
                      )
                  )
                    return yield* RepositoryError.make({
                      message: "Transcript child unit path contradicts its durable attachment",
                    })
                }
              }
              return {
                turn,
                unit,
                projectionRevision: row.projection_revision,
                projectionModelPhase: row.model_phase,
                ...(row.cost_usd === null ? {} : { projectionCostUsd: row.cost_usd }),
              } satisfies Entry
            }),
          ),
          Effect.mapError(error),
        ),
      ),
    )
    const chronological = options.after === undefined ? entries.toReversed() : entries
    const totals = yield* sql`SELECT COALESCE(SUM(cost_usd), 0) AS thread_cost_usd
    FROM rika_transcript_checkpoints
    WHERE thread_id = ${threadId}`.pipe(Effect.mapError(error))
    const total = yield* Schema.decodeUnknownEffect(Schema.Struct({ thread_cost_usd: Schema.Finite }))(totals[0]).pipe(
      Effect.mapError(error),
    )
    return {
      entries: chronological,
      hasOlder: options.after === undefined && rows.length > limit,
      hasNewer: options.after !== undefined && rows.length > limit,
      oldestCursor: cursorFor(chronological[0]),
      newestCursor: cursorFor(chronological.at(-1)),
      threadCostUsd: total.thread_cost_usd,
    }
  }),
  globalCostUsd: Effect.gen(function* () {
    const totals = yield* sql`SELECT COALESCE(SUM(cost_usd), 0) AS global_cost_usd
    FROM rika_transcript_checkpoints`
    const total = yield* Schema.decodeUnknownEffect(Schema.Struct({ global_cost_usd: Schema.Finite }))(totals[0])
    return total.global_cost_usd
  }).pipe(Effect.mapError(error)),
})
