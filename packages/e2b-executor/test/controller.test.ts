import { describe, expect, it } from "@effect/vitest"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import type { Access } from "@rika/remote-execution/protocol"
import { Effect, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as Controller from "../src/controller"
import { assignmentInput, controller, createAssignment, makeHarness, readAssignment } from "./support/fakes"
import { provideLayer } from "./support/layer"

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const provision = Effect.fn("test.provision")(function* () {
  const service = yield* controller
  const assignment = yield* createAssignment()
  return yield* service.provision(assignment.id)
})

const authenticate = Effect.fn("test.authenticate")(function* (
  harness: ReturnType<typeof makeHarness>,
  generation: number,
) {
  const service = yield* controller
  const request = harness.provider.bootstraps.findLast((bootstrap) => bootstrap.sandboxId === `sandbox-${generation}`)!
  const fence = {
    target: "e2b" as const,
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
      const first = yield* service.provision(assignmentInput.id)
      const second = yield* service.provision(assignmentInput.id)
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
          RIKA_EXECUTOR_TARGET: "e2b",
          RIKA_EXECUTOR_ID: "assignment-1:g1",
          RIKA_EXECUTOR_TEMPLATE_BUILD_ID: "template-build-v1-immutable",
          RIKA_EXECUTOR_WORKSPACE_ID: "workspace-1",
        },
      })
      expect(Object.keys(harness.provider.creates[0]!.environment).sort()).toEqual([
        "RIKA_CHECKPOINT_OBJECT_PREFIX",
        "RIKA_EXECUTOR_API_URL",
        "RIKA_EXECUTOR_ASSIGNMENT_ID",
        "RIKA_EXECUTOR_GENERATION",
        "RIKA_EXECUTOR_ID",
        "RIKA_EXECUTOR_TARGET",
        "RIKA_EXECUTOR_TEMPLATE_BUILD_ID",
        "RIKA_EXECUTOR_WORKSPACE_ID",
      ])
      const bootstrapRequest = harness.provider.bootstraps[0]!
      expect(bootstrapRequest.identity).toEqual({
        target: "e2b",
        assignmentId: "assignment-1",
        assignmentGeneration: 1,
        instanceId: "sandbox-1",
        executorId: "assignment-1:g1",
        templateBuildId: "template-build-v1-immutable",
        apiUrl: "wss://api.example.test/executors",
        workspaceId: "workspace-1",
      })
      const bootstrap = bootstrapRequest.credential
      expect(String(bootstrap)).toBe("<redacted:executor-bootstrap>")
      expect(json(first)).not.toContain(Redacted.value(bootstrap))
      expect((yield* readAssignment()).lifecycle).toMatchObject({ _tag: "AwaitingBootstrap" })
      expect(json(yield* readAssignment())).not.toContain(Redacted.value(bootstrap))
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("rejects an assignment whose immutable build is not controller-approved", () => {
    const harness = makeHarness({ templateBuildId: "approved-build" })
    return Effect.gen(function* () {
      const service = yield* controller
      yield* createAssignment()
      expect(yield* Effect.flip(service.provision(assignmentInput.id))).toMatchObject({
        kind: "provider",
        message: "Assignment template build is not approved",
      })
      expect(harness.provider.creates).toEqual([])
      expect(harness.provider.bootstraps).toEqual([])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("uses filesystem pause, demand provisioning resume, lease renewal, and kill", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const first = yield* authenticate(harness, 1)
      expect((yield* service.provision("assignment-1")).state).toBe("running")
      expect((yield* service.pause({ assignmentId: "assignment-1", generation: 1 })).state).toBe("paused")
      expect((yield* service.provision("assignment-1")).state).toBe("provisioning")
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

  it.effect("keeps durable pause fencing and retries an unknown provider pause outcome", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      yield* authenticate(harness, 1)
      harness.provider.pauseFailure = true
      expect((yield* Effect.flip(service.pause({ assignmentId: "assignment-1", generation: 1 }))).kind).toBe("provider")
      expect((yield* readAssignment()).lifecycle._tag).toBe("Paused")
      harness.provider.pauseFailure = false
      expect((yield* service.pause({ assignmentId: "assignment-1", generation: 1 })).state).toBe("paused")
      expect(harness.provider.pauses).toEqual(["sandbox-1", "sandbox-1"])
      expect((yield* service.provision("assignment-1")).state).toBe("provisioning")
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("promotes bootstrap to an ack-safe scoped session without trusting sandbox ID possession", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const bootstrap = harness.provider.bootstraps[0]!.credential
      const fence = {
        target: "e2b" as const,
        assignmentId: "assignment-1",
        assignmentGeneration: 1,
        instanceId: "sandbox-1",
        executorId: "assignment-1:g1:process-1",
        processIncarnation: "process-1",
      }
      const hello = {
        minimumVersion: 1 as const,
        maximumVersion: 1 as const,
        fence,
        templateBuildId: "template-build-v1-immutable",
        capabilities: { cells: true, checkpoints: true, pty: true },
        cursors: { command: 0, event: 0, pty: 0 },
        latestCheckpointId: null,
      }
      expect((yield* Effect.flip(service.hello({ ...hello, bootstrapToken: Redacted.make("wrong") }))).kind).toBe(
        "authentication",
      )
      const { welcome, access } = yield* authenticate(harness, 1)
      expect(String(welcome.sessionToken)).toBe("<redacted:executor-session>")
      const acknowledgedHello = yield* service.hello({ ...hello, bootstrapToken: bootstrap })
      expect(acknowledgedHello.leaseEpoch).toBe(welcome.leaseEpoch)
      expect(Redacted.value(acknowledgedHello.sessionToken)).toBe(Redacted.value(welcome.sessionToken))
      expect(
        (yield* Effect.flip(
          service.reconnect({
            ...access,
            leaseEpoch: acknowledgedHello.leaseEpoch,
            sessionToken: Redacted.make("wrong"),
          }),
        )).kind,
      ).toBe("authentication")
      expect(json(welcome)).not.toContain(Redacted.value(welcome.sessionToken))
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("advances socket epochs, fences stale sockets, and restores the durable cursor after replacement", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const first = yield* authenticate(harness, 1)
      yield* service.heartbeat({
        version: 1,
        access: first.access,
        cursor: { sequence: 4, value: "executor:4" },
      })
      expect(
        (yield* Effect.flip(
          service.heartbeat({
            version: 1,
            access: first.access,
            cursor: { sequence: 3, value: "executor:3" },
          }),
        )).kind,
      ).toBe("protocol")
      yield* TestClock.adjust("2 minutes")
      const reconnected = yield* service.reconnect(first.access)
      expect(reconnected.cursor).toEqual({ sequence: 4, value: "executor:4" })
      expect(reconnected.leaseEpoch).toBe(first.access.leaseEpoch + 1)
      expect((yield* Effect.flip(service.reconnect(first.access))).kind).toBe("fenced")
      const replacement = yield* service.replace({ assignmentId: "assignment-1", generation: 1 })
      expect(replacement).toMatchObject({ generation: 2, sandboxId: "sandbox-2", state: "provisioning" })
      expect(harness.provider.kills).toContain("sandbox-1")
      expect((yield* Effect.flip(service.reconnect(first.access))).kind).toBe("fenced")
      expect((yield* authenticate(harness, 2)).welcome.cursor).toEqual({ sequence: 4, value: "executor:4" })
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("accepts only verified generation-scoped object checkpoints and redacts checkout credentials", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const { access } = yield* authenticate(harness, 1)
      yield* service.heartbeat({
        version: 1,
        access,
        cursor: { sequence: 2, value: "executor:2" },
      })
      const staged = {
        version: 1 as const,
        checkpointId: "checkpoint-1",
        objectKey: "assignments/assignment-1/g1/checkpoint-1.tar.zst",
        contentDigest: `sha256:${"a".repeat(64)}`,
        sizeBytes: 42,
        format: "tar.zst" as const,
        cursor: { sequence: 2, value: "executor:2" },
      }
      const verified = yield* service.checkpoint(access, staged)
      expect(yield* service.checkpoint(access, staged)).toEqual(verified)
      expect(harness.checkpointInspections).toEqual([staged.objectKey, staged.objectKey])
      harness.checkpointInspection = { ...harness.checkpointInspection, sizeBytes: 41 }
      expect(
        (yield* Effect.flip(
          service.checkpoint(access, { ...staged, checkpointId: "checkpoint-2", objectKey: `${staged.objectKey}.2` }),
        )).kind,
      ).toBe("checkpoint")
      const credential = yield* service.checkout(access)
      expect(credential).toMatchObject({
        repositoryUrl: "https://github.com/In-Time-Tec/rika.git",
        username: "x-access-token",
      })
      expect(String(credential.token)).toBe("<redacted:github-installation-token>")
      expect(json(credential)).not.toContain("ghs_actual_secret")
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("reports checkout as unavailable when the assignment has no repository", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      const assignments = yield* ExecutorAssignments
      yield* assignments.create({ ...assignmentInput, checkout: null })
      yield* service.provision(assignmentInput.id)
      const { access } = yield* authenticate(harness, 1)

      expect(yield* Effect.flip(service.checkout(access))).toMatchObject({
        kind: "checkout",
        message: "Repository checkout is unavailable for this assignment",
      })
      expect(harness.checkoutRequests).toEqual([])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("reconciles an unknown create outcome and removes duplicate generation sandboxes", () => {
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
      yield* createAssignment()
      expect(yield* service.provision("assignment-1")).toMatchObject({
        sandboxId: "sandbox-a-adopt",
        state: "provisioning",
      })
      expect(harness.provider.creates).toHaveLength(1)
      expect(harness.provider.bootstraps.map((entry) => entry.sandboxId)).toEqual(["sandbox-a-adopt"])
      expect(harness.provider.kills).toEqual(["sandbox-z-duplicate"])
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
      expect((yield* Effect.flip(service.provision("assignment-1"))).kind).toBe("provider")
      expect(harness.provider.bootstraps).toEqual([])
      expect(harness.provider.kills).toEqual([])
    }).pipe(provideLayer(harness.layer))
  })

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
      expect((yield* Effect.flip(service.provision("assignment-1"))).kind).toBe("provider")
      expect(harness.provider.bootstraps).toEqual([])
      expect(harness.provider.kills).toEqual([])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("kills only managed inventory entries without a durable assignment", () => {
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
    ]
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      expect(yield* service.cleanupOrphans).toEqual(["sandbox-orphan"])
      expect(harness.provider.kills).toEqual(["sandbox-orphan"])
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("rejects a cell dispatch access after its lease expires or is replaced", () => {
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
      yield* service.replace({ assignmentId: "assignment-1", generation: 1 })
      expect((yield* Effect.flip(service.validateAccess(renewed))).kind).toBe("fenced")
    }).pipe(provideLayer(harness.layer))
  })
})
