import { Effect, Schema } from "effect"
import { WorkspaceBinding, sameBinding } from "@rika/execution"
import { WorkspaceEnrollmentError, type BoxId } from "@rika/box-executor"
import type { BoxAssignmentRepository, BoxAssignmentProjection } from "@rika/product-store/box-assignments"
import { threadPartition, type ThreadExecutionBinding } from "../runtime/partition"

const unavailable = () =>
  WorkspaceEnrollmentError.make({ phase: "enroll", message: "Box assignment authority is unavailable" })

export const boxWorkspaceBinding = (row: BoxAssignmentProjection) =>
  Schema.decodeEffect(WorkspaceBinding)({
    workspaceId: row.workspaceId,
    assignmentId: row.assignmentId,
    generation: row.generation,
    placement: { _tag: "Orb", workspaceId: row.workspaceId, lineageId: row.placement.lineageId },
    buildId: row.placement.executorPolicy.buildId,
    protocolVersion: row.placement.executorPolicy.protocolVersion,
  }).pipe(Effect.mapError(unavailable))

export const makeBoxBindingReader = (options: {
  readonly assignments: Pick<BoxAssignmentRepository, "get">
  readonly environment: string
}) =>
  Effect.fn("Rika.BoxBinding.read")(function* (
    boxId: BoxId,
    expected: WorkspaceBinding,
  ): Effect.fn.Return<ThreadExecutionBinding | undefined, WorkspaceEnrollmentError> {
    const row = yield* options.assignments.get(expected.assignmentId).pipe(Effect.mapError(unavailable))
    if (
      row === undefined ||
      row.lifecycle === "paused" ||
      row.lifecycle === "terminated" ||
      row.providerInstanceId !== boxId
    )
      return undefined
    const binding = yield* boxWorkspaceBinding(row)
    if (!sameBinding(binding, expected)) return undefined
    return {
      partition: threadPartition({
        environment: options.environment,
        ownerId: row.ownerId,
        threadId: row.threadId,
        target: "orb",
      }),
      placement: binding.placement,
      workspaceBinding: binding,
    }
  })
