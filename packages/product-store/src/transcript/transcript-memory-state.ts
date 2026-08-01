import type { ExecutionCheckpoint } from "@rika/product/transcript-page"
import type { Projection } from "@rika/product/transcript-page"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Turn } from "@rika/product/turn-record"
import type { Interface } from "@rika/product/transcript-repository"
type CheckpointOptions = Parameters<Interface["commitDelta"]>[3]

import { support } from "./transcript-repository-support"

const { clone, sameExecutionAttachment, storedProjection } = support

export interface MemoryEntry {
  projection: Projection
  unitsByKey: Map<string, TranscriptUnit.Unit>
  orderOwners: Map<string, string>
  checkpointsByKey: Map<string, ExecutionCheckpoint>
  attachmentsByUnit: Map<string, string>
}

export const materializeMemory = (entry: MemoryEntry): Projection => ({
  ...clone(entry.projection),
  units: [...entry.unitsByKey.values()]
    .toSorted((left, right) => TranscriptOrdering.compareUnitOrder(left.order, right.order))
    .map(clone),
  executionCheckpoints: [...entry.checkpointsByKey.values()]
    .toSorted((left, right) => left.executionKey.localeCompare(right.executionKey))
    .map(clone),
})

export function memoryEntry(
  projection: TranscriptProjectionModel.Projection,
  options: CheckpointOptions,
  checkpointGeneration: number,
): (turn: Turn) => MemoryEntry
export function memoryEntry(
  turn: Turn,
  projection: TranscriptProjectionModel.Projection,
  options: CheckpointOptions,
  checkpointGeneration: number,
): MemoryEntry
export function memoryEntry(
  turnOrProjection: Turn | TranscriptProjectionModel.Projection,
  projectionOrOptions?: TranscriptProjectionModel.Projection | CheckpointOptions,
  optionsOrGeneration?: CheckpointOptions | number,
  checkpointGeneration?: number,
): MemoryEntry | ((turn: Turn) => MemoryEntry) {
  if (checkpointGeneration === undefined) {
    if (
      !("units" in turnOrProjection) ||
      projectionOrOptions === undefined ||
      !("executionCheckpoints" in projectionOrOptions) ||
      typeof optionsOrGeneration !== "number"
    )
      throw new Error("Invalid memory entry arguments")
    return (nextTurn) => memoryEntry(nextTurn, turnOrProjection, projectionOrOptions, optionsOrGeneration)
  }
  if (
    !("_tag" in turnOrProjection) ||
    projectionOrOptions === undefined ||
    !("units" in projectionOrOptions) ||
    optionsOrGeneration === undefined ||
    typeof optionsOrGeneration === "number"
  )
    throw new Error("Invalid memory entry arguments")
  const turn = turnOrProjection
  const projection = projectionOrOptions
  const options = optionsOrGeneration

  const unitsByKey = new Map(projection.units.map((unit) => [unit.key, clone(unit)]))
  const checkpointsByKey = new Map(
    options.executionCheckpoints.map((checkpoint) => [checkpoint.executionKey, clone(checkpoint)]),
  )
  const orderOwners = new Map(
    projection.units.map((unit) => [TranscriptOrdering.encodeUnitOrder(unit.order), unit.key]),
  )
  const attachmentsByUnit = new Map(
    options.executionCheckpoints.flatMap((checkpoint) =>
      checkpoint.attachment === undefined
        ? []
        : [[checkpoint.attachment.parentUnitKey, checkpoint.executionKey] as const],
    ),
  )
  return {
    projection: storedProjection(
      turn,
      { ...projection, units: [] },
      { ...options, executionCheckpoints: [] },
      checkpointGeneration,
    ),
    unitsByKey,
    orderOwners,
    checkpointsByKey,
    attachmentsByUnit,
  }
}

export function sameAttachment(left: ExecutionCheckpoint): (right: ExecutionCheckpoint) => boolean
export function sameAttachment(left: ExecutionCheckpoint, right: ExecutionCheckpoint): boolean
export function sameAttachment(
  left: ExecutionCheckpoint,
  right?: ExecutionCheckpoint,
): boolean | ((right: ExecutionCheckpoint) => boolean) {
  if (right === undefined) return (nextRight) => sameAttachment(left, nextRight)
  return (
    left.executionId === right.executionId &&
    (left.attachment === undefined || right.attachment === undefined
      ? left.attachment === right.attachment
      : sameExecutionAttachment(left.attachment, right.attachment))
  )
}
