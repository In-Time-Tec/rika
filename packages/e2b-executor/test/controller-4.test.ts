import { describe, expect, it } from "@effect/vitest"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import type { Access } from "@rika/remote-execution/protocol"
import { Deferred, Effect, Fiber, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { assignmentInput, controller, createAssignment, makeHarness, readAssignment } from "./support/fakes"
import { provideLayer } from "./support/layer"

const setupEgress = { phase: "setup", allow: ["github.com"] } as const
const runtimeEgress = { phase: "runtime", allow: ["api.github.com"] } as const
const environmentDigest = `sha256:${"1".repeat(64)}`
const workspaceCapabilities = {
  environmentDigest,
  capturedAt: "2026-08-21T00:00:00.000Z",
  filesystem: { _tag: "Ready" as const, detail: "workspace filesystem available" },
  nativeTools: { _tag: "Ready" as const, detail: "native Workspace tools available" },
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
    capabilities: { nativeTools: true, checkpoints: true, pty: true },
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
  it.effect("does not reconcile an unknown create outcome against a different template", () => {
    const harness = makeHarness()
    harness.provider.createFailure = true
    harness.provider.inventory = [
      {
        sandboxId: "sandbox-wrong-template",
        state: "running",
        templateId: "different-template",
        templateBuildId: "template-build-v1-immutable",
        metadata: {
          "rika.managed": "e2b-executor",
          "rika.app-id": "rika",
          "rika.deployment-id": "test",
          "rika.assignment-id": "assignment-1",
          "rika.generation": "1",
        },
      },
    ]
    return Effect.gen(function* () {
      const service = yield* controller
      yield* createAssignment()
      const error = yield* Effect.flip(service.provision("assignment-1", setupAuthorization))
      expect(error.kind).toBe("provider")
      expect(error.message).toBe("create outcome is unknown and no sandbox exists: create outcome unknown")
      expect(harness.provider.bootstraps).toEqual([])
      expect(harness.provider.kills).toEqual([])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("preserves app-owned inventory without durable assignment authority", () => {
    const harness = makeHarness()
    harness.provider.inventory = [
      {
        sandboxId: "sandbox-1",
        state: "running",
        templateId: "ar7-template-alias",
        templateBuildId: "template-build-v1-immutable",
        metadata: { "rika.managed": "e2b-executor", "rika.app-id": "rika", "rika.deployment-id": "test" },
      },
      {
        sandboxId: "sandbox-orphan",
        state: "paused",
        templateId: "ar7-template-alias",
        templateBuildId: "template-build-v1-immutable",
        metadata: { "rika.managed": "e2b-executor", "rika.app-id": "rika", "rika.deployment-id": "test" },
      },
      {
        sandboxId: "sandbox-malformed",
        state: "running",
        templateId: "ar7-template-alias",
        templateBuildId: "template-build-v1-immutable",
        metadata: {
          "rika.managed": "e2b-executor",
          "rika.app-id": "rika",
          "rika.deployment-id": "test",
          "rika.assignment-id": "assignment-unknown",
          "rika.generation": "not-a-generation",
        },
      },
      {
        sandboxId: "sandbox-other-app",
        state: "running",
        templateId: "ar7-template-alias",
        templateBuildId: "template-build-v1-immutable",
        metadata: { "rika.managed": "e2b-executor", "rika.app-id": "other", "rika.deployment-id": "test" },
      },
    ]
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      yield* authenticate(harness, 1)
      expect(yield* service.cleanupOrphans).toEqual([])
      yield* TestClock.adjust("5 minutes")
      expect(yield* service.cleanupOrphans).toEqual([])
      expect(harness.provider.kills).toEqual([])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("preserves active and paused sandboxes and reaps terminal inventory", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const { access } = yield* authenticate(harness, 1)
      harness.provider.inventory = [
        {
          sandboxId: "sandbox-1",
          state: "running",
          templateId: "ar7-template-alias",
          templateBuildId: "template-build-v1-immutable",
          metadata: {
            "rika.app-id": "rika",
            "rika.deployment-id": "test",
            "rika.assignment-id": "assignment-1",
            "rika.generation": "1",
          },
        },
      ]
      expect(yield* service.cleanupOrphans).toEqual([])

      yield* service.pause({ assignmentId: "assignment-1", generation: 1 }, quiescence(access))
      harness.provider.inventory = [{ ...harness.provider.inventory[0]!, state: "paused" }]
      expect(yield* service.cleanupOrphans).toEqual([])

      yield* service.kill({ assignmentId: "assignment-1", generation: 1 })
      harness.provider.kills.length = 0
      expect(yield* service.cleanupOrphans).toEqual([])
      yield* TestClock.adjust("5 minutes")
      expect(yield* service.cleanupOrphans).toEqual(["sandbox-1"])
      expect(harness.provider.kills).toEqual(["sandbox-1"])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("reaps superseded generations after grace", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      yield* authenticate(harness, 1)
      yield* service.replace({ assignmentId: "assignment-1", generation: 1 }, runtimeAuthorization)
      harness.provider.kills.length = 0
      harness.provider.inventory = [
        {
          sandboxId: "sandbox-1",
          state: "running",
          templateId: "ar7-template-alias",
          templateBuildId: "template-build-v1-immutable",
          metadata: {
            "rika.app-id": "rika",
            "rika.deployment-id": "previous-deployment",
            "rika.assignment-id": "assignment-1",
            "rika.generation": "1",
          },
        },
        {
          sandboxId: "sandbox-2",
          state: "running",
          templateId: "ar7-template-alias",
          templateBuildId: "template-build-v1-immutable",
          metadata: {
            "rika.app-id": "rika",
            "rika.deployment-id": "test",
            "rika.assignment-id": "assignment-1",
            "rika.generation": "2",
          },
        },
      ]

      expect(yield* service.cleanupOrphans).toEqual([])
      yield* TestClock.adjust("5 minutes")
      expect(yield* service.cleanupOrphans).toEqual(["sandbox-1"])
      expect(harness.provider.kills).toEqual(["sandbox-1"])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("retries failed reaps and tolerates stale provider listings", () => {
    const harness = makeHarness()
    harness.provider.inventory = [
      {
        sandboxId: "sandbox-orphan",
        state: "paused",
        templateId: "ar7-template-alias",
        templateBuildId: "template-build-v1-immutable",
        metadata: {
          "rika.app-id": "rika",
          "rika.deployment-id": "previous-deployment",
          "rika.assignment-id": "assignment-1",
          "rika.generation": "1",
        },
      },
    ]
    return Effect.gen(function* () {
      const service = yield* controller
      const assignment = yield* createAssignment()
      const assignments = yield* ExecutorAssignments
      yield* assignments.terminate({
        assignmentId: assignment.id,
        generation: assignment.generation,
        revision: assignment.revision,
      })
      expect(yield* service.cleanupOrphans).toEqual([])
      yield* TestClock.adjust("5 minutes")

      harness.provider.killFailure = true
      expect(yield* service.cleanupOrphans).toEqual([])
      harness.provider.killFailure = false
      expect(yield* service.cleanupOrphans).toEqual(["sandbox-orphan"])

      expect(yield* service.cleanupOrphans).toEqual([])
      yield* TestClock.adjust("5 minutes")
      harness.provider.killResult = false
      expect(yield* service.cleanupOrphans).toEqual(["sandbox-orphan"])
      expect(harness.provider.kills).toEqual(["sandbox-orphan", "sandbox-orphan", "sandbox-orphan"])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("preserves a sandbox that becomes durable during its orphan grace period", () => {
    const harness = makeHarness()
    harness.provider.inventory = [
      {
        sandboxId: "sandbox-provisioning",
        state: "running",
        templateId: "ar7-template-alias",
        templateBuildId: "template-build-v1-immutable",
        metadata: {
          "rika.app-id": "rika",
          "rika.deployment-id": "test",
          "rika.assignment-id": "assignment-1",
          "rika.generation": "1",
        },
      },
    ]
    return Effect.gen(function* () {
      const service = yield* controller
      expect(yield* service.cleanupOrphans).toEqual([])

      const assignments = yield* ExecutorAssignments
      const assignment = yield* createAssignment()
      yield* assignments.beginProvisioning({
        assignmentId: assignment.id,
        generation: assignment.generation,
        revision: assignment.revision,
        bootstrapCredentialDigest: Redacted.make("bootstrap-digest"),
        bootstrapLifetimeMillis: 10 * 60_000,
      })
      yield* TestClock.adjust("5 minutes")
      expect(yield* service.cleanupOrphans).toEqual([])
      expect(harness.provider.kills).toEqual([])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("reaps a generation-matching provisioning sandbox after its bootstrap fence expires", () => {
    const harness = makeHarness()
    harness.provider.inventory = [
      {
        sandboxId: "sandbox-expired-provisioning",
        state: "running",
        templateId: "ar7-template-alias",
        templateBuildId: "template-build-v1-immutable",
        metadata: {
          "rika.app-id": "rika",
          "rika.deployment-id": "test",
          "rika.assignment-id": "assignment-1",
          "rika.generation": "1",
        },
      },
    ]
    return Effect.gen(function* () {
      const service = yield* controller
      const assignments = yield* ExecutorAssignments
      const assignment = yield* createAssignment()
      yield* assignments.beginProvisioning({
        assignmentId: assignment.id,
        generation: assignment.generation,
        revision: assignment.revision,
        bootstrapCredentialDigest: Redacted.make("bootstrap-digest"),
        bootstrapLifetimeMillis: 60_000,
      })
      expect(yield* service.cleanupOrphans).toEqual([])
      yield* TestClock.adjust("1 minute")
      expect(yield* service.cleanupOrphans).toEqual([])
      expect(yield* readAssignment()).toMatchObject({
        generation: "1",
        lifecycle: { _tag: "Provisioning" },
      })
      yield* TestClock.adjust("5 minutes")
      expect(yield* service.cleanupOrphans).toEqual(["sandbox-expired-provisioning"])
      expect(harness.provider.kills).toEqual(["sandbox-expired-provisioning"])
      expect(yield* readAssignment()).toMatchObject({
        generation: "2",
        lifecycle: { _tag: "Pending" },
      })
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("fences adoption before an authority-claimed sandbox is killed", () => {
    const harness = makeHarness({ orphanGraceMillis: 0 })
    harness.provider.inventory = [
      {
        sandboxId: "sandbox-claimed",
        state: "running",
        templateId: "ar7-template-alias",
        templateBuildId: "template-build-v1-immutable",
        metadata: {
          "rika.app-id": "rika",
          "rika.deployment-id": "test",
          "rika.assignment-id": "assignment-1",
          "rika.generation": "1",
        },
      },
    ]
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* controller
        const assignments = yield* ExecutorAssignments
        const assignment = yield* createAssignment()
        yield* assignments.beginProvisioning({
          assignmentId: assignment.id,
          generation: assignment.generation,
          revision: assignment.revision,
          bootstrapCredentialDigest: Redacted.make("expired-bootstrap"),
          bootstrapLifetimeMillis: 0,
        })
        const killGate = yield* Deferred.make<void>()
        harness.provider.killGate = killGate
        const cleanup = yield* service.cleanupOrphans.pipe(Effect.forkScoped)
        yield* Deferred.await(harness.provider.killStarted)

        expect(yield* service.provision("assignment-1", setupAuthorization)).toMatchObject({
          generation: 2,
          sandboxId: "sandbox-1",
        })
        expect(yield* readAssignment()).toMatchObject({
          generation: "2",
          lifecycle: { _tag: "AwaitingBootstrap", providerInstanceId: "sandbox-1" },
        })
        yield* Deferred.succeed(killGate, undefined)
        expect(yield* Fiber.join(cleanup)).toEqual(["sandbox-claimed"])
        expect(harness.provider.kills).toEqual(["sandbox-claimed"])
      }).pipe(provideLayer(harness.layer)),
    )
  })

  it.effect("rejects a native tool dispatch access after its lease expires or is replaced", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const { access } = yield* authenticate(harness, 1)
      yield* service.validateAccess(access)
      yield* TestClock.adjust("1 minute")
      expect((yield* Effect.flip(service.validateAccess(access))).kind).toBe("fenced")
      const reconnected = yield* service.reconnect(access)
      const renewed = { ...access, leaseEpoch: reconnected.leaseEpoch }
      yield* service.validateAccess(renewed)
      yield* service.replace({ assignmentId: "assignment-1", generation: 1 }, runtimeAuthorization)
      expect((yield* Effect.flip(service.validateAccess(renewed))).kind).toBe("fenced")
    }).pipe(provideLayer(harness.layer))
  })
})
