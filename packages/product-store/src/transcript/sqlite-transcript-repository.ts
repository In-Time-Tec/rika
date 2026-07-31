import { Service } from "@rika/product/transcript-repository"
export { Service }
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { Turn, TurnId, isAgentExecution, isRecordedShell } from "@rika/product/turn-record"
import type { RunningRecordedShellTurn, TerminalRecordedShellTurn } from "@rika/product/turn-record"
import {
  EntrySchema,
  PageCursor,
  type Entry,
  ExecutionAttachment,
  ExecutionCheckpoint,
  invalidatedProjectionVersion,
} from "@rika/product/transcript-repository"
import type {
  Projection,
  CheckpointOptions,
  DeltaCheckpointOptions,
  UnitDelta,
  RefoldOptions,
  PageOptions,
  Page,
  ProjectionRecoveryCandidate,
  WriteResult,
  RefoldWriteResult,
  RecordedShellWriteResult,
  Interface,
} from "@rika/product/transcript-repository"
import { RepositoryError } from "@rika/product/transcript-repository"
import { support } from "./transcript-repository-support"
import { decodeTranscriptExecutionCheckpoint } from "./transcript-checkpoint-codec"
import { decodeStoredTurn } from "../turn/turn-row-codec"
import { TranscriptUnitRow } from "./transcript-unit-row-codec"
import { readTranscriptProjection } from "./transcript-sqlite-reader"
const {
  error,
  refoldStale,
  isRefoldStale,
  refoldTurn,
  pageSize,
  cursorFor,
  recordedShellProjection,
  validateRecordedShellProjection,
  validateUnits,
  validateCurrentProjectionVersion,
  validateCheckpoint,
  validateAttachmentSet,
  validatePageOptions,
  validateDelta,
  UnitJson,
  UsageCursorsJson,
} = support
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const loadExecutionCheckpoints = Effect.fn("TranscriptRepository.loadExecutionCheckpoints")(function* (
      turnId: TurnId,
    ) {
      const rows = yield* sql`
        SELECT execution_key, execution_id, cursor, sequence, status, revision, model_phase, usable_completion_sequence,
          oldest_cursor, checkpoint_cursor, cost_usd, usage_cursors_json, pricing_version,
          parent_execution_key, parent_unit_key, parent_id, parent_order_key, is_root
        FROM rika_transcript_execution_checkpoints
        WHERE turn_id = ${turnId}
        ORDER BY execution_key COLLATE BINARY
      `.pipe(Effect.mapError(error))
      return yield* Effect.all(
        rows.map((value) => decodeTranscriptExecutionCheckpoint(value).pipe(Effect.mapError(error))),
      )
    })
    const get = Effect.fn("TranscriptRepository.get")((turnId: TurnId) =>
      readTranscriptProjection(sql, turnId, loadExecutionCheckpoints),
    )
    const listProjectionRecoveryCandidates = Effect.fn("TranscriptRepository.listProjectionRecoveryCandidates")(
      function* (projectionVersion: number) {
        yield* validateCurrentProjectionVersion(projectionVersion)
        const rows = yield* sql`
        SELECT t.thread_id, t.id AS turn_id
        FROM rika_turns t
        LEFT JOIN rika_transcript_checkpoints c ON c.turn_id = t.id
        WHERE t.turn_kind = 'AgentExecution'
          AND t.status <> 'queued'
          AND (
            c.turn_id IS NULL
            OR c.projection_version < ${projectionVersion}
            OR EXISTS (
              SELECT 1
              FROM rika_transcript_execution_checkpoints e
              WHERE e.turn_id = t.id AND e.status IS NULL
            )
          )
        ORDER BY t.created_at ASC, t.rowid ASC
      `.pipe(Effect.mapError(error))
        return yield* Effect.all(
          rows.map((row) =>
            Schema.decodeUnknownEffect(support.ProjectionRecoveryCandidateRow)(row).pipe(
              Effect.map((candidate) => ({ threadId: candidate.thread_id, turnId: candidate.turn_id })),
              Effect.mapError(error),
            ),
          ),
        )
      },
    )
    const storeUnit = Effect.fn("TranscriptRepository.storeUnit")(function* (turn: Turn, unit: TranscriptUnit.Unit) {
      if (!TranscriptOrdering.hasIntrinsicOrder(unit))
        return yield* RepositoryError.make({ message: `Transcript unit ${unit.key} has a non-intrinsic order` })
      const encoded = yield* Schema.encodeEffect(UnitJson)(unit)
      const orderKey = TranscriptOrdering.encodeUnitOrder(unit.order)
      const executionKey = isRecordedShell(turn) ? null : TranscriptCorrelation.executionKey(unit.turnId)
      const rows =
        yield* sql`INSERT INTO rika_transcript_units (turn_id, unit_key, execution_key, thread_id, unit_order_key, tool_id, parent_id, revision, unit_json, created_at, updated_at)
          VALUES (${turn.id}, ${unit.key}, ${executionKey}, ${turn.threadId}, ${orderKey}, ${unit.content._tag === "Block" && unit.content.block._tag === "ToolCall" ? unit.content.block.id : null}, ${unit.parentId ?? null}, ${unit.revision}, ${encoded}, ${turn.createdAt}, ${turn.updatedAt})
          ON CONFLICT(turn_id, unit_key) DO UPDATE SET thread_id = excluded.thread_id,
            unit_order_key = excluded.unit_order_key, revision = excluded.revision, unit_json = excluded.unit_json,
            created_at = excluded.created_at, updated_at = excluded.updated_at
          WHERE rika_transcript_units.unit_order_key = excluded.unit_order_key
            AND rika_transcript_units.execution_key IS excluded.execution_key
            AND rika_transcript_units.tool_id IS excluded.tool_id
            AND rika_transcript_units.parent_id IS excluded.parent_id
          RETURNING unit_key`
      if (rows.length === 0)
        return yield* RepositoryError.make({ message: `Transcript unit ${unit.key} changed its intrinsic identity` })
    }, Effect.mapError(error))
    const checkpointValues = Effect.fn("TranscriptRepository.checkpointValues")(function* (
      state: TranscriptProjectionModel.ProjectionState,
    ) {
      const usageCursors =
        state.usageCursors === undefined ? null : yield* Schema.encodeEffect(UsageCursorsJson)(state.usageCursors)
      return { usageCursors }
    })
    const storeExecutionCheckpoint = Effect.fn("TranscriptRepository.storeExecutionCheckpoint")(function* (
      turn: Turn,
      checkpoint: ExecutionCheckpoint,
    ) {
      const values = yield* checkpointValues(checkpoint.state)
      const attachment = checkpoint.attachment
      const rows = yield* sql`INSERT INTO rika_transcript_execution_checkpoints (
          turn_id, execution_key, execution_id, cursor, sequence, status, revision, model_phase, usable_completion_sequence,
          oldest_cursor, checkpoint_cursor, cost_usd, usage_cursors_json, pricing_version,
          parent_execution_key, parent_unit_key, parent_id, parent_order_key, is_root
        ) VALUES (
          ${turn.id}, ${checkpoint.executionKey}, ${checkpoint.executionId}, ${checkpoint.cursor}, ${checkpoint.sequence},
          ${checkpoint.status ?? null}, ${checkpoint.state.revision}, ${checkpoint.state.modelPhase},
          ${checkpoint.state.usableCompletionSequence ?? null},
          ${checkpoint.state.oldestCursor ?? null}, ${checkpoint.state.checkpointCursor ?? null},
          ${checkpoint.state.costUsd ?? null}, ${values.usageCursors}, ${checkpoint.state.pricingVersion ?? null},
          ${attachment?.parentExecutionKey ?? null}, ${attachment?.parentUnitKey ?? null},
          ${attachment?.parentId ?? null}, ${attachment?.parentOrderKey ?? null},
          ${attachment === undefined ? 1 : 0}
        ) ON CONFLICT(turn_id, execution_key) DO UPDATE SET
          cursor = excluded.cursor, sequence = excluded.sequence, status = excluded.status,
          revision = excluded.revision, model_phase = excluded.model_phase,
          usable_completion_sequence = excluded.usable_completion_sequence,
          oldest_cursor = excluded.oldest_cursor, checkpoint_cursor = excluded.checkpoint_cursor,
          cost_usd = excluded.cost_usd, usage_cursors_json = excluded.usage_cursors_json,
          pricing_version = excluded.pricing_version
        WHERE rika_transcript_execution_checkpoints.execution_id = excluded.execution_id
          AND rika_transcript_execution_checkpoints.is_root = excluded.is_root
          AND rika_transcript_execution_checkpoints.parent_execution_key IS excluded.parent_execution_key
          AND rika_transcript_execution_checkpoints.parent_unit_key IS excluded.parent_unit_key
          AND rika_transcript_execution_checkpoints.parent_id IS excluded.parent_id
          AND rika_transcript_execution_checkpoints.parent_order_key IS excluded.parent_order_key
        RETURNING execution_key`
      if (rows.length === 0)
        return yield* RepositoryError.make({
          message: `Execution checkpoint ${checkpoint.executionKey} changed its intrinsic identity`,
        })
    })
    const commitCheckpoint = Effect.fn("TranscriptRepository.commitCheckpoint")(function* (
      turn: Turn,
      state: TranscriptProjectionModel.ProjectionState,
      options: DeltaCheckpointOptions,
    ) {
      const values = yield* checkpointValues(state)
      const rows =
        options.expectedGeneration === undefined
          ? yield* sql`INSERT INTO rika_transcript_checkpoints (
              turn_id, thread_id, checkpoint_generation, model_phase, revision, usable_completion_sequence,
              oldest_cursor, checkpoint_cursor, cost_usd, usage_cursors_json, pricing_version, projection_version, updated_at
            ) VALUES (
              ${turn.id}, ${turn.threadId}, 0, ${state.modelPhase}, ${state.revision},
              ${state.usableCompletionSequence ?? null},
              ${state.oldestCursor ?? null}, ${state.checkpointCursor ?? null}, ${state.costUsd ?? null},
              ${values.usageCursors}, ${state.pricingVersion ?? null}, ${options.projectionVersion}, ${turn.updatedAt}
            ) ON CONFLICT(turn_id) DO NOTHING
            RETURNING turn_id`.pipe(Effect.mapError(error))
          : yield* sql`UPDATE rika_transcript_checkpoints SET
              thread_id = ${turn.threadId}, checkpoint_generation = checkpoint_generation + 1,
              model_phase = ${state.modelPhase}, revision = ${state.revision},
              usable_completion_sequence = ${state.usableCompletionSequence ?? null},
              oldest_cursor = ${state.oldestCursor ?? null}, checkpoint_cursor = ${state.checkpointCursor ?? null},
              cost_usd = ${state.costUsd ?? null}, usage_cursors_json = ${values.usageCursors},
              pricing_version = ${state.pricingVersion ?? null}, updated_at = ${turn.updatedAt}
            WHERE turn_id = ${turn.id} AND projection_version = ${options.projectionVersion}
              AND checkpoint_generation = ${options.expectedGeneration} AND revision <= ${state.revision}
            RETURNING turn_id`.pipe(Effect.mapError(error))
      return rows.length > 0
    })
    const replaceCheckpointForRefold = Effect.fn("TranscriptRepository.replaceCheckpointForRefold")(function* (
      turn: Turn,
      state: TranscriptProjectionModel.ProjectionState,
      options: RefoldOptions,
    ) {
      const values = yield* checkpointValues(state)
      const rows = yield* sql`UPDATE rika_transcript_checkpoints SET
          thread_id = ${turn.threadId}, checkpoint_generation = checkpoint_generation + 1,
          model_phase = ${state.modelPhase}, revision = ${state.revision},
          usable_completion_sequence = ${state.usableCompletionSequence ?? null},
          oldest_cursor = ${state.oldestCursor ?? null}, checkpoint_cursor = ${state.checkpointCursor ?? null},
          cost_usd = ${state.costUsd ?? null}, usage_cursors_json = ${values.usageCursors},
          pricing_version = ${state.pricingVersion ?? null}, projection_version = ${options.projectionVersion},
          updated_at = ${turn.updatedAt}
        WHERE turn_id = ${turn.id} AND projection_version = ${options.expectedProjectionVersion}
          AND checkpoint_generation = ${options.expectedGeneration}
          AND projection_version < ${options.projectionVersion}
        RETURNING turn_id`.pipe(Effect.mapError(error))
      return rows.length > 0
    })
    const loadAttachmentUnits = Effect.fn("TranscriptRepository.loadAttachmentUnits")(function* (
      turn: Turn,
      delta: UnitDelta,
      checkpoints: ReadonlyArray<ExecutionCheckpoint>,
    ) {
      const upsertKeys = new Set(delta.upsert.map((unit) => unit.key))
      const missingParentKeys = [
        ...new Set(
          checkpoints.flatMap((checkpoint) => {
            const attachment = checkpoint.attachment
            if (attachment === undefined || upsertKeys.has(attachment.parentUnitKey)) return []
            return [attachment.parentUnitKey]
          }),
        ),
      ]
      if (missingParentKeys.length === 0) return delta.upsert
      const loaded = yield* Effect.all(
        missingParentKeys.map((key) =>
          Effect.gen(function* () {
            const rows = yield* sql`SELECT unit_json FROM rika_transcript_units
              WHERE turn_id = ${turn.id} AND unit_key = ${key}`
            if (rows.length !== 1)
              return yield* RepositoryError.make({
                message: `Transcript ${turn.id} has no attachment unit for ${key}`,
              })
            const parentJson = yield* Schema.decodeUnknownEffect(Schema.Struct({ unit_json: Schema.String }))(rows[0])
            return yield* Schema.decodeUnknownEffect(UnitJson)(parentJson.unit_json)
          }).pipe(Effect.mapError(error)),
        ),
      )
      return [...delta.upsert, ...loaded]
    })
    const validateDurableUnitRemoval = Effect.fn("TranscriptRepository.validateDurableUnitRemoval")(function* (
      turn: Turn,
      key: string,
    ) {
      const rows = yield* sql`SELECT execution_key FROM rika_transcript_execution_checkpoints
        WHERE turn_id = ${turn.id} AND parent_unit_key = ${key}
        LIMIT 1`
      if (rows.length > 0)
        return yield* RepositoryError.make({ message: `Transcript unit ${key} has an attached execution` })
    })
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
            const committed = yield* commitCheckpoint(
              turn,
              TranscriptProjection.Projection.projectionState(projection),
              {
                executionCheckpoints: [],
                projectionVersion,
                expectedGeneration: undefined,
              },
            )
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
    return Service.of({
      get,
      listProjectionRecoveryCandidates,
      commitDelta: Effect.fn("TranscriptRepository.commitDelta")(function* (turn, state, delta, options) {
        yield* validateDelta(delta)
        yield* validateCheckpoint(turn, state, options)
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (!(yield* commitCheckpoint(turn, state, options))) return "stale" as const
              const checkpoints = new Map(
                (yield* loadExecutionCheckpoints(turn.id)).map((checkpoint) => [checkpoint.executionKey, checkpoint]),
              )
              for (const checkpoint of options.executionCheckpoints)
                checkpoints.set(checkpoint.executionKey, checkpoint)
              const merged = [...checkpoints.values()]
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
                  const turn = yield* decodeStoredTurn(value).pipe(Effect.mapError(error))
                  const toolId =
                    unit.content._tag === "Block" && unit.content.block._tag === "ToolCall"
                      ? unit.content.block.id
                      : null
                  if (
                    unit.key !== row.unit_key ||
                    (isRecordedShell(turn) ? null : TranscriptCorrelation.executionKey(unit.turnId)) !==
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
                  if (isRecordedShell(turn)) {
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
        const total = yield* Schema.decodeUnknownEffect(Schema.Struct({ thread_cost_usd: Schema.Finite }))(
          totals[0],
        ).pipe(Effect.mapError(error))
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
  }),
)
export { makeMemory, memoryLayer, memoryLayerWithTurns } from "./memory-transcript-repository"
export {
  EntrySchema,
  PageCursor,
  ExecutionAttachment,
  ExecutionCheckpoint,
  invalidatedProjectionVersion,
  RepositoryError,
} from "@rika/product/transcript-repository"
export type {
  Entry,
  Projection,
  CheckpointOptions,
  DeltaCheckpointOptions,
  UnitDelta,
  RefoldOptions,
  PageOptions,
  Page,
  ProjectionRecoveryCandidate,
  WriteResult,
  RefoldWriteResult,
  RecordedShellWriteResult,
  Interface,
} from "@rika/product/transcript-repository"
