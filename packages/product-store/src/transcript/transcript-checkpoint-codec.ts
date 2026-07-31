import { Effect, Schema } from "effect"
import { RepositoryError } from "@rika/product/transcript-repository"
import type { ExecutionCheckpoint } from "@rika/product/transcript-repository"

export const TranscriptCheckpointRow = Schema.Struct({
  model_phase: Schema.Finite,
  checkpoint_generation: Schema.Finite,
  revision: Schema.Finite,
  usable_completion_sequence: Schema.NullOr(Schema.Finite),
  oldest_cursor: Schema.NullOr(Schema.String),
  checkpoint_cursor: Schema.NullOr(Schema.String),
  cost_usd: Schema.NullOr(Schema.Finite),
  usage_cursors_json: Schema.NullOr(Schema.String),
  pricing_version: Schema.NullOr(Schema.String),
  projection_version: Schema.Finite,
})

export const TranscriptExecutionCheckpointRow = Schema.Struct({
  execution_key: Schema.String,
  execution_id: Schema.String,
  cursor: Schema.String,
  sequence: Schema.Finite,
  status: Schema.NullOr(Schema.String),
  revision: Schema.Finite,
  model_phase: Schema.Finite,
  usable_completion_sequence: Schema.NullOr(Schema.Finite),
  oldest_cursor: Schema.NullOr(Schema.String),
  checkpoint_cursor: Schema.NullOr(Schema.String),
  cost_usd: Schema.NullOr(Schema.Finite),
  usage_cursors_json: Schema.NullOr(Schema.String),
  pricing_version: Schema.NullOr(Schema.String),
  parent_execution_key: Schema.NullOr(Schema.String),
  parent_unit_key: Schema.NullOr(Schema.String),
  parent_id: Schema.NullOr(Schema.String),
  parent_order_key: Schema.NullOr(Schema.String),
})

const UsageCursorsJson = Schema.fromJsonString(Schema.Array(Schema.String))
const decodeError = (cause: unknown) =>
  Schema.is(RepositoryError)(cause) ? cause : RepositoryError.make({ message: String(cause) })

export const decodeTranscriptExecutionCheckpoint = (value: unknown) =>
  Effect.gen(function* () {
    const row = yield* Schema.decodeUnknownEffect(TranscriptExecutionCheckpointRow)(value)
    const status =
      row.status === null
        ? undefined
        : yield* Schema.decodeUnknownEffect(Schema.Literals(["completed", "failed", "cancelled"]))(row.status)
    const usageCursors =
      row.usage_cursors_json === null
        ? undefined
        : yield* Schema.decodeUnknownEffect(UsageCursorsJson)(row.usage_cursors_json)
    const parentValues = [row.parent_execution_key, row.parent_unit_key, row.parent_id, row.parent_order_key]
    const hasParent = parentValues.every((candidate) => candidate !== null)
    if (!hasParent && parentValues.some((candidate) => candidate !== null))
      return yield* RepositoryError.make({ message: `Execution ${row.execution_key} has a partial attachment` })
    return {
      executionKey: row.execution_key,
      executionId: row.execution_id,
      cursor: row.cursor,
      sequence: row.sequence,
      ...(status === undefined ? {} : { status }),
      state: {
        revision: row.revision,
        modelPhase: row.model_phase,
        ...(row.usable_completion_sequence === null
          ? {}
          : { usableCompletionSequence: row.usable_completion_sequence }),
        ...(row.oldest_cursor === null ? {} : { oldestCursor: row.oldest_cursor }),
        ...(row.checkpoint_cursor === null ? {} : { checkpointCursor: row.checkpoint_cursor }),
        ...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
        ...(usageCursors === undefined ? {} : { usageCursors }),
        ...(row.pricing_version === null ? {} : { pricingVersion: row.pricing_version }),
      },
      ...(hasParent
        ? {
            attachment: {
              parentExecutionKey: row.parent_execution_key!,
              parentUnitKey: row.parent_unit_key!,
              parentId: row.parent_id!,
              parentOrderKey: row.parent_order_key!,
            },
          }
        : {}),
    } satisfies ExecutionCheckpoint
  }).pipe(Effect.mapError(decodeError))
