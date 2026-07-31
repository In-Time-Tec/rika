import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Function } from "effect"
import { projectionVersion } from "../src/execution/ingest/execution-ingest-service"

export interface StoreProjectionOptions {
  readonly executionCheckpoints?: ReadonlyArray<TranscriptRepository.ExecutionCheckpoint>
  readonly consumed?: Readonly<
    Record<
      string,
      { readonly cursor: string; readonly sequence: number; readonly status?: "completed" | "failed" | "cancelled" }
    >
  >
  readonly executionStates?: Readonly<Record<string, TranscriptProjectionModel.ProjectionState>>
  readonly projectionVersion?: number
}

export const invalidatedProjection: {
  (turn: Turn.Turn, revision?: number, checkpointGeneration?: number): TranscriptRepository.Projection
  (revision?: number, checkpointGeneration?: number): (turn: Turn.Turn) => TranscriptRepository.Projection
} = Function.dual(
  (args) => typeof args[0] === "object" && args[0] !== null && "_tag" in args[0],
  (turn: Turn.Turn, revision = -1, checkpointGeneration = 0): TranscriptRepository.Projection => ({
    turn,
    units: [],
    checkpointGeneration,
    revision,
    modelPhase: -1,
    usableCompletionSequence: undefined,
    oldestCursor: undefined,
    checkpointCursor: undefined,
    costUsd: undefined,
    usageCursors: undefined,
    pricingVersion: undefined,
    executionCheckpoints: [],
    projectionVersion: TranscriptRepository.invalidatedProjectionVersion,
  }),
)

export const delegationUnit: {
  (executionId: string, callId: string, childExecutionId: string, sequence: number): TranscriptUnit.Unit
  (callId: string, childExecutionId: string, sequence: number): (executionId: string) => TranscriptUnit.Unit
} = Function.dual(
  4,
  (executionId: string, callId: string, childExecutionId: string, sequence: number): TranscriptUnit.Unit => {
    const projection = TranscriptProjection.Projection.project(executionId, "", [
      {
        cursor: `${callId}:requested`,
        sequence,
        type: "tool.call.requested",
        createdAt: sequence,
        data: { tool_call_id: callId, tool_name: "task", input: { prompt: childExecutionId } },
      },
      {
        cursor: `${callId}:spawned`,
        sequence: sequence + 1,
        type: "child_run.spawned",
        createdAt: sequence + 1,
        data: { tool_call_id: callId, child_execution_id: childExecutionId },
      },
    ])
    const unit = projection.units.find(
      (candidate) => candidate.content._tag === "Block" && candidate.content.block._tag === "ToolCall",
    )
    if (unit === undefined) throw new TypeError(`Delegation ${callId} did not project a tool unit`)
    return unit
  },
)

const statusFor = (units: ReadonlyArray<TranscriptUnit.Unit>) => {
  const outcome = units.find((unit) => unit.executionOutcome !== undefined)?.executionOutcome?.status
  if (outcome === "complete") return "completed" as const
  if (outcome === "failed" || outcome === "cancelled") return outcome
  return undefined
}

const attachmentFor = (
  projection: TranscriptProjectionModel.Projection,
  executionId: string,
  units: ReadonlyArray<TranscriptUnit.Unit>,
): TranscriptRepository.ExecutionAttachment => {
  const sample = units[0]
  if (sample === undefined) {
    const parent = TranscriptCorrelation.childParentMatch(
      projection.units.flatMap((unit) =>
        unit.content._tag === "Block" && unit.content.block._tag === "ToolCall"
          ? [
              {
                id: unit.content.block.id,
                scope: unit.turnId,
                childId: unit.content.block.childId,
                family: unit.content.block.presentation.family,
                unit,
              },
            ]
          : [],
      ),
      executionId,
    )?.unit
    if (parent === undefined || parent.content._tag !== "Block" || parent.content.block._tag !== "ToolCall")
      throw new Error(`Execution ${executionId} has no durable parent tool`)
    return {
      parentExecutionKey: TranscriptCorrelation.executionKey(parent.turnId),
      parentUnitKey: parent.key,
      parentId: parent.content.block.id,
      parentOrderKey: TranscriptOrdering.encodeUnitOrder(parent.order),
    }
  }
  if (sample.parentId === undefined) throw new Error(`Execution ${executionId} has no attached transcript unit`)
  const edge = sample.order.findIndex((segment) => segment.key === `@child:${executionId}`)
  if (edge <= 0) throw new Error(`Execution ${executionId} has no intrinsic child order edge`)
  const parentOrder: TranscriptUnit.UnitOrder = [sample.order[0]!, ...sample.order.slice(1, edge)]
  const parent = projection.units.find(
    (unit) =>
      TranscriptOrdering.compareUnitOrder(unit.order, parentOrder) === 0 &&
      unit.content._tag === "Block" &&
      unit.content.block._tag === "ToolCall" &&
      unit.content.block.id === sample.parentId,
  )
  if (parent === undefined) throw new Error(`Execution ${executionId} has no durable parent tool`)
  for (const unit of units)
    if (
      unit.parentId !== sample.parentId ||
      unit.order[edge]?.key !== `@child:${executionId}` ||
      TranscriptOrdering.compareUnitOrder([unit.order[0]!, ...unit.order.slice(1, edge)], parent.order) !== 0
    )
      throw new Error(`Execution ${executionId} has contradictory attached transcript units`)
  return {
    parentExecutionKey: TranscriptCorrelation.executionKey(parent.turnId),
    parentUnitKey: parent.key,
    parentId: sample.parentId,
    parentOrderKey: TranscriptOrdering.encodeUnitOrder(parent.order),
  }
}

const inferredExecutionCheckpoints = (
  turn: Turn.Turn,
  projection: TranscriptProjectionModel.Projection,
  options: StoreProjectionOptions,
): ReadonlyArray<TranscriptRepository.ExecutionCheckpoint> => {
  const rootKey = TranscriptCorrelation.executionKey(String(turn.id))
  const executions = new Map<string, { readonly executionId: string; readonly units: Array<TranscriptUnit.Unit> }>()
  for (const unit of projection.units) {
    const key = TranscriptCorrelation.executionKey(unit.turnId)
    const execution = executions.get(key)
    if (execution === undefined) executions.set(key, { executionId: unit.turnId, units: [unit] })
    else execution.units.push(unit)
  }
  if (!executions.has(rootKey)) executions.set(rootKey, { executionId: String(turn.id), units: [] })
  const checkpoints: Array<TranscriptRepository.ExecutionCheckpoint> = []
  for (const [executionKey, execution] of executions) {
    const { executionId, units } = execution
    const consumed = options.consumed?.[executionKey]
    const inferredSequence = units.reduce((maximum, unit) => Math.max(maximum, unit.revision), -1)
    const sequence = consumed?.sequence ?? (executionKey === rootKey ? projection.revision : inferredSequence)
    const cursor = consumed?.cursor ?? (executionKey === rootKey ? (projection.checkpointCursor ?? "") : "")
    const state =
      options.executionStates?.[executionKey] ??
      (executionKey === rootKey
        ? TranscriptProjection.Projection.projectionState(projection)
        : {
            revision: sequence,
            modelPhase: 0,
            ...(cursor.length === 0 ? {} : { checkpointCursor: cursor }),
          })
    const status = consumed?.status ?? statusFor(units)
    checkpoints.push({
      executionKey,
      executionId,
      cursor,
      sequence,
      ...(status === undefined ? {} : { status }),
      state,
      ...(executionKey === rootKey ? {} : { attachment: attachmentFor(projection, executionId, units) }),
    })
  }
  return checkpoints
}

export const storeProjection: {
  (
    repository: TranscriptRepository.Interface,
    turn: Turn.AgentExecutionTurn,
    projection: TranscriptProjectionModel.Projection,
    options?: StoreProjectionOptions,
  ): ReturnType<TranscriptRepository.Interface["commitDelta"]>
  (
    turn: Turn.AgentExecutionTurn,
    projection: TranscriptProjectionModel.Projection,
    options?: StoreProjectionOptions,
  ): (repository: TranscriptRepository.Interface) => ReturnType<TranscriptRepository.Interface["commitDelta"]>
} = Function.dual(
  (args) => typeof args[0] === "object" && args[0] !== null && "commitDelta" in args[0],
  (
    repository: TranscriptRepository.Interface,
    turn: Turn.AgentExecutionTurn,
    projection: TranscriptProjectionModel.Projection,
    options: StoreProjectionOptions = {},
  ) =>
    repository.commitDelta(
      turn,
      TranscriptProjection.Projection.projectionState(projection),
      { upsert: projection.units, remove: [] },
      {
        expectedGeneration: undefined,
        executionCheckpoints: options.executionCheckpoints ?? inferredExecutionCheckpoints(turn, projection, options),
        projectionVersion: options.projectionVersion ?? projectionVersion,
      },
    ),
)
