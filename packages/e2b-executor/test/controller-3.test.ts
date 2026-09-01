import { describe, expect, it } from "@effect/vitest"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import type { Access } from "@rika/remote-execution/protocol"
import { Effect, Redacted } from "effect"
import { TestClock } from "effect/testing"
import * as Controller from "../src/controller"
import { assignmentInput, controller, createAssignment, makeHarness, readAssignment } from "./support/fakes"
import { provideLayer } from "./support/layer"

const setupEgress = { phase: "setup", allow: ["github.com"] } as const
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
const archive = {
  content: btoa("x".repeat(42)),
  contentDigest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 42,
}

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
  it.effect("binds Workspace readiness and setup cache objects to the authorized environment", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const { access } = yield* authenticate(harness, 1)
      const proof = {
        workspaceId: "workspace-1",
        repositoryId: "repository-1",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        setupHookDigest: `sha256:${"c".repeat(64)}`,
        environmentDigest,
        templateBuildId: "template-build-v1-immutable",
        restoredCheckpointId: null,
      }
      expect(
        (yield* Effect.flip(service.ready(access, proof, workspaceCapabilities, `sha256:${"f".repeat(64)}`))).kind,
      ).toBe("fenced")
      yield* service.ready(access, proof, workspaceCapabilities, environmentDigest)
      const key = {
        ownerId: "owner-1",
        repository: {
          repositoryId: "repository-1",
          owner: "In-Time-Tec",
          name: "rika",
          commitSha: "a".repeat(40),
        },
        setupHookDigest: proof.setupHookDigest,
        templateBuildId: proof.templateBuildId,
        environmentDigest,
      }
      expect((yield* Effect.flip(service.storeSetupCache(access, key, archive, `sha256:${"f".repeat(64)}`))).kind).toBe(
        "fenced",
      )
      yield* service.storeSetupCache(access, key, archive, environmentDigest)
      expect(yield* service.loadSetupCache(access, key, environmentDigest)).toEqual(archive)
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("reports checkout as unavailable when the assignment has no repository", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      const assignments = yield* ExecutorAssignments
      yield* assignments.create({ ...assignmentInput, checkout: null })
      yield* service.provision(assignmentInput.id, setupAuthorization)
      expect(harness.provider.creates[0]!.environment).not.toHaveProperty("RIKA_EXECUTOR_REPOSITORY_ID")
      expect(harness.provider.creates[0]!.environment).not.toHaveProperty("RIKA_EXECUTOR_REPOSITORY_OWNER")
      expect(harness.provider.creates[0]!.environment).not.toHaveProperty("RIKA_EXECUTOR_REPOSITORY_NAME")
      expect(harness.provider.creates[0]!.environment).not.toHaveProperty("RIKA_EXECUTOR_COMMIT_SHA")
      expect(harness.provider.bootstraps[0]!.identity.repository).toBeNull()
      const { access } = yield* authenticate(harness, 1)

      expect(
        yield* Effect.flip(
          service.credential(access, {
            ownerId: "owner-1",
            assignmentId: "assignment-1",
            repositoryId: "repository-1",
            workspaceId: "workspace-1",
            purpose: "git-read",
            assignmentGeneration: 1,
            leaseEpoch: access.leaseEpoch,
          }),
        ),
      ).toMatchObject({
        kind: "checkout",
        message: "Credential request does not match the assigned repository fence",
      })
      expect(harness.checkoutRequests).toEqual([])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("adopts an existing generation and reaps duplicates only after durable binding and grace", () => {
    const harness = makeHarness()
    harness.provider.createFailure = true
    const metadata = {
      "rika.managed": "e2b-executor",
      "rika.app-id": "rika",
      "rika.deployment-id": "test",
      "rika.assignment-id": "assignment-1",
      "rika.generation": "1",
    }
    harness.provider.inventory = [
      {
        sandboxId: "sandbox-z-duplicate",
        state: "running",
        templateId: "ar7-template-alias",
        templateBuildId: "template-build-v1-immutable",
        metadata,
      },
      {
        sandboxId: "sandbox-a-adopt",
        state: "running",
        templateId: "ar7-template-alias",
        templateBuildId: "template-build-v1-immutable",
        metadata,
      },
    ]
    return Effect.gen(function* () {
      const service = yield* controller
      const assignment = yield* createAssignment()
      const assignments = yield* ExecutorAssignments
      yield* assignments.beginProvisioning({
        assignmentId: assignment.id,
        generation: assignment.generation,
        revision: assignment.revision,
        bootstrapCredentialDigest: Redacted.make("lost-bootstrap-credential"),
        bootstrapLifetimeMillis: 60_000,
      })
      expect(yield* service.provision("assignment-1", setupAuthorization)).toMatchObject({
        sandboxId: "sandbox-a-adopt",
        state: "provisioning",
      })
      expect(harness.provider.creates).toHaveLength(0)
      expect(harness.provider.connects).toEqual([
        { sandboxId: "sandbox-a-adopt", timeoutMillis: Controller.IdleTimeoutMillis },
      ])
      expect(harness.provider.bootstraps.map((entry) => entry.sandboxId)).toEqual(["sandbox-a-adopt"])
      expect(harness.provider.kills).toEqual([])
      expect(yield* service.cleanupOrphans).toEqual([])
      yield* TestClock.adjust("5 minutes")
      expect(yield* service.cleanupOrphans).toEqual(["sandbox-z-duplicate"])
      expect(harness.provider.kills).toEqual(["sandbox-z-duplicate"])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("proves a usable candidate before removing unconnectable duplicates", () => {
    const harness = makeHarness()
    harness.provider.createFailure = true
    harness.provider.connectFailures.add("sandbox-a-broken")
    const metadata = {
      "rika.managed": "e2b-executor",
      "rika.app-id": "rika",
      "rika.deployment-id": "test",
      "rika.assignment-id": "assignment-1",
      "rika.generation": "1",
    }
    harness.provider.inventory = [
      {
        sandboxId: "sandbox-a-broken",
        state: "running",
        templateId: "ar7-template-alias",
        templateBuildId: "template-build-v1-immutable",
        metadata,
      },
      {
        sandboxId: "sandbox-b-adopt",
        state: "paused",
        templateId: "ar7-template-alias",
        templateBuildId: "template-build-v1-immutable",
        metadata,
      },
      {
        sandboxId: "sandbox-z-duplicate",
        state: "running",
        templateId: "ar7-template-alias",
        templateBuildId: "template-build-v1-immutable",
        metadata,
      },
    ]
    return Effect.gen(function* () {
      const service = yield* controller
      const assignment = yield* createAssignment()
      const assignments = yield* ExecutorAssignments
      yield* assignments.beginProvisioning({
        assignmentId: assignment.id,
        generation: assignment.generation,
        revision: assignment.revision,
        bootstrapCredentialDigest: Redacted.make("lost-bootstrap-credential"),
        bootstrapLifetimeMillis: 60_000,
      })

      expect(yield* service.provision("assignment-1", setupAuthorization)).toMatchObject({
        sandboxId: "sandbox-b-adopt",
      })
      expect(harness.provider.connects).toEqual([
        { sandboxId: "sandbox-a-broken", timeoutMillis: Controller.IdleTimeoutMillis },
        { sandboxId: "sandbox-b-adopt", timeoutMillis: Controller.IdleTimeoutMillis },
      ])
      expect(harness.provider.kills).toEqual([])
      expect(yield* service.cleanupOrphans).toEqual([])
      yield* TestClock.adjust("5 minutes")
      expect(yield* service.cleanupOrphans).toEqual(["sandbox-a-broken", "sandbox-z-duplicate"])
      expect(harness.provider.kills).toEqual(["sandbox-a-broken", "sandbox-z-duplicate"])
      expect(harness.provider.bootstraps.map((entry) => entry.sandboxId)).toEqual(["sandbox-b-adopt"])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("reconciles a committed provider binding after its response is lost", () => {
    const harness = makeHarness()
    harness.bindResponseFailures = 1
    return Effect.gen(function* () {
      const service = yield* controller
      yield* createAssignment()

      expect(yield* service.provision("assignment-1", setupAuthorization)).toMatchObject({
        sandboxId: "sandbox-1",
        state: "provisioning",
      })
      expect(harness.provider.bootstraps.map((entry) => entry.sandboxId)).toEqual(["sandbox-1"])
      expect(harness.provider.kills).toEqual([])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("does not kill a sandbox when provider binding and reconciliation outcomes are both unknown", () => {
    const harness = makeHarness()
    harness.bindResponseFailures = 1
    harness.failReadAfterBind = true
    return Effect.gen(function* () {
      const service = yield* controller
      yield* createAssignment()

      expect((yield* Effect.flip(service.provision("assignment-1", setupAuthorization))).kind).toBe("repository")
      expect(harness.provider.bootstraps).toEqual([])
      expect(harness.provider.kills).toEqual([])
      expect((yield* readAssignment()).lifecycle).toMatchObject({
        _tag: "AwaitingBootstrap",
        providerInstanceId: "sandbox-1",
      })
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("keeps the adopted sandbox when authority-backed duplicate cleanup fails", () => {
    const harness = makeHarness()
    harness.provider.createFailure = true
    harness.provider.killFailure = true
    const metadata = {
      "rika.managed": "e2b-executor",
      "rika.app-id": "rika",
      "rika.deployment-id": "test",
      "rika.assignment-id": "assignment-1",
      "rika.generation": "1",
    }
    harness.provider.inventory = [
      {
        sandboxId: "sandbox-z-duplicate",
        state: "running",
        templateId: "ar7-template-alias",
        templateBuildId: "template-build-v1-immutable",
        metadata,
      },
      {
        sandboxId: "sandbox-a-adopt",
        state: "paused",
        templateId: "ar7-template-alias",
        templateBuildId: "template-build-v1-immutable",
        metadata,
      },
    ]
    return Effect.gen(function* () {
      const service = yield* controller
      const assignment = yield* createAssignment()
      const assignments = yield* ExecutorAssignments
      yield* assignments.beginProvisioning({
        assignmentId: assignment.id,
        generation: assignment.generation,
        revision: assignment.revision,
        bootstrapCredentialDigest: Redacted.make("lost-bootstrap-credential"),
        bootstrapLifetimeMillis: 60_000,
      })
      expect(yield* service.provision("assignment-1", setupAuthorization)).toMatchObject({
        sandboxId: "sandbox-a-adopt",
        state: "provisioning",
      })
      expect(harness.provider.kills).toEqual([])
      expect(yield* service.cleanupOrphans).toEqual([])
      yield* TestClock.adjust("5 minutes")
      expect(yield* service.cleanupOrphans).toEqual([])
      expect(harness.provider.kills).toEqual(["sandbox-z-duplicate"])
      expect(harness.provider.connects).toEqual([
        { sandboxId: "sandbox-a-adopt", timeoutMillis: Controller.IdleTimeoutMillis },
      ])
      expect(harness.provider.bootstraps.map((entry) => entry.sandboxId)).toEqual(["sandbox-a-adopt"])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("does not reconcile an unknown create outcome against a different build receipt", () => {
    const harness = makeHarness()
    harness.provider.createFailure = true
    harness.provider.inventory = [
      {
        sandboxId: "sandbox-wrong-build",
        state: "running",
        templateId: "ar7-template-alias",
        templateBuildId: "different-build-receipt",
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
      expect((yield* Effect.flip(service.provision("assignment-1", setupAuthorization))).kind).toBe("provider")
      expect(harness.provider.bootstraps).toEqual([])
      expect(harness.provider.kills).toEqual([])
    }).pipe(provideLayer(harness.layer))
  })
})
