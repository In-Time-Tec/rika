import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptNestedProjection from "@rika/transcript/nested-transcript-projection"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptUsage from "@rika/transcript/model-usage-fallback"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import {
  attachedExecutionCheckpoint,
  commitAll,
  event,
  executionCheckpoint,
  invalidCheckpointGraphs,
  nestedProjection,
  projectionVersion,
  turn,
  unit,
} from "./transcript-repository-fixtures"

export const compareExecutionCheckpoints = (
  left: TranscriptRepository.ExecutionCheckpoint,
  right: TranscriptRepository.ExecutionCheckpoint,
): number => {
  if (left.executionKey < right.executionKey) return -1
  if (left.executionKey > right.executionKey) return 1
  return 0
}

export { expect, it }
export { Effect }
export {
  TranscriptCorrelation,
  TranscriptNestedProjection,
  TranscriptOrdering,
  TranscriptProjection,
  TranscriptProjectionModel,
  TranscriptUsage,
  Thread,
  TranscriptRepository,
  TurnRepository,
  Turn,
}
export {
  attachedExecutionCheckpoint,
  commitAll,
  event,
  executionCheckpoint,
  invalidCheckpointGraphs,
  nestedProjection,
  projectionVersion,
  turn,
  unit,
}
