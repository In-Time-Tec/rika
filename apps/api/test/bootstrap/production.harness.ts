import type { ExecutorPolicy } from "@rika/product/executor-policy"
import type { HostedClientAuthorityService } from "@rika/product/hosted-client-authority"
import { BetterAuthUserId } from "@rika/product/hosted-model"
import type { BoxAssignmentRepository } from "@rika/product-store/box-assignments"
import type { ProviderCredentialOperations } from "@rika/product-store/provider-credentials"
import type { OwnerAuthority, ProductRepositoryService } from "@rika/product-store/product-repository"
import type { RunnerRegistrationsService } from "@rika/product-store/runner-registrations"
import { ExecutorTransportError, WorkspaceBinding, type WorkspaceExecutorService } from "@rika/execution"
import { Crypto, Effect, Redacted, Schema } from "effect"
import type { ApiV2ProductionConfig } from "../../src/bootstrap/config"
import type { ApiV2ProductionDependencies, ApiV2ProductionServices } from "../../src/bootstrap/production"
import { threadPartition, type ThreadExecutionBinding } from "../../src/runtime/partition"

export interface ProductionHarnessState {
  contextAllocations: number
  contextWorkspaces: WorkspaceExecutorService[]
  orbAllocations: number
  orbWorkspaces: WorkspaceExecutorService[]
  repositoryReads: number
  createdThreads: string[]
  runnerBindingReads: number
}

const runnerPartition = threadPartition({
  environment: "test",
  ownerId: "owner",
  threadId: "runner-thread",
  target: "runner",
})

const runnerWorkspaceBinding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "runner-workspace",
  assignmentId: "runner-assignment",
  generation: 1,
  placement: { _tag: "Runner", workspaceId: "runner-workspace", checkoutFingerprint: "checkout" },
  buildId: "executor-build",
  protocolVersion: 2,
})

export const runnerBinding: ThreadExecutionBinding = {
  partition: runnerPartition,
  placement: runnerWorkspaceBinding.placement,
  workspaceBinding: runnerWorkspaceBinding,
}

const orbPartition = threadPartition({
  environment: "test",
  ownerId: "owner",
  threadId: "orb-thread",
  target: "orb",
})

const orbWorkspaceBinding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "orb-workspace",
  assignmentId: "orb-assignment",
  generation: 1,
  placement: { _tag: "Orb", workspaceId: "orb-workspace", lineageId: "lineage" },
  buildId: "executor-build",
  protocolVersion: 2,
})

export const orbBinding: ThreadExecutionBinding = {
  partition: orbPartition,
  placement: orbWorkspaceBinding.placement,
  workspaceBinding: orbWorkspaceBinding,
}

export const productionConfig: ApiV2ProductionConfig = {
  identity: {
    production: false,
    port: 3300,
    baseUrl: "http://127.0.0.1:3300",
    trustedOrigins: ["http://127.0.0.1:3300"],
    authSecret: Redacted.make("abcdefghijklmnoPQRSTUVWXYZ0123456789"),
    databaseUrl: Redacted.make("postgresql://rika:rika@127.0.0.1:5432/rika"),
    databaseSsl: "disable",
    resource: "http://127.0.0.1:3300/api/v1",
  },
  environment: "test",
  revision: "test-revision",
  hostname: "127.0.0.1",
  port: 3300,
  runtimeStorage: { bucket: "runtime", region: "us-east-1" },
  rivet: { endpoint: "http://127.0.0.1:6420", namespace: "test" },
}

const none = <A>(): Effect.Effect<A | undefined> => Effect.as(Effect.void, undefined)
const unused = () => Effect.die("Unexpected production bootstrap fixture call")

const workspace = (binding: WorkspaceBinding): WorkspaceExecutorService => {
  const unavailable = Effect.fail(
    ExecutorTransportError.make({ phase: "connection", message: "Fixture executor is not connected" }),
  )
  return {
    binding,
    handshake: () => unavailable,
    dispatch: () => unavailable,
    receipt: () => unavailable,
    cancel: () => unavailable,
  }
}

const ownerAuthority: OwnerAuthority = {
  ownerId: "owner",
  owner: { _tag: "PersonalOwner", userId: BetterAuthUserId.make("user") },
  userId: "user",
}

const product = (state: ProductionHarnessState): ProductRepositoryService => ({
  stageWorkspaceSeed: unused,
  resolveOwner: () => Effect.succeed(ownerAuthority),
  organizationIds: () => Effect.succeed([]),
  projects: () => Effect.succeed([]),
  projectAccess: () => none(),
  createProject: unused,
  existingConnection: () => none(),
  createConnection: (input) =>
    Effect.sync(() => {
      state.createdThreads.push(input.threadId)
      return { _tag: "Created" as const, threadId: input.threadId }
    }),
  threadAuthority: (_userId, threadId) =>
    Effect.succeed({
      ownerId: "owner",
      kind: "personal",
      userId: "user",
      organizationId: null,
      membershipId: null,
      createdByUserId: "user",
      executorKind: threadId === "runner-thread" ? "runner" : "orb",
      inheritProjectGrants: false,
      threadRole: null,
      projectRole: null,
    }),
  threadAuthorities: () => Effect.succeed([]),
  personalOwnerId: () => Effect.succeed("owner"),
  threadMetadataList: () =>
    Effect.succeed({
      threads: [
        {
          id: "metadata-thread",
          title: "Metadata Thread",
          target: "orb",
          updatedAt: 1_788_940_800_000,
          pinned: false,
        },
      ],
    }),
  threadMetadata: () => none(),
  archiveThread: unused,
  threadExecutionContext: (_ownerId, threadId) =>
    Effect.sync(() => {
      state.runnerBindingReads += 1
      return threadId === "runner-thread"
        ? {
            assignmentId: "runner-assignment",
            workspaceId: "runner-workspace",
            title: "Runner Thread",
            hasTurns: false,
            executorKind: "runner" as const,
            generation: "1",
            lifecycle: "pending",
            executorInstanceId: null,
            providerInstanceId: null,
            checkout: null,
            localRepository: null,
            placement: {
              _tag: "RunnerPlacement",
              deviceId: "device",
              requestingDeviceId: "device",
              checkoutFingerprint: "checkout",
              executorPolicy: { buildId: "executor-build", protocolVersion: 2 },
            },
          }
        : undefined
    }),
  ready: Effect.void,
})

const clientAuthority: HostedClientAuthorityService = {
  registerDevice: (input) =>
    Effect.succeed({
      id: input.id,
      userId: input.userId,
      displayName: input.displayName,
      publicKeyFingerprint: input.publicKeyFingerprint,
      createdAt: input.now,
      lastSeenAt: input.now,
      revokedAt: null,
    }),
  authenticateClient: (input) =>
    Effect.succeed({
      id: input.id,
      userId: input.userId,
      deviceId: input.deviceId,
      authenticatedAt: input.now,
      lastSeenAt: input.now,
      expiresAt: input.expiresAt,
      revokedAt: null,
    }),
  grantClientAuthority: () => Effect.void,
  findThread: () => none(),
  readThread: () => none(),
  authorizeThread: () => Effect.void,
}

const runners: RunnerRegistrationsService = {
  upsert: () => Effect.succeed("stored"),
  setRemoteThreadCreation: () => Effect.succeed(true),
  claimSupervisorAndPoll: unused,
}

const boxAssignments: BoxAssignmentRepository = {
  get: unused,
  bind: unused,
  rotate: unused,
}

const providerCredentials: ProviderCredentialOperations = {
  authorizedOwnerId: unused,
  credentialByOwner: unused,
  credentialByIdentity: unused,
  listCredentials: unused,
  putCredential: unused,
  revokeCredential: unused,
  openAiAccountByOwner: unused,
  openAiAccountByIdentity: unused,
  putOpenAiAccount: unused,
  saveOpenAiAccount: unused,
  revokeOpenAiAccountByOwner: unused,
  revokeOpenAiAccountByIdentity: unused,
  serializedOpenAiAccount: unused,
}

export const makeProductionHarness = () => {
  const state: ProductionHarnessState = {
    contextAllocations: 0,
    contextWorkspaces: [],
    orbAllocations: 0,
    orbWorkspaces: [],
    repositoryReads: 0,
    createdThreads: [],
    runnerBindingReads: 0,
  }
  const services: ApiV2ProductionServices = {
    identity: {
      identify: () =>
        Effect.succeed({
          userId: "user",
          clientId: "client",
          dpopJkt: "dpop-thumbprint",
          expiresAt: 9_000_000_000_000,
        }),
      handle: () => Effect.succeed(new Response(null, { status: 404 })),
      browserSession: () => none(),
      protectedResourceMetadata: Effect.succeed({}),
    },
    directory: {
      ready: Effect.void,
      account: () =>
        Effect.succeed({
          user: { id: "user", name: "User", email: "user@example.com", emailVerified: true, image: null },
          memberships: [],
        }),
    },
    devices: {
      register: unused,
      discard: unused,
      authenticate: () => Effect.succeed("device"),
      list: () => Effect.succeed([]),
      revoke: () => Effect.succeed(false),
      revokeAll: () => Effect.void,
    },
    product: product(state),
    clientAuthority,
    runners,
    boxAssignments,
    providerCredentials,
    repositoryBindings: { loadBinding: unused },
    crypto: Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: (_algorithm, bytes) => Effect.succeed(bytes),
    }),
  }
  const executorPolicy = { buildId: "executor-build", protocolVersion: 2 } satisfies ExecutorPolicy
  const dependencies: ApiV2ProductionDependencies = {
    workspaceSeeds: { stage: unused },
    context: (input) => {
      state.contextAllocations += 1
      state.contextWorkspaces.push(input.workspace)
      return Effect.die("Context allocation is outside this bootstrap test")
    },
    orbWorkspace: (binding) =>
      Effect.sync(() => {
        state.orbAllocations += 1
        const resolved = workspace(binding.workspaceBinding)
        state.orbWorkspaces.push(resolved)
        return resolved
      }),
    boxGateway: {
      bindingForThread: unused,
      connect: unused,
      executor: workspace,
      ready: () => none(),
    },
    executorPolicy,
    repositories: {
      resolve: () =>
        Effect.sync(() => {
          state.repositoryReads += 1
          return null
        }),
    },
    productPlacement: { templateBuildId: "template-build", providerScope: "box" },
  }
  return { state, services, dependencies }
}
