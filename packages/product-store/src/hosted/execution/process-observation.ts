import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import { ProcessTerminalObservation } from "@rika/product/process-observation"
import { ToolOperationResponse } from "@rika/product/tool-operation-lifecycle"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import {
  rikaHostedExecutorAssignments,
  rikaHostedExecutorOperations,
  rikaHostedExecutorProcessObservations,
  rikaTranscriptCheckpoints,
  rikaTranscriptUnits,
  rikaTurns,
} from "../../database/schema/product"
import type { HostedExecutionOperationsService } from "./operation-contract"
import { failure, query } from "./operation-row"

const UnitJson = Schema.fromJsonString(TranscriptUnit.Unit)
const encodeUnit = Schema.encodeSync(UnitJson)
const observationsAreEquivalent = Schema.toEquivalence(ProcessTerminalObservation)

const applyObservation = (
  unit: TranscriptUnit.Unit,
  operation: { readonly operationKey: string; readonly toolCallId: string },
  observation: Parameters<HostedExecutionOperationsService["recordProcessObservation"]>[0]["observation"],
) => {
  if (unit.content._tag !== "Block" || unit.content.block._tag !== "ToolCall") return unit
  const tool = unit.content.block
  if (
    tool.operationId !== operation.operationKey ||
    tool.toolCallId !== operation.toolCallId ||
    tool.process?.processId !== observation.processId
  )
    return unit
  return {
    ...unit,
    content: {
      ...unit.content,
      block: {
        ...tool,
        status: observation.exitCode === 0 ? ("complete" as const) : ("failed" as const),
        process: { ...tool.process, ...observation, running: false },
      },
    },
  }
}

const overlayProcessObservations = (
  tx: PgDrizzle.EffectPgDatabase,
  turnId: string,
  units: ReadonlyArray<TranscriptUnit.Unit>,
) =>
  Effect.gen(function* () {
    if (
      !units.some(
        (unit) =>
          unit.content._tag === "Block" &&
          unit.content.block._tag === "ToolCall" &&
          unit.content.block.process?.running === true,
      )
    )
      return [...units]
    const rows = yield* query(
      tx
        .select({
          operationKey: rikaHostedExecutorOperations.operationKey,
          toolCallId: rikaHostedExecutorOperations.toolCallId,
          observation: rikaHostedExecutorProcessObservations.observation,
        })
        .from(rikaHostedExecutorProcessObservations)
        .innerJoin(
          rikaHostedExecutorOperations,
          and(
            eq(rikaHostedExecutorOperations.assignmentId, rikaHostedExecutorProcessObservations.assignmentId),
            eq(rikaHostedExecutorOperations.operationKey, rikaHostedExecutorProcessObservations.operationKey),
            eq(rikaHostedExecutorOperations.attempt, rikaHostedExecutorProcessObservations.attempt),
          ),
        )
        .where(eq(rikaHostedExecutorOperations.turnId, turnId)),
    )
    let overlaid = [...units]
    for (const row of rows) {
      const observation = yield* Schema.decodeUnknownEffect(ProcessTerminalObservation)(row.observation).pipe(
        Effect.mapError(failure),
      )
      overlaid = overlaid.map((unit) => applyObservation(unit, row, observation))
    }
    return overlaid
  })

export const ProcessObservationProjection = { overlay: overlayProcessObservations }

const hasCurrentAuthority = (
  row: {
    readonly operation: typeof rikaHostedExecutorOperations.$inferSelect
    readonly assignment: typeof rikaHostedExecutorAssignments.$inferSelect
    readonly leaseCurrent: boolean
  },
  input: Parameters<HostedExecutionOperationsService["recordProcessObservation"]>[0],
) => {
  const { operation, assignment } = row
  const decodedCapabilities = Schema.decodeUnknownOption(WorkspaceCapabilitySnapshot)(assignment.capabilitySnapshot)
  const capabilities = Option.isSome(decodedCapabilities) ? decodedCapabilities.value : undefined
  return (
    operation.dispatchedGeneration === input.assignmentGeneration &&
    operation.dispatchedExecutorInstanceId === input.executorInstanceId &&
    operation.dispatchedProcessIncarnation === input.processIncarnation &&
    assignment.lifecycle === "active" &&
    assignment.generation === input.assignmentGeneration &&
    assignment.leaseEpoch === input.leaseEpoch &&
    assignment.executorInstanceId === input.executorInstanceId &&
    assignment.processIncarnation === input.processIncarnation &&
    row.leaseCurrent &&
    assignment.capabilityGeneration === input.assignmentGeneration &&
    capabilities?.process._tag === "Ready" &&
    capabilities.nativeTools._tag === "Ready"
  )
}

const returnedProcessId = (operation: typeof rikaHostedExecutorOperations.$inferSelect) => {
  const decoded = Schema.decodeUnknownOption(ToolOperationResponse)(operation.response)
  if (!Option.isSome(decoded) || decoded.value._tag !== "Success") return undefined
  const result = Schema.decodeUnknownOption(Schema.Struct({ processId: Schema.String }))(decoded.value.result)
  return Option.isSome(result) ? result.value.processId : undefined
}

export const operationsStore = (db: PgDrizzle.EffectPgDatabase) => {
  const recordProcessObservation: HostedExecutionOperationsService["recordProcessObservation"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* query(
            tx
              .select({
                operation: rikaHostedExecutorOperations,
                assignment: rikaHostedExecutorAssignments,
                leaseCurrent: sql<boolean>`${rikaHostedExecutorAssignments.leaseExpiresAt} > clock_timestamp()`,
              })
              .from(rikaHostedExecutorOperations)
              .innerJoin(
                rikaHostedExecutorAssignments,
                eq(rikaHostedExecutorAssignments.id, rikaHostedExecutorOperations.assignmentId),
              )
              .where(
                and(
                  eq(rikaHostedExecutorOperations.assignmentId, input.assignmentId),
                  eq(rikaHostedExecutorOperations.operationKey, input.operationKey),
                  eq(rikaHostedExecutorOperations.attempt, input.attempt),
                ),
              )
              .for("update")
              .limit(1),
          )
          const row = rows[0]
          if (row === undefined) return "missing" as const
          const { operation } = row
          if (!hasCurrentAuthority(row, input)) return "fenced" as const
          // Reverse MachineResult frames persist concurrently with observation
          // frames. Retain an authorized early exit; projection still requires
          // the original tool result's operation and process identities to match.
          if (operation.state !== "dispatched" && operation.state !== "completed") return "fenced" as const
          if (operation.state === "completed" && returnedProcessId(operation) !== input.observation.processId)
            return "fenced" as const
          yield* query(
            tx
              .select({ turnId: rikaTurns.id })
              .from(rikaTurns)
              .where(eq(rikaTurns.id, operation.turnId))
              .for("update")
              .limit(1),
          )
          const inserted = yield* query(
            tx
              .insert(rikaHostedExecutorProcessObservations)
              .values({
                assignmentId: input.assignmentId,
                operationKey: input.operationKey,
                attempt: input.attempt,
                processId: input.observation.processId,
                observation: input.observation,
              })
              .onConflictDoNothing()
              .returning({ processId: rikaHostedExecutorProcessObservations.processId }),
          )
          if (inserted.length === 0) {
            const existing = yield* query(
              tx
                .select({ observation: rikaHostedExecutorProcessObservations.observation })
                .from(rikaHostedExecutorProcessObservations)
                .where(
                  and(
                    eq(rikaHostedExecutorProcessObservations.assignmentId, input.assignmentId),
                    eq(rikaHostedExecutorProcessObservations.operationKey, input.operationKey),
                    eq(rikaHostedExecutorProcessObservations.attempt, input.attempt),
                    eq(rikaHostedExecutorProcessObservations.processId, input.observation.processId),
                  ),
                )
                .limit(1),
            )
            const observation = yield* Schema.decodeUnknownEffect(ProcessTerminalObservation)(
              existing[0]?.observation,
            ).pipe(Effect.mapError(failure))
            return observationsAreEquivalent(observation, input.observation)
              ? ("duplicate" as const)
              : ("fenced" as const)
          }

          const projected = yield* query(
            tx
              .select({ unitKey: rikaTranscriptUnits.unitKey, unitJson: rikaTranscriptUnits.unitJson })
              .from(rikaTranscriptUnits)
              .where(eq(rikaTranscriptUnits.turnId, operation.turnId))
              .for("update"),
          )
          let changed = false
          for (const candidate of projected) {
            const unit = yield* Schema.decodeEffect(UnitJson)(candidate.unitJson).pipe(Effect.mapError(failure))
            const updated = applyObservation(unit, operation, input.observation)
            if (updated === unit) continue
            changed = true
            yield* query(
              tx
                .update(rikaTranscriptUnits)
                .set({ unitJson: encodeUnit(updated), updatedAt: sql`extract(epoch from clock_timestamp()) * 1000` })
                .where(
                  and(
                    eq(rikaTranscriptUnits.turnId, operation.turnId),
                    eq(rikaTranscriptUnits.unitKey, candidate.unitKey),
                  ),
                ),
            )
          }
          if (changed)
            yield* query(
              tx
                .update(rikaTranscriptCheckpoints)
                .set({
                  checkpointGeneration: sql`${rikaTranscriptCheckpoints.checkpointGeneration} + 1`,
                  updatedAt: sql`extract(epoch from clock_timestamp()) * 1000`,
                })
                .where(eq(rikaTranscriptCheckpoints.turnId, operation.turnId)),
            )
          return "recorded" as const
        }),
      )
      .pipe(Effect.mapError(failure))
  return { recordProcessObservation }
}
