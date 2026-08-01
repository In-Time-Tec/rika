import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { commitAll } from "./transcript-fixture-persistence"

export const compareExecutionCheckpoints = (
  left: TranscriptRepository.ExecutionCheckpoint,
  right: TranscriptRepository.ExecutionCheckpoint,
): number => {
  if (left.executionKey < right.executionKey) return -1
  if (left.executionKey > right.executionKey) return 1
  return 0
}

export { expect, it } from "@effect/vitest"
export { Effect } from "effect"
export { TranscriptRepository, TranscriptProjection }
export { commitAll }
