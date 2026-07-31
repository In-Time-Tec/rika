import { Service } from "@rika/product/transcript-repository"
export { Service }
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptRecordedShell from "@rika/transcript/recorded-shell-presentation"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Effect, Layer, Ref, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { ThreadId } from "@rika/product/thread-record"
import * as TurnRepository from "../turn/sqlite-turn-repository"
import { Turn, TurnId, isAgentExecution, isRecordedShell } from "@rika/product/turn-record"
import type { AgentExecutionTurn, RunningRecordedShellTurn, TerminalRecordedShellTurn } from "@rika/product/turn-record"
import { EntrySchema, PageCursor, type Entry } from "@rika/product/transcript-page"

export { EntrySchema, PageCursor }
export type { Entry }

export const ExecutionAttachment = Schema.Struct({
  parentExecutionKey: Schema.String,
  parentUnitKey: Schema.String,
  parentId: Schema.String,
  parentOrderKey: Schema.String,
})
export type ExecutionAttachment = typeof ExecutionAttachment.Type

export const ExecutionCheckpoint = Schema.Struct({
  executionKey: Schema.String,
  executionId: Schema.String,
  cursor: Schema.String,
  sequence: Schema.Finite,
  status: Schema.optionalKey(Schema.Literals(["completed", "failed", "cancelled"])),
  state: TranscriptProjectionModel.ProjectionState,
  attachment: Schema.optionalKey(ExecutionAttachment),
})
export type ExecutionCheckpoint = typeof ExecutionCheckpoint.Type

export const invalidatedProjectionVersion = 2

export interface Projection {
  readonly turn: Turn
  readonly units: ReadonlyArray<TranscriptUnit.Unit>
  readonly checkpointGeneration: number
  readonly revision: number
  readonly modelPhase: number
  readonly usableCompletionSequence: number | undefined
  readonly oldestCursor: string | undefined
  readonly checkpointCursor: string | undefined
  readonly costUsd: number | undefined
  readonly usageCursors: ReadonlyArray<string> | undefined
  readonly pricingVersion: string | undefined
  readonly executionCheckpoints: ReadonlyArray<ExecutionCheckpoint>
  readonly projectionVersion: number
}

export interface CheckpointOptions {
  readonly executionCheckpoints: ReadonlyArray<ExecutionCheckpoint>
  readonly projectionVersion: number
}

export interface DeltaCheckpointOptions extends CheckpointOptions {
  readonly expectedGeneration: number | undefined
}

export interface UnitDelta {
  readonly upsert: ReadonlyArray<TranscriptUnit.Unit>
  readonly remove: ReadonlyArray<string>
}

export interface RefoldOptions extends CheckpointOptions {
  readonly expectedProjectionVersion: number
  readonly expectedGeneration: number
}

export interface PageOptions {
  readonly before?: PageCursor | undefined
  readonly after?: PageCursor | undefined
  readonly limit?: number
  readonly projectionVersion?: number
}

export interface Page {
  readonly entries: ReadonlyArray<Entry>
  readonly hasOlder: boolean
  readonly hasNewer?: boolean
  readonly oldestCursor: PageCursor | undefined
  readonly newestCursor?: PageCursor | undefined
  readonly threadCostUsd: number
}

export interface ProjectionRecoveryCandidate {
  readonly threadId: ThreadId
  readonly turnId: TurnId
}

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("TranscriptRepositoryError", {
  message: Schema.String,
}) {}

class RefoldStale extends Schema.TaggedErrorClass<RefoldStale>()("TranscriptRefoldStale", {}) {}

export type WriteResult = "committed" | "stale"
export type RefoldWriteResult =
  | { readonly _tag: "Committed"; readonly turn: AgentExecutionTurn }
  | { readonly _tag: "Stale" }
export type RecordedShellWriteResult =
  | { readonly _tag: "Committed"; readonly projection: Projection }
  | { readonly _tag: "Stale" }

export interface Interface {
  readonly get: (turnId: TurnId) => Effect.Effect<Projection | undefined, RepositoryError>
  readonly listProjectionRecoveryCandidates: (
    projectionVersion: number,
  ) => Effect.Effect<ReadonlyArray<ProjectionRecoveryCandidate>, RepositoryError>
  readonly commitDelta: (
    turn: AgentExecutionTurn,
    state: TranscriptProjectionModel.ProjectionState,
    delta: UnitDelta,
    options: DeltaCheckpointOptions,
  ) => Effect.Effect<WriteResult, RepositoryError>
  readonly replaceForRefold: (
    turn: AgentExecutionTurn,
    projection: TranscriptProjectionModel.Projection,
    options: RefoldOptions,
  ) => Effect.Effect<RefoldWriteResult, RepositoryError>
  readonly createRecordedShell: (
    turn: RunningRecordedShellTurn,
    projectionVersion: number,
  ) => Effect.Effect<Projection, RepositoryError>
  readonly copyRecordedShell: (
    turn: TerminalRecordedShellTurn,
    projectionVersion: number,
  ) => Effect.Effect<Projection, RepositoryError>
  readonly settleRecordedShell: (
    expected: RunningRecordedShellTurn,
    turn: TerminalRecordedShellTurn,
    expectedGeneration: number,
    projectionVersion: number,
  ) => Effect.Effect<RecordedShellWriteResult, RepositoryError>
  readonly page: (threadId: ThreadId, options?: PageOptions) => Effect.Effect<Page, RepositoryError>
  readonly globalCostUsd: Effect.Effect<number, RepositoryError>
}

const CheckpointRow = Schema.Struct({
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

const ProjectionRecoveryCandidateRow = Schema.Struct({
  thread_id: ThreadId,
  turn_id: TurnId,
})

const ExecutionCheckpointRow = Schema.Struct({
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

const StoredUnitRow = Schema.Struct({
  unit_key: Schema.String,
  execution_key: Schema.NullOr(Schema.String),
  turn_id: Schema.String,
  parent_id: Schema.NullOr(Schema.String),
  tool_id: Schema.NullOr(Schema.String),
  unit_json: Schema.String,
  unit_order_key: Schema.String,
})

const UnitRow = Schema.Struct({
  unit_key: Schema.String,
  execution_key: Schema.NullOr(Schema.String),
  unit_json: Schema.String,
  unit_order_key: Schema.String,
  durable_parent_id: Schema.NullOr(Schema.String),
  durable_tool_id: Schema.NullOr(Schema.String),
  checkpoint_execution_id: Schema.NullOr(Schema.String),
  checkpoint_is_root: Schema.NullOr(Schema.Finite),
  attachment_parent_execution_key: Schema.NullOr(Schema.String),
  attachment_parent_unit_key: Schema.NullOr(Schema.String),
  attachment_parent_id: Schema.NullOr(Schema.String),
  attachment_parent_order_key: Schema.NullOr(Schema.String),
  attachment_unit_key: Schema.NullOr(Schema.String),
  attachment_unit_execution_key: Schema.NullOr(Schema.String),
  attachment_unit_order_key: Schema.NullOr(Schema.String),
  attachment_unit_tool_id: Schema.NullOr(Schema.String),
  attachment_unit_json: Schema.NullOr(Schema.String),
  turn_id: Schema.String,
  projection_revision: Schema.Finite,
  model_phase: Schema.Finite,
  cost_usd: Schema.NullOr(Schema.Finite),
  projection_version: Schema.Finite,
})

const UnitJson = Schema.fromJsonString(TranscriptUnit.Unit)
const UsageCursorsJson = Schema.fromJsonString(Schema.Array(Schema.String))
const error = (cause: unknown) =>
  Schema.is(RepositoryError)(cause) ? cause : RepositoryError.make({ message: String(cause) })
const clone = <A>(value: A): A => structuredClone(value)
const refoldStale = RefoldStale.make({})
const sameTurn = Schema.toEquivalence(Turn)
const sameExecutionAttachment = Schema.toEquivalence(ExecutionAttachment)
const isRefoldStale = (value: unknown): value is RefoldStale =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === "TranscriptRefoldStale"

const refoldTurn = Effect.fn("TranscriptRepository.refoldTurn")(function* (
  expected: AgentExecutionTurn,
  projection: TranscriptProjectionModel.Projection,
  options: RefoldOptions,
) {
  const rootKey = TranscriptCorrelation.executionKey(String(expected.id))
  const roots = options.executionCheckpoints.filter((checkpoint) => checkpoint.executionKey === rootKey)
  if (roots.length !== 1)
    return yield* RepositoryError.make({ message: `Transcript ${expected.id} has no unique root execution checkpoint` })
  const root = roots[0]!
  if (root.attachment !== undefined || root.status === undefined || root.cursor.length === 0)
    return yield* RepositoryError.make({ message: `Transcript ${expected.id} has no durable terminal root outcome` })
  const outcomes = projection.units.filter(
    (unit) => unit.turnId === expected.id && unit.parentId === undefined && unit.executionOutcome !== undefined,
  )
  if (outcomes.length !== 1)
    return yield* RepositoryError.make({ message: `Transcript ${expected.id} has no unique projected root outcome` })
  const projected =
    outcomes[0]!.executionOutcome!.status === "complete" ? "completed" : outcomes[0]!.executionOutcome!.status
  if (projected !== root.status)
    return yield* RepositoryError.make({
      message: `Transcript ${expected.id} has contradictory terminal root outcomes`,
    })
  return { ...expected, status: root.status, lastCursor: root.cursor }
})

const pageSize = (limit: number | undefined) => Math.min(200, Math.max(1, Math.floor(limit ?? 50)))
const cursorFor = (entry: Entry | undefined): PageCursor | undefined =>
  entry === undefined
    ? undefined
    : {
        createdAt: entry.turn.createdAt,
        turnId: entry.turn.id,
        orderKey: TranscriptOrdering.encodeUnitOrder(entry.unit.order),
      }

const storedProjection = (
  turn: Turn,
  projection: TranscriptProjectionModel.Projection,
  options: CheckpointOptions,
  checkpointGeneration: number,
): Projection => ({
  turn: clone(turn),
  units: clone(projection.units),
  checkpointGeneration,
  revision: projection.revision,
  modelPhase: projection.modelPhase,
  usableCompletionSequence: projection.usableCompletionSequence,
  oldestCursor: projection.oldestCursor,
  checkpointCursor: projection.checkpointCursor,
  costUsd: projection.costUsd,
  usageCursors: projection.usageCursors === undefined ? undefined : clone(projection.usageCursors),
  pricingVersion: projection.pricingVersion,
  executionCheckpoints: clone(options.executionCheckpoints),
  projectionVersion: options.projectionVersion,
})

const withUnits = (
  state: TranscriptProjectionModel.ProjectionState,
  units: ReadonlyArray<TranscriptUnit.Unit>,
): TranscriptProjectionModel.Projection => ({
  units,
  revision: state.revision,
  modelPhase: state.modelPhase,
  ...(state.usableCompletionSequence === undefined ? {} : { usableCompletionSequence: state.usableCompletionSequence }),
  ...(state.oldestCursor === undefined ? {} : { oldestCursor: state.oldestCursor }),
  ...(state.checkpointCursor === undefined ? {} : { checkpointCursor: state.checkpointCursor }),
  ...(state.costUsd === undefined ? {} : { costUsd: state.costUsd }),
  ...(state.usageCursors === undefined ? {} : { usageCursors: state.usageCursors }),
  ...(state.pricingVersion === undefined ? {} : { pricingVersion: state.pricingVersion }),
})

const recordedShellProjection = (turn: RunningRecordedShellTurn | TerminalRecordedShellTurn) => {
  const running = TranscriptRecordedShell.recordedShellProjection({
    id: turn.id,
    command: turn.command,
    status: "running",
  })
  return turn.status === "running" ? running : TranscriptRecordedShell.settleRecordedShellProjection(running, turn)
}

const validateRecordedShellProjection = Effect.fn("TranscriptRepository.validateRecordedShellProjection")(function* (
  turn: RunningRecordedShellTurn | TerminalRecordedShellTurn,
  projection: TranscriptProjectionModel.Projection,
  projectionVersion: number,
) {
  yield* validateProjectionVersion(turn.id, projectionVersion)
  if (turn.prompt !== `$ ${turn.command}`)
    return yield* RepositoryError.make({ message: `Recorded shell turn ${turn.id} has a contradictory prompt` })
  const expected = recordedShellProjection(turn)
  if (
    !TranscriptProjection.Projection.sameProjectionState(expected, projection) ||
    expected.units.length !== projection.units.length
  )
    return yield* RepositoryError.make({ message: `Recorded shell turn ${turn.id} has a contradictory projection` })
  const [expectedUnits, actualUnits] = yield* Effect.all([
    Effect.forEach(expected.units, (unit) => Schema.encodeEffect(UnitJson)(unit)),
    Effect.forEach(projection.units, (unit) => Schema.encodeEffect(UnitJson)(unit)),
  ]).pipe(Effect.mapError(error))
  if (expectedUnits.some((unit, index) => unit !== actualUnits[index]))
    return yield* RepositoryError.make({ message: `Recorded shell turn ${turn.id} has contradictory units` })
})

const compareText = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const compareEntry = (left: Entry, right: Entry): number =>
  left.turn.createdAt - right.turn.createdAt ||
  compareText(left.turn.id, right.turn.id) ||
  TranscriptOrdering.compareUnitOrder(left.unit.order, right.unit.order)

const before = (entry: Entry, cursor: PageCursor): boolean =>
  entry.turn.createdAt < cursor.createdAt ||
  (entry.turn.createdAt === cursor.createdAt &&
    (entry.turn.id < cursor.turnId ||
      (entry.turn.id === cursor.turnId && TranscriptOrdering.encodeUnitOrder(entry.unit.order) < cursor.orderKey)))

const after = (entry: Entry, cursor: PageCursor): boolean =>
  entry.turn.createdAt > cursor.createdAt ||
  (entry.turn.createdAt === cursor.createdAt &&
    (entry.turn.id > cursor.turnId ||
      (entry.turn.id === cursor.turnId && TranscriptOrdering.encodeUnitOrder(entry.unit.order) > cursor.orderKey)))

const compareDescending = (left: Entry, right: Entry): number => compareEntry(right, left)

const unitSetError = (units: ReadonlyArray<TranscriptUnit.Unit>): RepositoryError | undefined => {
  const keys = new Set<string>()
  const orders = new Set<string>()
  for (const unit of units) {
    if (!TranscriptOrdering.hasIntrinsicOrder(unit))
      return RepositoryError.make({ message: `Transcript unit ${unit.key} has a non-intrinsic order` })
    if (keys.has(unit.key)) return RepositoryError.make({ message: `Transcript unit key ${unit.key} is duplicated` })
    keys.add(unit.key)
    const order = TranscriptOrdering.encodeUnitOrder(unit.order)
    if (orders.has(order)) return RepositoryError.make({ message: `Transcript unit order ${order} is duplicated` })
    orders.add(order)
  }
  return undefined
}

const validateUnits = (units: ReadonlyArray<TranscriptUnit.Unit>) => {
  const failure = unitSetError(units)
  return failure === undefined ? Effect.void : Effect.fail(failure)
}

const stateScalarError = (
  turnId: TurnId,
  owner: string,
  state: TranscriptProjectionModel.ProjectionState,
): RepositoryError | undefined => {
  if (!Number.isSafeInteger(state.revision) || state.revision < -1)
    return RepositoryError.make({ message: `Transcript ${turnId} has an invalid revision for ${owner}` })
  if (!Number.isSafeInteger(state.modelPhase) || state.modelPhase < -1)
    return RepositoryError.make({ message: `Transcript ${turnId} has an invalid model phase for ${owner}` })
  if (
    state.usableCompletionSequence !== undefined &&
    (!Number.isSafeInteger(state.usableCompletionSequence) || state.usableCompletionSequence < 0)
  )
    return RepositoryError.make({
      message: `Transcript ${turnId} has an invalid usable completion sequence for ${owner}`,
    })
  if (state.costUsd !== undefined && (!Number.isFinite(state.costUsd) || state.costUsd < 0))
    return RepositoryError.make({ message: `Transcript ${turnId} has an invalid cost for ${owner}` })
  return undefined
}

const validateStateScalars = (turnId: TurnId, owner: string, state: TranscriptProjectionModel.ProjectionState) => {
  const failure = stateScalarError(turnId, owner, state)
  return failure === undefined ? Effect.void : Effect.fail(failure)
}

const validateProjectionVersion = (turnId: TurnId, projectionVersion: number) =>
  Number.isSafeInteger(projectionVersion) && projectionVersion >= 1
    ? Effect.void
    : Effect.fail(RepositoryError.make({ message: `Transcript ${turnId} has an invalid projection version` }))

const validateCurrentProjectionVersion = (projectionVersion: number) =>
  Number.isSafeInteger(projectionVersion) && projectionVersion >= 1
    ? Effect.void
    : Effect.fail(RepositoryError.make({ message: "Transcript recovery has an invalid projection version" }))

const validateCheckpoint = (
  turn: AgentExecutionTurn,
  state: TranscriptProjectionModel.ProjectionState,
  options: CheckpointOptions,
  complete = false,
) => {
  const versionFailure =
    Number.isSafeInteger(options.projectionVersion) && options.projectionVersion >= 1
      ? undefined
      : RepositoryError.make({ message: `Transcript ${turn.id} has an invalid projection version` })
  if (versionFailure !== undefined) return Effect.fail(versionFailure)
  const rootStateFailure = stateScalarError(turn.id, "root projection", state)
  if (rootStateFailure !== undefined) return Effect.fail(rootStateFailure)
  const checkpoints = options.executionCheckpoints
  if (checkpoints.length === 0)
    return Effect.fail(RepositoryError.make({ message: `Transcript ${turn.id} has no execution checkpoint` }))
  const rootKey = TranscriptCorrelation.executionKey(String(turn.id))
  const keys = new Set<string>()
  const parents = new Map<string, string | undefined>()
  let root: ExecutionCheckpoint | undefined
  for (const checkpoint of checkpoints) {
    if (checkpoint.executionKey.length === 0)
      return Effect.fail(RepositoryError.make({ message: `Transcript ${turn.id} has an empty execution key` }))
    if (
      checkpoint.executionId.length === 0 ||
      TranscriptCorrelation.executionKey(checkpoint.executionId) !== checkpoint.executionKey
    )
      return Effect.fail(
        RepositoryError.make({
          message: `Transcript ${turn.id} has an invalid execution id for ${checkpoint.executionKey}`,
        }),
      )
    if (keys.has(checkpoint.executionKey))
      return Effect.fail(
        RepositoryError.make({ message: `Transcript ${turn.id} duplicates execution ${checkpoint.executionKey}` }),
      )
    keys.add(checkpoint.executionKey)
    parents.set(checkpoint.executionKey, checkpoint.attachment?.parentExecutionKey)
    if (!Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < -1)
      return Effect.fail(
        RepositoryError.make({
          message: `Transcript ${turn.id} has an invalid sequence for ${checkpoint.executionKey}`,
        }),
      )
    const stateFailure = stateScalarError(turn.id, checkpoint.executionKey, checkpoint.state)
    if (stateFailure !== undefined) return Effect.fail(stateFailure)
    if (checkpoint.state.revision !== checkpoint.sequence)
      return Effect.fail(
        RepositoryError.make({
          message: `Transcript ${turn.id} has inconsistent state for ${checkpoint.executionKey}`,
        }),
      )
    if ((checkpoint.state.checkpointCursor ?? "") !== checkpoint.cursor)
      return Effect.fail(
        RepositoryError.make({
          message: `Transcript ${turn.id} has inconsistent cursor for ${checkpoint.executionKey}`,
        }),
      )
    if (checkpoint.executionKey === rootKey) {
      root = checkpoint
      if (checkpoint.attachment !== undefined)
        return Effect.fail(RepositoryError.make({ message: `Transcript ${turn.id} attaches its root execution` }))
    } else {
      const attachment = checkpoint.attachment
      if (
        attachment === undefined ||
        attachment.parentExecutionKey.length === 0 ||
        attachment.parentUnitKey.length === 0 ||
        attachment.parentId.length === 0 ||
        attachment.parentOrderKey.length === 0 ||
        attachment.parentExecutionKey === checkpoint.executionKey
      )
        return Effect.fail(
          RepositoryError.make({
            message: `Transcript ${turn.id} has an invalid attachment for ${checkpoint.executionKey}`,
          }),
        )
    }
  }
  if (complete)
    if (root === undefined)
      return Effect.fail(RepositoryError.make({ message: `Transcript ${turn.id} has no root execution checkpoint` }))
  if (complete && root !== undefined && !TranscriptProjection.Projection.sameProjectionState(state, root.state))
    return Effect.fail(RepositoryError.make({ message: `Transcript ${turn.id} has contradictory root fold state` }))
  if (complete) {
    const connected = new Set<string>([rootKey])
    for (const checkpoint of checkpoints) {
      const path: Array<string> = []
      const visiting = new Set<string>()
      let key = checkpoint.executionKey
      while (!connected.has(key)) {
        if (visiting.has(key))
          return Effect.fail(
            RepositoryError.make({
              message: `Transcript ${turn.id} has a cyclic execution attachment at ${key}`,
            }),
          )
        visiting.add(key)
        path.push(key)
        const parentKey = parents.get(key)
        if (parentKey === undefined || !keys.has(parentKey))
          return Effect.fail(
            RepositoryError.make({
              message: `Transcript ${turn.id} has no parent execution ${parentKey ?? ""} for ${key}`,
            }),
          )
        key = parentKey
      }
      for (const connectedKey of path) connected.add(connectedKey)
    }
    if (connected.size !== checkpoints.length)
      return Effect.fail(
        RepositoryError.make({ message: `Transcript ${turn.id} has executions disconnected from its root` }),
      )
  }
  return Effect.void
}

const attachmentSetError = (
  turn: AgentExecutionTurn,
  units: ReadonlyArray<TranscriptUnit.Unit>,
  checkpoints: ReadonlyArray<ExecutionCheckpoint>,
): RepositoryError | undefined => {
  if (checkpoints.length === 0 && units.length === 0) return undefined
  const rootKey = TranscriptCorrelation.executionKey(String(turn.id))
  const byExecution = new Map(checkpoints.map((checkpoint) => [checkpoint.executionKey, checkpoint]))
  const byUnit = new Map(units.map((unit) => [unit.key, unit]))
  for (const checkpoint of checkpoints) {
    const attachment = checkpoint.attachment
    if (attachment === undefined) continue
    const parent = byUnit.get(attachment.parentUnitKey)
    if (
      parent === undefined ||
      TranscriptCorrelation.executionKey(parent.turnId) !== attachment.parentExecutionKey ||
      parent.content._tag !== "Block" ||
      parent.content.block._tag !== "ToolCall" ||
      parent.content.block.id !== attachment.parentId ||
      TranscriptOrdering.encodeUnitOrder(parent.order) !== attachment.parentOrderKey
    )
      return RepositoryError.make({
        message: `Transcript ${turn.id} has a contradictory attachment for ${checkpoint.executionKey}`,
      })
  }
  for (const unit of units) {
    const executionKey = TranscriptCorrelation.executionKey(unit.turnId)
    const checkpoint = byExecution.get(executionKey)
    if (executionKey === rootKey) {
      if (unit.parentId !== undefined)
        return RepositoryError.make({ message: `Transcript ${turn.id} attaches a root unit` })
      continue
    }
    const attachment = checkpoint?.attachment
    const parent = attachment === undefined ? undefined : byUnit.get(attachment.parentUnitKey)
    if (
      checkpoint === undefined ||
      attachment === undefined ||
      parent === undefined ||
      unit.parentId !== attachment.parentId ||
      TranscriptOrdering.encodeUnitOrder(unit.order) !==
        TranscriptOrdering.encodeUnitOrder(
          TranscriptOrdering.childOrder(
            parent.order,
            checkpoint.executionId,
            TranscriptOrdering.localOrder(unit.order),
          ),
        )
    )
      return RepositoryError.make({
        message: `Transcript ${turn.id} has a contradictory unit path for ${executionKey}`,
      })
  }
  return undefined
}

const validateAttachmentSet = (
  turn: AgentExecutionTurn,
  units: ReadonlyArray<TranscriptUnit.Unit>,
  checkpoints: ReadonlyArray<ExecutionCheckpoint>,
) => {
  const failure = attachmentSetError(turn, units, checkpoints)
  return failure === undefined ? Effect.void : Effect.fail(failure)
}

const validatePageOptions = (options: PageOptions) =>
  options.before !== undefined && options.after !== undefined
    ? Effect.fail(RepositoryError.make({ message: "Transcript pages cannot specify both before and after cursors" }))
    : Effect.void

const validateMemoryUnits = (units: ReadonlyArray<TranscriptUnit.Unit>) =>
  Effect.forEach(units, (unit) => Schema.encodeEffect(UnitJson)(unit).pipe(Effect.mapError(error)), { discard: true })

const validateMemoryCheckpoint = (options: CheckpointOptions) =>
  Effect.forEach(
    options.executionCheckpoints,
    (checkpoint) => Schema.encodeEffect(ExecutionCheckpoint)(checkpoint).pipe(Effect.mapError(error)),
    { discard: true },
  )

const validateDelta = (delta: UnitDelta) =>
  Effect.gen(function* () {
    yield* validateUnits(delta.upsert)
    const removed = new Set<string>()
    for (const key of delta.remove) {
      if (key.length === 0) return yield* RepositoryError.make({ message: "Transcript unit key is empty" })
      if (removed.has(key))
        return yield* RepositoryError.make({ message: `Transcript unit removal ${key} is duplicated` })
      removed.add(key)
    }
    for (const unit of delta.upsert)
      if (removed.has(unit.key))
        return yield* RepositoryError.make({
          message: `Transcript unit ${unit.key} cannot be removed and upserted together`,
        })
  })

type MemoryWrite =
  | { readonly _tag: "Success"; readonly result: WriteResult }
  | { readonly _tag: "Failure"; readonly error: RepositoryError }
type MemoryRefoldProjectionWrite = { readonly _tag: "Commit"; readonly value: void } | { readonly _tag: "Stale" }

const memoryWriteResult = (write: MemoryWrite): Effect.Effect<WriteResult, RepositoryError> =>
  write._tag === "Success" ? Effect.succeed(write.result) : Effect.fail(write.error)

interface MemoryEntry {
  projection: Projection
  unitsByKey: Map<string, TranscriptUnit.Unit>
  orderOwners: Map<string, string>
  checkpointsByKey: Map<string, ExecutionCheckpoint>
  attachmentsByUnit: Map<string, string>
}

const materializeMemory = (entry: MemoryEntry): Projection => ({
  ...clone(entry.projection),
  units: [...entry.unitsByKey.values()]
    .toSorted((left, right) => TranscriptOrdering.compareUnitOrder(left.order, right.order))
    .map(clone),
  executionCheckpoints: [...entry.checkpointsByKey.values()]
    .toSorted((left, right) => compareText(left.executionKey, right.executionKey))
    .map(clone),
})

const memoryEntry = (
  turn: Turn,
  projection: TranscriptProjectionModel.Projection,
  options: CheckpointOptions,
  checkpointGeneration: number,
): MemoryEntry => {
  const unitsByKey = new Map(projection.units.map((unit) => [unit.key, clone(unit)]))
  const checkpointsByKey = new Map(
    options.executionCheckpoints.map((checkpoint) => [checkpoint.executionKey, clone(checkpoint)]),
  )
  return {
    projection: storedProjection(
      turn,
      { ...projection, units: [] },
      { ...options, executionCheckpoints: [] },
      checkpointGeneration,
    ),
    unitsByKey,
    orderOwners: new Map(
      [...unitsByKey.values()].map((unit) => [TranscriptOrdering.encodeUnitOrder(unit.order), unit.key]),
    ),
    checkpointsByKey,
    attachmentsByUnit: new Map(
      [...checkpointsByKey.values()]
        .filter((checkpoint) => checkpoint.attachment !== undefined)
        .map((checkpoint) => [checkpoint.attachment!.parentUnitKey, checkpoint.executionKey]),
    ),
  }
}

const sameAttachment = (left: ExecutionCheckpoint, right: ExecutionCheckpoint): boolean =>
  left.executionId === right.executionId &&
  (left.attachment === undefined || right.attachment === undefined
    ? left.attachment === right.attachment
    : sameExecutionAttachment(left.attachment, right.attachment))

export interface MemoryOptions {
  readonly initial?: ReadonlyArray<Projection>
  readonly turns?: TurnRepository.Interface
}

export const makeMemory = (memoryOptions: MemoryOptions = {}) =>
  Effect.gen(function* () {
    const initial = memoryOptions.initial ?? []
    const turns = memoryOptions.turns
    const coordinator = turns === undefined ? undefined : TurnRepository.memoryCoordinator(turns)
    if (turns !== undefined && coordinator === undefined)
      return yield* RepositoryError.make({ message: "Memory transcript repository requires a memory Turn repository" })
    const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      coordinator === undefined ? effect : coordinator.withLock(effect)
    const initialEntries = new Map<TurnId, MemoryEntry>()
    for (const projection of initial) {
      if (initialEntries.has(projection.turn.id))
        return yield* RepositoryError.make({ message: `Transcript ${projection.turn.id} is duplicated` })
      if (!Number.isSafeInteger(projection.checkpointGeneration) || projection.checkpointGeneration < 0)
        return yield* RepositoryError.make({
          message: `Transcript ${projection.turn.id} has an invalid checkpoint generation`,
        })
      yield* validateUnits(projection.units)
      yield* validateMemoryUnits(projection.units)
      const options = {
        executionCheckpoints: projection.executionCheckpoints,
        projectionVersion: projection.projectionVersion,
      }
      yield* validateProjectionVersion(projection.turn.id, projection.projectionVersion)
      yield* validateStateScalars(
        projection.turn.id,
        "root projection",
        TranscriptProjection.Projection.projectionState(projection),
      )
      const invalidatedEmpty =
        projection.projectionVersion === invalidatedProjectionVersion &&
        projection.units.length === 0 &&
        projection.executionCheckpoints.length === 0
      if (isRecordedShell(projection.turn)) {
        if (projection.executionCheckpoints.length !== 0)
          return yield* RepositoryError.make({
            message: `Recorded shell turn ${projection.turn.id} has execution checkpoints`,
          })
        yield* validateRecordedShellProjection(
          projection.turn,
          withUnits(TranscriptProjection.Projection.projectionState(projection), projection.units),
          projection.projectionVersion,
        )
      } else if (!invalidatedEmpty) {
        yield* validateCheckpoint(
          projection.turn,
          TranscriptProjection.Projection.projectionState(projection),
          options,
          true,
        )
        yield* validateMemoryCheckpoint(options)
        yield* validateAttachmentSet(projection.turn, projection.units, projection.executionCheckpoints)
      }
      initialEntries.set(
        projection.turn.id,
        memoryEntry(
          projection.turn,
          withUnits(TranscriptProjection.Projection.projectionState(projection), projection.units),
          options,
          projection.checkpointGeneration,
        ),
      )
    }
    const state = yield* Ref.make(initialEntries)
    const get = Effect.fn("TranscriptRepository.get")(function* (turnId: TurnId) {
      const found = (yield* withLock(Ref.get(state))).get(turnId)
      return found === undefined ? undefined : materializeMemory(found)
    })
    const listProjectionRecoveryCandidates = Effect.fn("TranscriptRepository.listProjectionRecoveryCandidates")(
      function* (projectionVersion: number) {
        yield* validateCurrentProjectionVersion(projectionVersion)
        if (coordinator === undefined)
          return yield* RepositoryError.make({
            message: "Projection recovery requires paired memory Turn and Transcript repositories",
          })
        return yield* withLock(
          Effect.gen(function* () {
            const [entries, agentTurns] = yield* Effect.all([Ref.get(state), coordinator.agentExecutions])
            return agentTurns
              .filter((turn) => turn.status !== "queued")
              .filter((turn) => {
                const entry = entries.get(turn.id)
                return (
                  entry === undefined ||
                  entry.projection.projectionVersion < projectionVersion ||
                  [...entry.checkpointsByKey.values()].some((checkpoint) => checkpoint.status === undefined)
                )
              })
              .toSorted((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
              .map((turn) => ({ threadId: turn.threadId, turnId: turn.id }))
          }),
        )
      },
    )
    const insertRecordedShell = Effect.fn("TranscriptRepository.insertRecordedShell")(function* (
      turn: RunningRecordedShellTurn | TerminalRecordedShellTurn,
      projectionVersion: number,
    ) {
      if (coordinator === undefined)
        return yield* RepositoryError.make({
          message: "Recorded shell writes require paired memory Turn and Transcript repositories",
        })
      const projection = recordedShellProjection(turn)
      yield* validateUnits(projection.units)
      yield* validateMemoryUnits(projection.units)
      yield* validateRecordedShellProjection(turn, projection, projectionVersion)
      const written = yield* coordinator.writeRecordedShell(undefined, turn, (storedTurn) =>
        Ref.modify(
          state,
          (entries): readonly [TurnRepository.MemoryRefoldWrite<Projection>, Map<TurnId, MemoryEntry>] => {
            if (entries.has(storedTurn.id)) return [{ _tag: "Stale" as const }, entries] as const
            const entry = memoryEntry(storedTurn, projection, { executionCheckpoints: [], projectionVersion }, 0)
            entries.set(storedTurn.id, entry)
            return [{ _tag: "Commit" as const, value: materializeMemory(entry) }, entries] as const
          },
        ),
      )
      if (written._tag === "Stale")
        return yield* RepositoryError.make({ message: `Recorded shell turn ${turn.id} already exists` })
      return written.value.value
    })
    return Service.of({
      get,
      listProjectionRecoveryCandidates,
      commitDelta: Effect.fn("TranscriptRepository.commitDelta")(function* (turn, projectionState, delta, options) {
        yield* validateDelta(delta)
        yield* validateCheckpoint(turn, projectionState, options)
        yield* validateMemoryUnits(delta.upsert)
        yield* validateMemoryCheckpoint(options)
        const write = yield* withLock(
          Ref.modify(state, (entries): readonly [MemoryWrite, Map<TurnId, MemoryEntry>] => {
            const current = entries.get(turn.id)
            if (
              current?.projection.checkpointGeneration !== options.expectedGeneration ||
              (current !== undefined && current.projection.projectionVersion !== options.projectionVersion) ||
              (current !== undefined && current.projection.revision > projectionState.revision)
            )
              return [{ _tag: "Success", result: "stale" }, entries]
            const supplied = new Map(
              options.executionCheckpoints.map((checkpoint) => [checkpoint.executionKey, checkpoint]),
            )
            const checkpointFor = (key: string) => supplied.get(key) ?? current?.checkpointsByKey.get(key)
            const removals = new Set(delta.remove)
            const upserts = new Map(delta.upsert.map((unit) => [unit.key, unit]))
            const unitFor = (key: string) =>
              removals.has(key) ? undefined : (upserts.get(key) ?? current?.unitsByKey.get(key))
            for (const checkpoint of options.executionCheckpoints) {
              const previous = current?.checkpointsByKey.get(checkpoint.executionKey)
              if (previous !== undefined && !sameAttachment(previous, checkpoint))
                return [
                  {
                    _tag: "Failure",
                    error: RepositoryError.make({
                      message: `Execution checkpoint ${checkpoint.executionKey} changed its intrinsic identity`,
                    }),
                  },
                  entries,
                ]
              const attachment = checkpoint.attachment
              if (attachment !== undefined) {
                const parent = unitFor(attachment.parentUnitKey)
                if (
                  parent === undefined ||
                  checkpointFor(attachment.parentExecutionKey) === undefined ||
                  TranscriptCorrelation.executionKey(parent.turnId) !== attachment.parentExecutionKey ||
                  parent.content._tag !== "Block" ||
                  parent.content.block._tag !== "ToolCall" ||
                  parent.content.block.id !== attachment.parentId ||
                  TranscriptOrdering.encodeUnitOrder(parent.order) !== attachment.parentOrderKey
                )
                  return [
                    {
                      _tag: "Failure",
                      error: RepositoryError.make({
                        message: `Transcript ${turn.id} has a contradictory attachment for ${checkpoint.executionKey}`,
                      }),
                    },
                    entries,
                  ]
              }
            }
            const root = checkpointFor(TranscriptCorrelation.executionKey(String(turn.id)))
            if (
              root === undefined ||
              root.attachment !== undefined ||
              !TranscriptProjection.Projection.sameProjectionState(projectionState, root.state)
            )
              return [
                {
                  _tag: "Failure",
                  error: RepositoryError.make({ message: `Transcript ${turn.id} has contradictory root fold state` }),
                },
                entries,
              ]
            for (const key of removals)
              if (current !== undefined && current.attachmentsByUnit.has(key))
                return [
                  {
                    _tag: "Failure",
                    error: RepositoryError.make({ message: `Transcript unit ${key} has an attached execution` }),
                  },
                  entries,
                ]
            for (const unit of delta.upsert) {
              const previous = current?.unitsByKey.get(unit.key)
              const orderKey = TranscriptOrdering.encodeUnitOrder(unit.order)
              const previousToolId =
                previous?.content._tag === "Block" && previous.content.block._tag === "ToolCall"
                  ? previous.content.block.id
                  : undefined
              const toolId =
                unit.content._tag === "Block" && unit.content.block._tag === "ToolCall"
                  ? unit.content.block.id
                  : undefined
              if (
                previous !== undefined &&
                (previous.turnId !== unit.turnId ||
                  TranscriptOrdering.encodeUnitOrder(previous.order) !== orderKey ||
                  previousToolId !== toolId ||
                  previous.parentId !== unit.parentId)
              )
                return [
                  {
                    _tag: "Failure",
                    error: RepositoryError.make({
                      message: `Transcript unit ${unit.key} changed its intrinsic identity`,
                    }),
                  },
                  entries,
                ]
              const owner = current?.orderOwners.get(orderKey)
              if (owner !== undefined && owner !== unit.key && !removals.has(owner))
                return [
                  {
                    _tag: "Failure",
                    error: RepositoryError.make({ message: `Transcript unit order ${orderKey} is duplicated` }),
                  },
                  entries,
                ]
              const executionKey = TranscriptCorrelation.executionKey(unit.turnId)
              const checkpoint = checkpointFor(executionKey)
              if (checkpoint === undefined)
                return [
                  {
                    _tag: "Failure",
                    error: RepositoryError.make({ message: `Transcript unit ${unit.key} has no execution checkpoint` }),
                  },
                  entries,
                ]
              if (executionKey === TranscriptCorrelation.executionKey(String(turn.id))) {
                if (unit.parentId !== undefined)
                  return [
                    {
                      _tag: "Failure",
                      error: RepositoryError.make({ message: `Transcript ${turn.id} attaches a root unit` }),
                    },
                    entries,
                  ]
              } else {
                const attachment = checkpoint.attachment
                const parent = attachment === undefined ? undefined : unitFor(attachment.parentUnitKey)
                if (
                  attachment === undefined ||
                  parent === undefined ||
                  unit.parentId !== attachment.parentId ||
                  TranscriptOrdering.encodeUnitOrder(unit.order) !==
                    TranscriptOrdering.encodeUnitOrder(
                      TranscriptOrdering.childOrder(
                        parent.order,
                        checkpoint.executionId,
                        TranscriptOrdering.localOrder(unit.order),
                      ),
                    )
                )
                  return [
                    {
                      _tag: "Failure",
                      error: RepositoryError.make({
                        message: `Transcript ${turn.id} has a contradictory unit path for ${executionKey}`,
                      }),
                    },
                    entries,
                  ]
              }
            }
            const next = current ?? memoryEntry(turn, withUnits(projectionState, []), options, -1)
            for (const key of delta.remove) {
              const previous = next.unitsByKey.get(key)
              if (previous !== undefined) next.orderOwners.delete(TranscriptOrdering.encodeUnitOrder(previous.order))
              next.unitsByKey.delete(key)
            }
            for (const unit of delta.upsert) {
              const copy = clone(unit)
              next.unitsByKey.set(unit.key, copy)
              next.orderOwners.set(TranscriptOrdering.encodeUnitOrder(unit.order), unit.key)
            }
            for (const checkpoint of options.executionCheckpoints) {
              const copy = clone(checkpoint)
              next.checkpointsByKey.set(checkpoint.executionKey, copy)
              if (copy.attachment !== undefined)
                next.attachmentsByUnit.set(copy.attachment.parentUnitKey, copy.executionKey)
            }
            next.projection = storedProjection(
              turn,
              withUnits(projectionState, []),
              { executionCheckpoints: [], projectionVersion: options.projectionVersion },
              (current?.projection.checkpointGeneration ?? -1) + 1,
            )
            entries.set(turn.id, next)
            return [{ _tag: "Success", result: "committed" }, entries]
          }),
        )
        return yield* memoryWriteResult(write)
      }),
      replaceForRefold: Effect.fn("TranscriptRepository.replaceForRefold")(function* (turn, projection, options) {
        yield* validateUnits(projection.units)
        yield* validateCheckpoint(turn, TranscriptProjection.Projection.projectionState(projection), options, true)
        yield* validateMemoryUnits(projection.units)
        yield* validateMemoryCheckpoint(options)
        yield* validateAttachmentSet(turn, projection.units, options.executionCheckpoints)
        const replacementTurn = yield* refoldTurn(turn, projection, options)
        const writeProjection = (adopted: Turn) =>
          Ref.modify(state, (entries): readonly [MemoryRefoldProjectionWrite, Map<TurnId, MemoryEntry>] => {
            const current = entries.get(turn.id)
            if (
              current === undefined ||
              current.projection.projectionVersion !== options.expectedProjectionVersion ||
              current.projection.checkpointGeneration !== options.expectedGeneration ||
              options.projectionVersion <= current.projection.projectionVersion ||
              !isAgentExecution(current.projection.turn) ||
              current.projection.turn.status !== turn.status ||
              current.projection.turn.lastCursor !== turn.lastCursor
            )
              return [{ _tag: "Stale" as const }, entries] as const
            entries.set(turn.id, memoryEntry(adopted, projection, options, current.projection.checkpointGeneration + 1))
            return [{ _tag: "Commit", value: undefined }, entries]
          })
        if (coordinator === undefined) {
          const written = yield* withLock(writeProjection(replacementTurn))
          return written._tag === "Stale"
            ? { _tag: "Stale" as const }
            : { _tag: "Committed" as const, turn: replacementTurn }
        }
        const written = yield* coordinator.adoptRefold(
          turn,
          replacementTurn.status,
          replacementTurn.lastCursor,
          writeProjection,
        )
        return written._tag === "Stale"
          ? { _tag: "Stale" as const }
          : { _tag: "Committed" as const, turn: written.turn }
      }),
      createRecordedShell: insertRecordedShell,
      copyRecordedShell: insertRecordedShell,
      settleRecordedShell: Effect.fn("TranscriptRepository.settleRecordedShell")(
        function* (expected, turn, expectedGeneration, projectionVersion) {
          if (coordinator === undefined)
            return yield* RepositoryError.make({
              message: "Recorded shell writes require paired memory Turn and Transcript repositories",
            })
          const projection = recordedShellProjection(turn)
          yield* validateUnits(projection.units)
          yield* validateMemoryUnits(projection.units)
          yield* validateRecordedShellProjection(turn, projection, projectionVersion)
          const written = yield* coordinator.writeRecordedShell(expected, turn, (storedTurn) =>
            Ref.modify(
              state,
              (entries): readonly [TurnRepository.MemoryRefoldWrite<Projection>, Map<TurnId, MemoryEntry>] => {
                const current = entries.get(storedTurn.id)
                if (
                  current === undefined ||
                  current.projection.checkpointGeneration !== expectedGeneration ||
                  current.projection.projectionVersion !== projectionVersion ||
                  !isRecordedShell(current.projection.turn) ||
                  !sameTurn(current.projection.turn, expected)
                )
                  return [{ _tag: "Stale" as const }, entries] as const
                const entry = memoryEntry(
                  storedTurn,
                  projection,
                  { executionCheckpoints: [], projectionVersion },
                  current.projection.checkpointGeneration + 1,
                )
                entries.set(storedTurn.id, entry)
                return [{ _tag: "Commit" as const, value: materializeMemory(entry) }, entries] as const
              },
            ),
          )
          return written._tag === "Stale"
            ? { _tag: "Stale" as const }
            : { _tag: "Committed" as const, projection: written.value.value }
        },
      ),
      page: Effect.fn("TranscriptRepository.page")(function* (threadId, options = {}) {
        yield* validatePageOptions(options)
        const limit = pageSize(options.limit)
        const projections = [...(yield* withLock(Ref.get(state))).values()].map(materializeMemory)
        const descending = projections
          .filter(
            (projection) =>
              projection.turn.threadId === threadId &&
              projection.turn.status !== "queued" &&
              (options.projectionVersion === undefined || projection.projectionVersion === options.projectionVersion),
          )
          .flatMap((projection) =>
            projection.units.map((unit) => ({
              turn: projection.turn,
              unit,
              projectionRevision: projection.revision,
              projectionModelPhase: projection.modelPhase,
              ...(projection.costUsd === undefined ? {} : { projectionCostUsd: projection.costUsd }),
            })),
          )
          .filter((entry) => options.before === undefined || before(entry, options.before))
          .filter((entry) => options.after === undefined || after(entry, options.after))
          .toSorted(compareDescending)
        const selected = options.after === undefined ? descending.slice(0, limit) : descending.slice(-limit)
        const pageEntries = selected.toReversed().map(clone)
        const threadCostUsd = projections
          .filter((projection) => projection.turn.threadId === threadId)
          .reduce((total, projection) => total + (projection.costUsd ?? 0), 0)
        return {
          entries: pageEntries,
          hasOlder: options.after === undefined ? descending.length > limit : false,
          hasNewer: options.after !== undefined && descending.length > limit,
          oldestCursor: cursorFor(pageEntries[0]),
          newestCursor: cursorFor(pageEntries.at(-1)),
          threadCostUsd,
        }
      }),
      globalCostUsd: withLock(Ref.get(state)).pipe(
        Effect.map((entries) =>
          [...entries.values()].reduce((total, entry) => total + (entry.projection.costUsd ?? 0), 0),
        ),
      ),
    })
  })

export const memoryLayer = Layer.effect(Service, makeMemory())
export const memoryLayerWithTurns = Layer.effect(
  Service,
  Effect.gen(function* () {
    return yield* makeMemory({ turns: yield* TurnRepository.Service })
  }),
)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const decodeTurn = (row: unknown) => TurnRepository.decodeStoredTurn(row).pipe(Effect.mapError(error))
    const decodeExecutionCheckpoint = Effect.fn("TranscriptRepository.decodeExecutionCheckpoint")(function* (
      value: unknown,
    ) {
      const row = yield* Schema.decodeUnknownEffect(ExecutionCheckpointRow)(value)
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
    })
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
      return yield* Effect.all(rows.map((value) => decodeExecutionCheckpoint(value).pipe(Effect.mapError(error))))
    })
    const get = Effect.fn("TranscriptRepository.get")(function* (turnId: TurnId) {
      const checkpointRows = yield* sql`
        SELECT c.checkpoint_generation, c.model_phase, c.revision, c.usable_completion_sequence,
          c.oldest_cursor, c.checkpoint_cursor, c.cost_usd, c.usage_cursors_json,
          c.pricing_version, c.projection_version, t.*
        FROM rika_transcript_checkpoints c
        JOIN rika_turns t ON t.id = c.turn_id
        WHERE c.turn_id = ${turnId}
      `.pipe(Effect.mapError(error))
      if (checkpointRows[0] === undefined) return undefined
      const row = yield* Schema.decodeUnknownEffect(CheckpointRow)(checkpointRows[0]).pipe(Effect.mapError(error))
      const turn = yield* decodeTurn(checkpointRows[0])
      const unitRows = yield* sql`
        SELECT unit_key, execution_key, turn_id, parent_id, tool_id, unit_json, unit_order_key
        FROM rika_transcript_units
        WHERE turn_id = ${turnId}
        ORDER BY unit_order_key ASC
      `.pipe(Effect.mapError(error))
      const units = yield* Effect.all(
        unitRows.map((value) =>
          Schema.decodeUnknownEffect(StoredUnitRow)(value).pipe(
            Effect.flatMap((unitRow) =>
              Schema.decodeUnknownEffect(UnitJson)(unitRow.unit_json).pipe(
                Effect.filterOrFail(
                  (unit) => {
                    const toolId =
                      unit.content._tag === "Block" && unit.content.block._tag === "ToolCall"
                        ? unit.content.block.id
                        : null
                    return (
                      unit.key === unitRow.unit_key &&
                      (isRecordedShell(turn) ? null : TranscriptCorrelation.executionKey(unit.turnId)) ===
                        unitRow.execution_key &&
                      TranscriptOrdering.hasIntrinsicOrder(unit) &&
                      TranscriptOrdering.encodeUnitOrder(unit.order) === unitRow.unit_order_key &&
                      (unit.parentId ?? null) === unitRow.parent_id &&
                      toolId === unitRow.tool_id
                    )
                  },
                  () => RepositoryError.make({ message: "Transcript unit identity does not match its durable key" }),
                ),
              ),
            ),
            Effect.mapError(error),
          ),
        ),
      )
      yield* validateUnits(units)
      const executionCheckpoints = yield* loadExecutionCheckpoints(turnId)
      const usageCursors =
        row.usage_cursors_json === null
          ? undefined
          : yield* Schema.decodeUnknownEffect(UsageCursorsJson)(row.usage_cursors_json).pipe(Effect.mapError(error))
      const state: TranscriptProjectionModel.ProjectionState = {
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
      }
      yield* validateProjectionVersion(turn.id, row.projection_version)
      yield* validateStateScalars(turn.id, "root projection", state)
      const invalidatedEmpty =
        row.projection_version === invalidatedProjectionVersion &&
        units.length === 0 &&
        executionCheckpoints.length === 0
      if (isRecordedShell(turn)) {
        if (executionCheckpoints.length !== 0)
          return yield* RepositoryError.make({ message: `Recorded shell turn ${turn.id} has execution checkpoints` })
        yield* validateRecordedShellProjection(turn, withUnits(state, units), row.projection_version)
      } else if (!invalidatedEmpty) {
        yield* validateCheckpoint(
          turn,
          state,
          { executionCheckpoints, projectionVersion: row.projection_version },
          true,
        )
        yield* validateAttachmentSet(turn, units, executionCheckpoints)
      }
      return {
        turn,
        units,
        checkpointGeneration: row.checkpoint_generation,
        revision: state.revision,
        modelPhase: state.modelPhase,
        usableCompletionSequence: state.usableCompletionSequence,
        oldestCursor: state.oldestCursor,
        checkpointCursor: state.checkpointCursor,
        costUsd: state.costUsd,
        usageCursors: state.usageCursors,
        pricingVersion: state.pricingVersion,
        executionCheckpoints,
        projectionVersion: row.projection_version,
      } satisfies Projection
    })
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
            Schema.decodeUnknownEffect(ProjectionRecoveryCandidateRow)(row).pipe(
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
            Schema.decodeUnknownEffect(UnitRow)(value).pipe(
              Effect.flatMap((row) =>
                Effect.gen(function* () {
                  const unit = yield* Schema.decodeUnknownEffect(UnitJson)(row.unit_json)
                  const turnId = yield* Schema.decodeUnknownEffect(TurnId)(row.turn_id)
                  const turn = yield* decodeTurn(value)
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
