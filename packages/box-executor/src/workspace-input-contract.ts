/* oxlint-disable effecttsgo/missing-pipeable-signature -- path derivation helpers are direct pure functions, not pipe stages. */
import { ExecutorBuildId, ExecutorProtocolVersion, OrbPlacement, WorkspaceIdentity } from "@rika/execution"
import { RepositoryCheckout, WorkspaceSeedRepository } from "@rika/product/executor-assignment"
import { Schema } from "effect"
import { Pins } from "generalist"

const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const Size = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 * 1024 * 1024 }))
export const workspaceInputChunkBytes = 512 * 1024
export const workspaceInputDirectory = "/home/user/.rika/workspace-input"
export const workspaceInputWorkspace = "/home/user/workspace"
export const workspaceInputReceiptRelativePath = ".rika/secrets/workspace-input.json"

export const BoxWorkspaceInputPolicy = Schema.Struct({
  workspaceId: WorkspaceIdentity,
  placement: OrbPlacement,
  buildId: ExecutorBuildId,
  protocolVersion: ExecutorProtocolVersion,
  checkout: Schema.NullOr(RepositoryCheckout),
  seed: Schema.NullOr(Schema.Struct({
    id: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
    sourceRepository: Schema.NullOr(WorkspaceSeedRepository),
    archiveDigest: Digest,
    archiveSizeBytes: Size,
  })),
})
export type BoxWorkspaceInputPolicy = typeof BoxWorkspaceInputPolicy.Type

export const BoxWorkspaceInputArchive = Schema.Struct({ contentDigest: Digest, sizeBytes: Size })
export type BoxWorkspaceInputArchive = typeof BoxWorkspaceInputArchive.Type
export const BoxWorkspaceInputDocument = Schema.TaggedStruct("Materialize", {
  version: Schema.Literal(1),
  policy: BoxWorkspaceInputPolicy,
  repository: Schema.NullOr(BoxWorkspaceInputArchive),
  seed: Schema.NullOr(BoxWorkspaceInputArchive),
})
export type BoxWorkspaceInputDocument = typeof BoxWorkspaceInputDocument.Type

export const BoxWorkspaceInputReceipt = Schema.Struct({
  version: Schema.Literal(1),
  policyDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
export type BoxWorkspaceInputReceipt = typeof BoxWorkspaceInputReceipt.Type

export class BoxWorkspaceInputError extends Schema.TaggedError<BoxWorkspaceInputError>()("BoxWorkspaceInputError", {
  reason: Schema.Literals(["policy", "archive", "transport", "process", "conflict"]),
  message: Schema.String,
}) {}

export const boxWorkspaceInputPaths = (policy: BoxWorkspaceInputPolicy, root = workspaceInputDirectory) => {
  const policyDigest = Pins.digest(policy)
  const directory = `${root}/${policyDigest}`
  return {
    directory,
    policyDigest,
    receipt: `${workspaceInputWorkspace}/${workspaceInputReceiptRelativePath}`,
    document: `${directory}/materialization.json`,
  }
}

export const boxWorkspaceInputPartPath = (input: {
  readonly policy: BoxWorkspaceInputPolicy
  readonly source: "repository" | "seed"
  readonly part: number
  readonly directory?: string
}) => `${boxWorkspaceInputPaths(input.policy, input.directory).directory}/${input.source}.${String(input.part).padStart(4, "0")}`
