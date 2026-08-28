import { Crypto, Deferred, Effect, Layer, Option, Redacted } from "effect"
import { AssignmentError, ExecutorAssignments } from "@rika/product/executor-assignments"
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
  Effect.tryPromise(() => globalThis.crypto.subtle.digest("SHA-256", data)).pipe(
    Effect.map((value) => new Uint8Array(value)),
    Effect.orDie,
  )

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
  readonly connectFailures: Set<string>
  pauseFailure: boolean
  killFailure: boolean
  killResult: boolean
  killGate: Deferred.Deferred<void> | null
  readonly killStarted: Deferred.Deferred<void>
  inventory: Array<InventoryEntry>
}

export interface Harness {
  readonly provider: FakeProviderState
  readonly checkpointInspections: Array<string>
  checkpointInspection: { readonly contentDigest: string; readonly sizeBytes: number }
  checkpointLoadFailure: CheckpointError | null
  checkpointCommitFailures: number
  checkpointCommitAttempts: number
  bindResponseFailures: number
  failReadAfterBind: boolean
  assignmentReadFailures: number
  readonly checkoutRequests: Array<{
    readonly installationId: string
    readonly owner: string
    readonly repository: string
    readonly ownerId: string
    readonly workspaceId: string
    readonly repositoryId: string
    readonly purpose: "git-read" | "github-read" | "branch-push"
  }>
  layer: Layer.Layer<Controller | ExecutorAssignments | Vault, ControllerError>
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
        return state.connectFailure || state.connectFailures.has(sandboxId)
          ? Effect.fail(ProviderError.make({ operation: "connect", message: "cold wake failed" }))
          : Effect.succeed({ sandboxId, state: "running" })
      },
      host: (sandboxId, port) => Effect.succeed(`${port}-${sandboxId}.e2b.app`),
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
        Deferred.doneUnsafe(state.killStarted, Effect.void)
        return (state.killGate === null ? Effect.void : Deferred.await(state.killGate)).pipe(
          Effect.andThen(
            state.killFailure
              ? Effect.fail(ProviderError.make({ operation: "kill", message: "kill failed" }))
              : Effect.succeed(state.killResult),
          ),
        )
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
    connectFailures: new Set(),
    pauseFailure: false,
    killFailure: false,
    killResult: true,
    killGate: null,
    killStarted: Deferred.makeUnsafe<void>(),
    inventory: [],
  }
  const checkpointInspections: Array<string> = []
  let layer: Harness["layer"]
  const harness: Harness = {
    provider,
    checkpointInspections,
    checkpointInspection: { contentDigest: `sha256:${"a".repeat(64)}`, sizeBytes: 42 },
    checkpointLoadFailure: null,
    checkpointCommitFailures: 0,
    checkpointCommitAttempts: 0,
    bindResponseFailures: 0,
    failReadAfterBind: false,
    assignmentReadFailures: 0,
    checkoutRequests: [],
    get layer() {
      return layer
    },
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
  const seeds = new Map<
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
      storeWorkspaceSeed: (seedId, encoded) => {
        seeds.set(seedId, encoded)
        return Effect.succeed({
          objectKey: `workspace-seeds/${seedId}/source.tar.zst.aes`,
          contentDigest: encoded.contentDigest,
          sizeBytes: encoded.sizeBytes,
          archiveDigest: encoded.contentDigest,
          archiveSizeBytes: encoded.sizeBytes,
          encryption: "aes-256-gcm" as const,
        })
      },
      loadWorkspaceSeed: (seedId) =>
        Option.match(Option.fromNullishOr(seeds.get(seedId)), {
          onNone: () => Effect.fail(CheckpointError.make({ kind: "missing", message: "Workspace seed missing" })),
          onSome: archive,
        }),
      removeWorkspaceSeed: (seedId) => Effect.sync(() => void seeds.delete(seedId)),
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
        harness.checkpointLoadFailure === null
          ? Option.match(Option.fromNullishOr(checkpoints.get(scope.checkpointId)), {
              onNone: () => Effect.fail(CheckpointError.make({ kind: "missing", message: "checkpoint missing" })),
              onSome: archive,
            })
          : Effect.fail(harness.checkpointLoadFailure),
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
  const assignments = Layer.effect(
    ExecutorAssignments,
    ExecutorAssignments.pipe(
      Effect.map((repository) =>
        ExecutorAssignments.of({
          ...repository,
          get: (assignmentId) =>
            Effect.suspend(() => {
              if (harness.assignmentReadFailures === 0) return repository.get(assignmentId)
              harness.assignmentReadFailures -= 1
              return Effect.fail(AssignmentError.make({ reason: "database", message: "assignment read failed" }))
            }),
          bindProviderInstance: (input) =>
            repository.bindProviderInstance(input).pipe(
              Effect.flatMap((assignment) => {
                if (harness.bindResponseFailures === 0) return Effect.succeed(assignment)
                harness.bindResponseFailures -= 1
                if (harness.failReadAfterBind) harness.assignmentReadFailures += 1
                return Effect.fail(AssignmentError.make({ reason: "database", message: "bind response lost" }))
              }),
            ),
          commitCheckpoint: (input) =>
            Effect.suspend(() => {
              harness.checkpointCommitAttempts += 1
              if (harness.checkpointCommitFailures === 0) return repository.commitCheckpoint(input)
              harness.checkpointCommitFailures -= 1
              return Effect.fail(
                AssignmentError.make({ reason: "database", message: "checkpoint manifest commit failed" }),
              )
            }),
        }),
      ),
    ),
  ).pipe(Layer.provide(assignmentLayer))
  const controller = controllerLayer({
    appId: "rika",
    deploymentId: "test",
    templateId: "ar7-template-alias",
    templateBuildId: "template-build-v1-immutable",
    apiUrl: "wss://api.example.test/executors",
    controlEgress: ["api.example.test"],
    ...overrides,
  }).pipe(Layer.provide(dependencies), Layer.provide(assignments))
  layer = Layer.mergeAll(controller, assignments, vault)
  return harness
}

export const assignmentInput = {
  id: ExecutorAssignmentId.make("assignment-1"),
  ownerId: OwnerId.make("owner-1"),
  threadId: ThreadId.make("thread-1"),
  workspaceId: WorkspaceId.make("workspace-1"),
  placement: {
    _tag: "OrbPlacement" as const,
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
  const assignment = yield* repository.get(assignmentInput.id)
  if (assignment === undefined) return yield* Effect.die("assignment not found")
  return assignment
})

export const checkpointId = CheckpointId.make("checkpoint-1")
export const controller = Effect.map(Controller, (service) => service)
