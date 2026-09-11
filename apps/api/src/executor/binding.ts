import { Effect, Schema } from "effect"
import { WorkspaceBinding } from "@rika/execution"
import { ExecutorPlacementPolicy } from "@rika/product/executor-policy"
import type { ProductRepositoryService, ThreadExecutionProjection } from "@rika/product-store/product-repository"
import { threadPartition, type ThreadExecutionBinding } from "../runtime/partition"
import { ProductAuthorizationError } from "../product/authority"

const invalid = () =>
  ProductAuthorizationError.make({ kind: "invalid", message: "Thread execution binding is invalid" })

export const decodeThreadBinding = Effect.fn("Rika.ExecutorBinding.decode")(function* (
  row: ThreadExecutionProjection,
  input: {
    readonly environment: string
    readonly ownerId: string
    readonly threadId: string
  },
): Effect.fn.Return<ThreadExecutionBinding, ProductAuthorizationError> {
  const placement = yield* Schema.decodeUnknownEffect(ExecutorPlacementPolicy)(row.placement).pipe(
    Effect.mapError(invalid),
  )
  if ((row.executorKind === "runner") !== (placement._tag === "RunnerPlacement")) return yield* invalid()
  const workspacePlacement =
    placement._tag === "RunnerPlacement"
      ? { _tag: "Runner", workspaceId: row.workspaceId, checkoutFingerprint: placement.checkoutFingerprint }
      : { _tag: "Orb", workspaceId: row.workspaceId, lineageId: placement.lineageId }
  const workspaceBinding = yield* Schema.decodeUnknownEffect(WorkspaceBinding)({
    workspaceId: row.workspaceId,
    assignmentId: row.assignmentId,
    generation: Number(row.generation),
    placement: workspacePlacement,
    buildId: placement.executorPolicy.buildId,
    protocolVersion: placement.executorPolicy.protocolVersion,
  }).pipe(Effect.mapError(invalid))
  return {
    partition: threadPartition({
      environment: input.environment,
      ownerId: input.ownerId,
      threadId: input.threadId,
      target: row.executorKind,
    }),
    placement: workspaceBinding.placement,
    workspaceBinding,
  }
})

export const makeThreadBindingReader = (options: {
  readonly product: Pick<ProductRepositoryService, "threadExecutionContext">
  readonly environment: string
}) =>
  Effect.fn("Rika.ExecutorBinding.read")(function* (input: {
    readonly ownerId: string
    readonly threadId: string
  }): Effect.fn.Return<ThreadExecutionBinding | undefined, ProductAuthorizationError> {
    const row = yield* options.product
      .threadExecutionContext(input.ownerId, input.threadId)
      .pipe(
        Effect.mapError(() =>
          ProductAuthorizationError.make({ kind: "unavailable", message: "Thread assignment is unavailable" }),
        ),
      )
    if (row === undefined) return undefined
    return yield* decodeThreadBinding(row, { ...input, environment: options.environment })
  })
