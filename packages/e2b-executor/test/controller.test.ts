import { describe, expect, it } from "@effect/vitest"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import { ExecutorInstanceId } from "@rika/product/hosted-model"
import type { Access } from "@rika/remote-execution/protocol"
import { Effect, Inspectable, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Vault } from "../src/checkpoint"
import * as Controller from "../src/controller"
import { assignmentInput, controller, createAssignment, makeHarness, readAssignment } from "./support/fakes"
import { provideLayer } from "./support/layer"

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const setupEgress = { phase: "setup", allow: ["github.com"] } as const
const runtimeEgress = { phase: "runtime", allow: ["api.github.com"] } as const
const environmentDigest = `sha256:${"1".repeat(64)}`
const workspaceCapabilities = {
  environmentDigest,
  capturedAt: "2026-08-21T00:00:00.000Z",
  filesystem: { _tag: "Ready" as const, detail: "workspace filesystem available" },
  typescriptKernel: { _tag: "Ready" as const, detail: "persistent Bun TypeScript kernel available" },
  git: { _tag: "Ready" as const, detail: "Git executable available" },
  process: { _tag: "Ready" as const, detail: "Bun process operations available" },
  pty: { _tag: "Unavailable" as const, reason: "durable PTY is unavailable" },
  browser: { _tag: "Unavailable" as const, reason: "browser executable is unavailable" },
  services: { _tag: "Ready" as const, detail: "supervised repository services available" },
  workspaceLifecycle: { _tag: "Ready" as const, detail: "workspace lifecycle ready" },
}
const setupAuthorization = { egress: setupEgress, environmentDigest }
const runtimeAuthorization = { egress: runtimeEgress, environmentDigest }
const archive = {
  content: btoa("x".repeat(42)),
  contentDigest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 42,
}

const quiescence = (access: Access) => ({
  access,
  operations: [],
  checkpoint: {
    version: 1 as const,
    checkpointId: "checkpoint-pause",
    archive,
    cursor: { sequence: 0, value: "" },
  },
})

const provision = Effect.fn("test.provision")(function* () {
  const service = yield* controller
  const assignment = yield* createAssignment()
  return yield* service.provision(assignment.id, setupAuthorization)
})

const authenticate = Effect.fn("test.authenticate")(function* (
  harness: ReturnType<typeof makeHarness>,
  generation: number,
) {
  const service = yield* controller
  const request = harness.provider.bootstraps.findLast((bootstrap) => bootstrap.sandboxId === `sandbox-${generation}`)!
  const fence = {
    target: "orb" as const,
    assignmentId: assignmentInput.id,
    assignmentGeneration: generation,
    instanceId: `sandbox-${generation}`,
    executorId: `${assignmentInput.id}:g${generation}:process-${generation}`,
    processIncarnation: `process-${generation}`,
  }
  const welcome = yield* service.hello({
    minimumVersion: 1,
    maximumVersion: 1,
    fence,
    templateBuildId: "template-build-v1-immutable",
    capabilities: { cells: true, checkpoints: true, pty: true },
    workspaceCapabilities,
    cursors: { command: 0, event: 0, pty: 0 },
    latestCheckpointId: null,
    bootstrapToken: request.credential,
  })
  const access: Access = {
    version: 1,
    fence,
    leaseEpoch: welcome.leaseEpoch,
    sessionToken: welcome.sessionToken,
  }
  return { welcome, access }
})

describe("Controller", () => {
  it.effect("provisions an explicit assignment from one immutable build with scoped bootstrap identity", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* createAssignment()
      const first = yield* service.provision(assignmentInput.id, setupAuthorization)
      const second = yield* service.provision(assignmentInput.id, setupAuthorization)
      expect(first).toEqual(second)
      expect(first).toMatchObject({
        assignmentId: "assignment-1",
        threadId: "thread-1",
        generation: 1,
        templateBuildId: "template-build-v1-immutable",
        sandboxId: "sandbox-1",
        state: "provisioning",
      })
      expect(harness.provider.creates).toHaveLength(1)
      expect(harness.provider.creates[0]).toMatchObject({
        templateId: "ar7-template-alias",
        templateBuildId: "template-build-v1-immutable",
        assignmentId: "assignment-1",
        threadId: "thread-1",
        generation: 1,
        idleTimeoutMillis: Controller.IdleTimeoutMillis,
        environment: {
          RIKA_EXECUTOR_TARGET: "orb",
          RIKA_EXECUTOR_ID: "assignment-1:g1",
          RIKA_EXECUTOR_TEMPLATE_BUILD_ID: "template-build-v1-immutable",
          RIKA_EXECUTOR_WORKSPACE_ID: "workspace-1",
        },
      })
      expect(Object.keys(harness.provider.creates[0]!.environment).toSorted()).toEqual([
        "RIKA_CHECKPOINT_OBJECT_PREFIX",
        "RIKA_EXECUTOR_API_URL",
        "RIKA_EXECUTOR_ASSIGNMENT_ID",
        "RIKA_EXECUTOR_COMMIT_SHA",
        "RIKA_EXECUTOR_ENVIRONMENT_DIGEST",
        "RIKA_EXECUTOR_GENERATION",
        "RIKA_EXECUTOR_ID",
        "RIKA_EXECUTOR_OWNER_ID",
        "RIKA_EXECUTOR_REPOSITORY_ID",
        "RIKA_EXECUTOR_REPOSITORY_NAME",
        "RIKA_EXECUTOR_REPOSITORY_OWNER",
        "RIKA_EXECUTOR_SETUP_CACHE",
        "RIKA_EXECUTOR_TARGET",
        "RIKA_EXECUTOR_TEMPLATE_BUILD_ID",
        "RIKA_EXECUTOR_THREAD_ID",
        "RIKA_EXECUTOR_WORKSPACE_ID",
      ])
      const bootstrapRequest = harness.provider.bootstraps[0]!
      expect(bootstrapRequest.identity).toEqual({
        target: "orb",
        ownerId: "owner-1",
        threadId: "thread-1",
        assignmentId: "assignment-1",
        assignmentGeneration: 1,
        instanceId: "sandbox-1",
        executorId: "assignment-1:g1",
        templateBuildId: "template-build-v1-immutable",
        apiUrl: "wss://api.example.test/executors",
        workspaceId: "workspace-1",
        repository: {
          repositoryId: "repository-1",
          owner: "In-Time-Tec",
          name: "rika",
          commitSha: "a".repeat(40),
        },
        lifecycle: "fresh",
        environmentDigest,
        setupCache: false,
      })
      expect(bootstrapRequest.restore).toBeNull()
      expect(bootstrapRequest.seed).toBeNull()
      const bootstrap = bootstrapRequest.credential
      expect(Inspectable.toStringUnknown(bootstrap)).toBe('"<redacted:executor-bootstrap>"')
      expect(json(first)).not.toContain(Redacted.value(bootstrap))
      expect((yield* readAssignment()).lifecycle).toMatchObject({ _tag: "AwaitingBootstrap" })
      expect(json(yield* readAssignment())).not.toContain(Redacted.value(bootstrap))
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("loads the local seed for a fresh Orb and prefers its checkpoint on replacement", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      const vault = yield* Vault
      const assignments = yield* ExecutorAssignments
      const stored = yield* vault.storeWorkspaceSeed("seed-1", archive)
      yield* assignments.create({
        ...assignmentInput,
        workspaceSeed: {
          id: "seed-1",
          sourceRepository: { owner: "In-Time-Tec", name: "rika" },
          ...stored,
        },
      })

      yield* service.provision(assignmentInput.id, setupAuthorization)

      expect(harness.provider.bootstraps[0]).toMatchObject({
        identity: { lifecycle: "fresh" },
        seed: { seedId: "seed-1", archive },
        restore: null,
      })
      const first = yield* authenticate(harness, 1)
      yield* service.checkpoint(first.access, {
        version: 1,
        checkpointId: "checkpoint-seeded",
        archive,
        cursor: { sequence: 0, value: "" },
      })
      yield* service.replace({ assignmentId: "assignment-1", generation: 1 }, runtimeAuthorization)
      expect(harness.provider.bootstraps[1]).toMatchObject({
        identity: { lifecycle: "replacement" },
        seed: null,
        restore: { checkpointId: "checkpoint-seeded", archive },
      })
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("advances generation and atomically adopts the approved build before provisioning", () => {
    const harness = makeHarness({ templateBuildId: "approved-build" })
    return Effect.gen(function* () {
      const service = yield* controller
      yield* createAssignment()
      expect(yield* service.provision(assignmentInput.id, setupAuthorization)).toMatchObject({
        generation: 2,
        sandboxId: "sandbox-1",
        templateBuildId: "approved-build",
      })
      expect(yield* readAssignment()).toMatchObject({
        generation: "2",
        placement: { _tag: "OrbPlacement", templateBuildId: "approved-build", providerScope: "test" },
        lifecycle: { _tag: "AwaitingBootstrap", providerInstanceId: "sandbox-1" },
      })
      expect(harness.provider.creates).toHaveLength(1)
      expect(harness.provider.creates[0]).toMatchObject({ templateBuildId: "approved-build", generation: 2 })
      expect(harness.provider.bootstraps[0]).toMatchObject({
        identity: { assignmentGeneration: 2, templateBuildId: "approved-build", lifecycle: "replacement" },
      })
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("never reconnects an active old-build sandbox and replaces it with the approved exact build", () => {
    const harness = makeHarness({ templateBuildId: "approved-build" })
    return Effect.gen(function* () {
      const assignments = yield* ExecutorAssignments
      const assignment = yield* createAssignment()
      const provisioning = yield* assignments.beginProvisioning({
        assignmentId: assignment.id,
        generation: assignment.generation,
        revision: assignment.revision,
        bootstrapCredentialDigest: Redacted.make("old-bootstrap"),
        bootstrapLifetimeMillis: 60_000,
      })
      const bound = yield* assignments.bindProviderInstance({
        assignmentId: provisioning.id,
        generation: provisioning.generation,
        revision: provisioning.revision,
        providerInstanceId: "sandbox-old-build",
      })
      yield* assignments.openSession({
        assignmentId: bound.id,
        generation: bound.generation,
        revision: bound.revision,
        providerInstanceId: "sandbox-old-build",
        executorInstanceId: ExecutorInstanceId.make("executor-old-build"),
        processIncarnation: "process-old-build",
        capabilities: workspaceCapabilities,
        presentedBootstrapCredentialDigest: Redacted.make("old-bootstrap"),
        sessionCredentialDigest: Redacted.make("old-session"),
        leaseLifetimeMillis: 60_000,
      })

      const service = yield* controller
      expect(yield* service.provision(assignment.id, runtimeAuthorization)).toMatchObject({
        generation: 2,
        sandboxId: "sandbox-1",
        templateBuildId: "approved-build",
      })
      expect(harness.provider.connects).toEqual([])
      expect(yield* readAssignment()).toMatchObject({
        generation: "2",
        placement: { _tag: "OrbPlacement", templateBuildId: "approved-build", providerScope: "test" },
      })
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("uses filesystem pause, demand provisioning resume, lease renewal, and kill", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const first = yield* authenticate(harness, 1)
      expect((yield* service.provision("assignment-1", runtimeAuthorization)).state).toBe("running")
      expect(
        (yield* service.pause({ assignmentId: "assignment-1", generation: 1 }, quiescence(first.access))).state,
      ).toBe("paused")
      expect((yield* service.provision("assignment-1", runtimeAuthorization)).state).toBe("provisioning")
      expect(
        (yield* Effect.flip(
          service.heartbeat({ version: 1, access: first.access, cursor: { sequence: 1, value: "stale" } }),
        )).kind,
      ).toBe("fenced")
      const { access } = yield* authenticate(harness, 1)
      const receipt = yield* service.heartbeat({
        version: 1,
        access,
        cursor: { sequence: 1, value: "executor:1" },
      })
      expect(receipt.cursor).toEqual({ sequence: 1, value: "executor:1" })
      expect(harness.provider.pauses).toEqual(["sandbox-1"])
      expect(harness.provider.connects).toEqual([
        { sandboxId: "sandbox-1", timeoutMillis: Controller.IdleTimeoutMillis },
        { sandboxId: "sandbox-1", timeoutMillis: Controller.IdleTimeoutMillis },
      ])
      expect(harness.provider.touches).toEqual([
        { sandboxId: "sandbox-1", timeoutMillis: Controller.IdleTimeoutMillis },
      ])
      expect((yield* service.kill({ assignmentId: "assignment-1", generation: 1 })).state).toBe("terminated")
      expect(harness.provider.kills).toEqual(["sandbox-1"])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("replaces an active sandbox whose authoritative lease expired", () => {
    const harness = makeHarness({ leaseLifetimeMillis: 60_000 })
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      yield* authenticate(harness, 1)
      yield* TestClock.adjust("1 minute")

      expect(yield* service.provision("assignment-1", runtimeAuthorization)).toMatchObject({
        assignmentId: "assignment-1",
        generation: 2,
        sandboxId: "sandbox-2",
        state: "provisioning",
      })
      expect(yield* readAssignment()).toMatchObject({
        generation: "2",
        lifecycle: { _tag: "AwaitingBootstrap", providerInstanceId: "sandbox-2" },
      })
      expect(harness.provider.creates).toHaveLength(2)
      expect(harness.provider.connects).toEqual([])
      expect(harness.provider.bootstraps[1]).toMatchObject({
        sandboxId: "sandbox-2",
        identity: { assignmentGeneration: 2, lifecycle: "replacement" },
      })
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("switches an authenticated sandbox from setup to separately authorized runtime egress", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const { access } = yield* authenticate(harness, 1)
      yield* service.activatePhase(access, runtimeEgress)
      expect(harness.provider.networks).toEqual([
        {
          sandboxId: "sandbox-1",
          allowedEgress: ["api.example.test", "api.github.com"],
        },
      ])
      expect(
        (yield* Effect.flip(service.activatePhase(access, { phase: "runtime", allow: ["169.254.169.254"] }))).kind,
      ).toBe("protocol")
      expect(harness.provider.networks).toHaveLength(1)
    }).pipe(provideLayer(harness.layer))
  })
})
