import { Context, Effect, Encoding, Schema } from "effect"
import { BoxId } from "@rika/box-executor"
import type { BoxWorkspaceInputClient } from "@rika/box-executor/workspace-input"
import { BoxWorkspaceInputError, type BoxWorkspaceInputPolicy } from "@rika/box-executor/workspace-input-contract"
import { WorkspaceBinding } from "@rika/execution"
import { RepositoryCheckout, WorkspaceSeed } from "@rika/product/executor-assignment"
import { BoxAssignmentProjection } from "@rika/product-store/box-assignments"
import { Archive, StoredArchive } from "@rika/workspace-input/contract"
import { RepositoryInput, RepositoryInputFormat } from "@rika/workspace-input/repository"
import type { WorkspaceSeedVaultError } from "@rika/workspace-input/vault"
import type { ProductControlError } from "../../src/product/control"
import { makeBoxWorkspaceInputInitializer } from "../../src/executor/box-workspace-input"

export const boxId = Schema.decodeSync(BoxId)("bx_abcdefgh")
export const assignmentId = (generation: number) =>
  `bxa_${Encoding.encodeBase64Url(JSON.stringify(["assignment", generation]))}`
export const binding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "workspace",
  assignmentId: assignmentId(1),
  generation: 1,
  placement: { _tag: "Orb", workspaceId: "workspace", lineageId: "lineage" },
  buildId: "build",
  protocolVersion: 1,
})
export const runnerBinding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "workspace",
  assignmentId: assignmentId(1),
  generation: 1,
  placement: { _tag: "Runner", checkoutFingerprint: "fingerprint", workspaceId: "workspace" },
  buildId: "build",
  protocolVersion: 1,
})
export const checkout = Schema.decodeSync(RepositoryCheckout)({
  ownerId: "owner",
  projectId: "project",
  repositoryId: "12345",
  installationId: "6789",
  owner: "acme",
  name: "widget",
  ref: "refs/heads/main",
  commitSha: "a".repeat(40),
  private: true,
  gitIdentity: { name: "Rika", email: "rika@example.com" },
})
export const workspaceSeed = Schema.decodeSync(WorkspaceSeed)({
  id: "seed-1",
  sourceRepository: { owner: "acme", name: "widget" },
  objectKey: "workspace-input/v1/workspace-seeds/seed-1/source.archive.aes",
  contentDigest: `sha256:${"1".repeat(64)}`,
  sizeBytes: 96,
  archiveDigest: `sha256:${"2".repeat(64)}`,
  archiveSizeBytes: 64,
  encryption: "aes-256-gcm",
})
export const seedArchive = Archive.make({
  bytes: new Uint8Array(64).fill(9),
  contentDigest: workspaceSeed.archiveDigest,
  sizeBytes: workspaceSeed.archiveSizeBytes,
})
export const repositoryInput = RepositoryInput.make({
  format: RepositoryInputFormat,
  metadata: {
    version: 1,
    source: { owner: checkout.owner, name: checkout.name },
    commitSha: checkout.commitSha,
    gitIdentity: checkout.gitIdentity,
  },
  archive: Archive.make({
    bytes: new Uint8Array([7, 7, 7]),
    contentDigest: `sha256:${"3".repeat(64)}`,
    sizeBytes: 3,
  }),
})

export const assignmentRow = (
  overrides: {
    readonly checkout?: RepositoryCheckout | null
    readonly workspaceSeed?: WorkspaceSeed | null
  } = {},
) =>
  Schema.decodeSync(BoxAssignmentProjection)({
    assignmentId: binding.assignmentId,
    ownerId: "owner",
    threadId: "thread",
    workspaceId: "workspace",
    generation: 1,
    lifecycle: "pending",
    providerInstanceId: null,
    checkout: null,
    workspaceSeed: null,
    placement: {
      _tag: "OrbPlacement",
      lineageId: "lineage",
      templateBuildId: "template",
      providerScope: "scope",
      executorPolicy: { buildId: "build", protocolVersion: 1 },
    },
    ...overrides,
  })

export interface WorkspaceInputHarnessBehavior {
  readonly inspect?: boolean
  readonly inspectError?: BoxWorkspaceInputError
  readonly materializeError?: BoxWorkspaceInputError
  readonly captureError?: ProductControlError
  readonly vaultError?: WorkspaceSeedVaultError
  readonly seedArchive?: Archive
  readonly repositoryInput?: RepositoryInput
}

export const workspaceInputHarness = (calls: Array<string>, behavior: WorkspaceInputHarnessBehavior = {}) => {
  const policies: Array<BoxWorkspaceInputPolicy> = []
  const materialized: Array<{ repository: Archive | null; seed: Archive | null }> = []
  const captured: Array<RepositoryCheckout> = []
  const loaded: Array<{ seedId: string; stored: StoredArchive }> = []
  const client: BoxWorkspaceInputClient = {
    inspect: (request) =>
      Effect.suspend(() => {
        calls.push("inspect")
        policies.push(request.policy)
        return behavior.inspectError !== undefined
          ? Effect.fail(behavior.inspectError)
          : Effect.succeed(behavior.inspect ?? false)
      }),
    materialize: (request) =>
      Effect.suspend(() => {
        calls.push("materialize")
        materialized.push({ repository: request.repository, seed: request.seed })
        return behavior.materializeError !== undefined
          ? Effect.fail(behavior.materializeError)
          : Effect.succeed({ version: 1, policyDigest: "0".repeat(64) })
      }),
  }
  const { ensure } = makeBoxWorkspaceInputInitializer({
    client,
    capture: (requested) =>
      Effect.suspend(() => {
        calls.push("capture")
        captured.push(requested)
        return behavior.captureError !== undefined
          ? Effect.fail(behavior.captureError)
          : Effect.succeed(behavior.repositoryInput ?? repositoryInput)
      }),
    vault: {
      load: (seedId, stored) =>
        Effect.suspend(() => {
          calls.push("vault")
          loaded.push({ seedId, stored })
          return behavior.vaultError !== undefined
            ? Effect.fail(behavior.vaultError)
            : Effect.succeed(behavior.seedArchive ?? seedArchive)
        }),
    },
    platform: Context.empty(),
  })
  return { ensure, calls, policies, materialized, captured, loaded }
}
