import { Effect, Schema, type Context } from "effect"
import type { BoxId } from "@rika/box-executor"
import type { BoxWorkspaceInputClient } from "@rika/box-executor/workspace-input"
import { BoxWorkspaceInputPolicy, type BoxWorkspaceInputError } from "@rika/box-executor/workspace-input-contract"
import { ContextMaterializationError } from "@rika/context"
import type { WorkspaceBinding } from "@rika/execution"
import type { RepositoryCheckout, WorkspaceSeed } from "@rika/product/executor-assignment"
import type { BoxAssignmentProjection } from "@rika/product-store/box-assignments"
import { StoredArchive, type Archive } from "@rika/workspace-input/contract"
import type { RepositoryInput } from "@rika/workspace-input/repository"
import type { WorkspaceSeedVaultContract } from "@rika/workspace-input/vault"
import type { ProductControlError } from "../product/control"

export interface BoxWorkspaceInputInitializerOptions<R = never> {
  readonly client: BoxWorkspaceInputClient
  readonly capture: (checkout: RepositoryCheckout) => Effect.Effect<RepositoryInput, ProductControlError, R>
  readonly vault: Pick<WorkspaceSeedVaultContract, "load">
  readonly platform: Context.Context<R>
}

export type BoxWorkspaceInputEnsure = (
  row: BoxAssignmentProjection,
  boxId: BoxId,
  binding: WorkspaceBinding,
) => Effect.Effect<void, ContextMaterializationError>

export interface BoxWorkspaceInputInitializer {
  readonly ensure: BoxWorkspaceInputEnsure
}

const rejected = () =>
  ContextMaterializationError.make({
    reason: "binding",
    message: "Box workspace input does not match the current assignment",
  })

const unavailable = () =>
  ContextMaterializationError.make({ reason: "reader", message: "Box workspace input is unavailable" })

const inputFailure = (error: BoxWorkspaceInputError) => (error.reason === "conflict" ? rejected() : unavailable())

const admittedPolicy = (row: BoxAssignmentProjection, binding: WorkspaceBinding) =>
  Effect.gen(function* () {
    if (binding.placement._tag !== "Orb") return yield* rejected()
    return yield* Schema.decodeEffect(BoxWorkspaceInputPolicy)({
      workspaceId: binding.workspaceId,
      placement: binding.placement,
      buildId: binding.buildId,
      protocolVersion: binding.protocolVersion,
      checkout: row.checkout,
      seed:
        row.workspaceSeed === null
          ? null
          : {
              id: row.workspaceSeed.id,
              sourceRepository: row.workspaceSeed.sourceRepository,
              archiveDigest: row.workspaceSeed.archiveDigest,
              archiveSizeBytes: row.workspaceSeed.archiveSizeBytes,
            },
    }).pipe(Effect.mapError(rejected))
  })

const resolveRepository = <R>(
  options: BoxWorkspaceInputInitializerOptions<R>,
  checkout: RepositoryCheckout | null,
  policy: BoxWorkspaceInputPolicy["checkout"],
): Effect.Effect<Archive | null, ContextMaterializationError> =>
  Effect.gen(function* () {
    if (checkout === null || policy === null) return checkout === policy ? null : yield* rejected()
    const input = yield* options.capture(checkout).pipe(Effect.provide(options.platform), Effect.mapError(unavailable))
    if (
      input.metadata.source.owner !== policy.owner ||
      input.metadata.source.name !== policy.name ||
      input.metadata.commitSha !== policy.commitSha ||
      input.metadata.gitIdentity.name !== policy.gitIdentity.name ||
      input.metadata.gitIdentity.email !== policy.gitIdentity.email
    )
      return yield* rejected()
    return input.archive
  })

const resolveSeed = <R>(
  options: BoxWorkspaceInputInitializerOptions<R>,
  workspaceSeed: WorkspaceSeed | null,
  policy: BoxWorkspaceInputPolicy["seed"],
): Effect.Effect<Archive | null, ContextMaterializationError> =>
  Effect.gen(function* () {
    if (workspaceSeed === null || policy === null)
      return workspaceSeed === null && policy === null ? null : yield* rejected()
    const archive = yield* options.vault
      .load(
        workspaceSeed.id,
        StoredArchive.make({
          objectKey: workspaceSeed.objectKey,
          contentDigest: workspaceSeed.contentDigest,
          sizeBytes: workspaceSeed.sizeBytes,
          archiveDigest: workspaceSeed.archiveDigest,
          archiveSizeBytes: workspaceSeed.archiveSizeBytes,
          encryption: workspaceSeed.encryption,
        }),
      )
      .pipe(Effect.mapError(unavailable))
    if (archive.contentDigest !== policy.archiveDigest || archive.sizeBytes !== policy.archiveSizeBytes)
      return yield* rejected()
    return archive
  })

export const makeBoxWorkspaceInputInitializer = <R>(
  options: BoxWorkspaceInputInitializerOptions<R>,
): BoxWorkspaceInputInitializer => ({
  ensure: (row, boxId, binding) =>
    Effect.gen(function* () {
      const policy = yield* admittedPolicy(row, binding)
      const materialized = yield* options.client.inspect({ boxId, policy }).pipe(Effect.mapError(inputFailure))
      if (materialized) return
      const repository = yield* resolveRepository(options, row.checkout, policy.checkout)
      const seed = yield* resolveSeed(options, row.workspaceSeed, policy.seed)
      yield* options.client.materialize({ boxId, policy, repository, seed }).pipe(Effect.mapError(inputFailure))
    }),
})
