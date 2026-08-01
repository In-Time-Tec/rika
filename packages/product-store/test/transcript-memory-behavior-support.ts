import * as TranscriptPage from "@rika/product/transcript-page"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { commitAll } from "./transcript-fixture-persistence"

type CompareExecutionCheckpoints = {
  (left: TranscriptPage.ExecutionCheckpoint, right: TranscriptPage.ExecutionCheckpoint): number
  (right: TranscriptPage.ExecutionCheckpoint): (left: TranscriptPage.ExecutionCheckpoint) => number
}
function compareExecutionCheckpointsImplementation(
  right: TranscriptPage.ExecutionCheckpoint,
): (left: TranscriptPage.ExecutionCheckpoint) => number
function compareExecutionCheckpointsImplementation(
  left: TranscriptPage.ExecutionCheckpoint,
  right: TranscriptPage.ExecutionCheckpoint,
): number
function compareExecutionCheckpointsImplementation(
  leftOrRight: TranscriptPage.ExecutionCheckpoint,
  right?: TranscriptPage.ExecutionCheckpoint,
): number | ((left: TranscriptPage.ExecutionCheckpoint) => number) {
  if (right === undefined) return (left) => compareExecutionCheckpointsImplementation(left, leftOrRight)
  if (leftOrRight.executionKey < right.executionKey) return -1
  if (leftOrRight.executionKey > right.executionKey) return 1
  return 0
}

export const compareExecutionCheckpoints: CompareExecutionCheckpoints = compareExecutionCheckpointsImplementation

export { expect, it } from "@effect/vitest"
export { Effect } from "effect"
export { TranscriptRepository, TranscriptProjection }
export { commitAll }
