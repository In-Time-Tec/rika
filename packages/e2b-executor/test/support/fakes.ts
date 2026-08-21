import { Crypto, Effect, Layer, Option, Redacted } from "effect"
import { type ExecutorAssignment } from "@rika/product/executor-assignment"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import { CheckpointId, ExecutorAssignmentId, OwnerId, ThreadId, WorkspaceId } from "@rika/product/hosted-model"
import { layer as assignmentLayer } from "@rika/product-store/memory-assignments"
import { CheckpointError, Vault } from "../../src/checkpoint"
import { Credentials } from "../../src/checkout"
import { Controller, type ControllerError, type Options, layer as controllerLayer } from "../../src/controller"
import {
  Provider,
  ProviderError,
  type BootstrapRequest,
  type CreateRequest,
  type InventoryEntry,
} from "../../src/provider"

const digest = (_algorithm: string, data: Uint8Array) =>
  Effect.promise(() => globalThis.crypto.subtle.digest("SHA-256", data).then((value) => new Uint8Array(value)))

export interface FakeProviderState {
  readonly creates: Array<CreateRequest>
  readonly connects: Array<{ readonly sandboxId: string; readonly timeoutMillis: number }>
  readonly networks: Array<{ readonly sandboxId: string; readonly allowedEgress: ReadonlyArray<string> }>
  readonly pauses: Array<string>
  readonly kills: Array<string>
  readonly touches: Array<{ readonly sandboxId: string; readonly timeoutMillis: number }>
  readonly bootstraps: Array<BootstrapRequest>
  createFailure: boolean
  bootstrapFailure: boolean
  connectFailure: boolean
  pauseFailure: boolean
  killFailure: boolean
  inventory: Array<InventoryEntry>
}

export interface Harness {
  readonly provider: FakeProviderState
  readonly checkpointInspections: Array<string>
  checkpointInspection: { readonly contentDigest: string; readonly sizeBytes: number }
  readonly checkoutRequests: Array<{
    readonly installationId: string
    readonly owner: string
    readonly repository: string
    readonly ownerId: string
    readonly workspaceId: string
    readonly repositoryId: string
    readonly purpose: "git-read" | "github-read"
  }>
  layer: Layer.Layer<Controller | ExecutorAssignments, ControllerError>
}

const providerLayer = (state: FakeProviderState) =>
  Layer.succeed(
    Provider,
    Provider.of({
      create: (request) => {
        state.creates.push(request)
        return state.createFailure
          ? Effect.fail(ProviderError.make({ operation: "create", message: "create outcome unknown" }))
          : Effect.succeed({ sandboxId: `sandbox-${state.creates.length}`, state: "running" })
      },
      bootstrap: (request) => {
        state.bootstraps.push(request)
        return state.bootstrapFailure
          ? Effect.fail(ProviderError.make({ operation: "bootstrap", message: "bootstrap failed" }))
          : Effect.void
      },
      connect: (sandboxId, timeoutMillis) => {
        state.connects.push({ sandboxId, timeoutMillis })
        return state.connectFailure
          ? Effect.fail(ProviderError.make({ operation: "connect", message: "cold wake failed" }))
          : Effect.succeed({ sandboxId, state: "running" })
      },
      updateNetwork: (sandboxId, allowedEgress) => {
        state.networks.push({ sandboxId, allowedEgress })
        return Effect.void
      },
      pauseFilesystem: (sandboxId) => {
        state.pauses.push(sandboxId)
        return state.pauseFailure
          ? Effect.fail(ProviderError.make({ operation: "pause", message: "pause outcome unknown" }))
          : Effect.succeed(true)
      },
      kill: (sandboxId) => {
        state.kills.push(sandboxId)
        return state.killFailure
          ? Effect.fail(ProviderError.make({ operation: "kill", message: "kill failed" }))
          : Effect.succeed(true)
      },
      touch: (sandboxId, timeoutMillis) => {
        state.touches.push({ sandboxId, timeoutMillis })
        return Effect.void
      },
      inventory: Effect.sync(() => state.inventory),
    }),
  )

const cryptoLayer = () => {
  let next = 1
  return Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => Uint8Array.from({ length: size }, () => next++ & 255),
      digest,
    }),
  )
}

export const makeHarness = (overrides: Partial<Options> = {}): Harness => {
  const provider: FakeProviderState = {
    creates: [],
    connects: [],
    networks: [],
    pauses: [],
    kills: [],
    touches: [],
    bootstraps: [],
    createFailure: false,
    bootstrapFailure: false,
    connectFailure: false,
    pauseFailure: false,
    killFailure: false,
    inventory: [],
  }
  const checkpointInspections: Array<string> = []
  const harness: Harness = {
    provider,
    checkpointInspections,
    checkpointInspection: { contentDigest: `sha256:${"a".repeat(64)}`, sizeBytes: 42 },
    checkoutRequests: [],
    layer: undefined as never,
  }
  const broker = Layer.succeed(
    Credentials,
    Credentials.of({
      issue: (request) => {
        harness.checkoutRequests.push({
          installationId: request.checkout.installationId,
          owner: request.checkout.owner,
          repository: request.checkout.name,
          ownerId: request.ownerId,
          workspaceId: request.workspaceId,
          repositoryId: request.repositoryId,
          purpose: request.purpose,
        })
        return Effect.map(
          Effect.clockWith((clock) => clock.currentTimeMillis),
          (now) => ({
            repositoryUrl: `https://github.com/${request.checkout.owner}/${request.checkout.name}.git`,
            username: "x-access-token" as const,
            token: Redacted.make("ghs_actual_secret", { label: "github-installation-token" }),
            expiresAt: now + 30 * 60 * 1_000,
          }),
        )
      },
      revoke: () => Effect.void,
    }),
  )
  const checkpoints = new Map<
    string,
    { readonly content: string; readonly contentDigest: string; readonly sizeBytes: number }
  >()
  const caches = new Map<
    string,
    { readonly content: string; readonly contentDigest: string; readonly sizeBytes: number }
  >()
  const archive = (encoded: { readonly content: string; readonly contentDigest: string; readonly sizeBytes: number }) =>
    Effect.try({
      try: () => ({
        bytes: new Uint8Array(Buffer.from(encoded.content, "base64")),
        contentDigest: encoded.contentDigest,
        sizeBytes: encoded.sizeBytes,
      }),
      catch: () => CheckpointError.make({ kind: "corrupt", message: "invalid archive" }),
    })
  const vault = Layer.succeed(
    Vault,
    Vault.of({
      storeCheckpoint: (scope, encoded) => {
        checkpointInspections.push(scope.checkpointId)
        if (
          harness.checkpointInspection.contentDigest !== encoded.contentDigest ||
          harness.checkpointInspection.sizeBytes !== encoded.sizeBytes
        )
          return Effect.fail(CheckpointError.make({ kind: "corrupt", message: "archive metadata mismatch" }))
        const objectKey = `owners/owner/threads/thread/assignments/${scope.assignmentId}/g${scope.generation}/${scope.checkpointId}.tar.zst.aes`
        checkpoints.set(scope.checkpointId, encoded)
        return Effect.succeed({
          objectKey,
          contentDigest: encoded.contentDigest,
          sizeBytes: encoded.sizeBytes,
          archiveDigest: encoded.contentDigest,
          archiveSizeBytes: encoded.sizeBytes,
          encryption: "aes-256-gcm" as const,
        })
      },
      loadCheckpoint: (scope) =>
        Option.match(Option.fromNullishOr(checkpoints.get(scope.checkpointId)), {
          onNone: () => Effect.fail(CheckpointError.make({ kind: "missing", message: "checkpoint missing" })),
          onSome: archive,
        }),
      storeSetupCache: (key, encoded) => {
        const objectKey = JSON.stringify(key)
        caches.set(objectKey, encoded)
        return Effect.succeed({
          objectKey,
          contentDigest: encoded.contentDigest,
          sizeBytes: encoded.sizeBytes,
          archiveDigest: encoded.contentDigest,
          archiveSizeBytes: encoded.sizeBytes,
          encryption: "aes-256-gcm" as const,
        })
      },
      loadSetupCache: (key) =>
        Option.match(Option.fromNullishOr(caches.get(JSON.stringify(key))), {
          onNone: () => Effect.succeedNone,
          onSome: (encoded) => archive(encoded).pipe(Effect.map(Option.some)),
        }),
    }),
  )
  const dependencies = Layer.mergeAll(providerLayer(provider), cryptoLayer(), broker, vault)
  const controller = controllerLayer({
    appId: "rika",
    deploymentId: "test",
    templateId: "ar7-template-alias",
    templateBuildId: "template-build-v1-immutable",
    apiUrl: "wss://api.example.test/executors",
    controlEgress: ["api.example.test"],
    ...overrides,
  }).pipe(Layer.provide(dependencies), Layer.provide(assignmentLayer))
  harness.layer = Layer.merge(controller, assignmentLayer)
  return harness
}

export const assignmentInput = {
  id: ExecutorAssignmentId.make("assignment-1"),
  ownerId: OwnerId.make("owner-1"),
  threadId: ThreadId.make("thread-1"),
  workspaceId: WorkspaceId.make("workspace-1"),
  placement: {
    _tag: "E2BPlacement" as const,
    templateBuildId: "template-build-v1-immutable",
    providerScope: "test",
  },
  checkout: {
    ownerId: OwnerId.make("owner-1"),
    projectId: "project-1",
    repositoryId: "repository-1",
    owner: "In-Time-Tec",
    name: "rika",
    installationId: "installation-1",
    ref: "main",
    commitSha: "a".repeat(40),
    private: true,
    gitIdentity: { name: "Rika Test", email: "rika@example.test" },
  },
}

export const createAssignment = Effect.fn("test.createAssignment")(function* () {
  const repository = yield* ExecutorAssignments
  return yield* repository.create(assignmentInput)
})

export const readAssignment = Effect.fn("test.readAssignment")(function* () {
  const repository = yield* ExecutorAssignments
  return (yield* repository.get(assignmentInput.id)) as ExecutorAssignment
})

export const checkpointId = CheckpointId.make("checkpoint-1")
export const controller = Effect.map(Controller, (service) => service)
