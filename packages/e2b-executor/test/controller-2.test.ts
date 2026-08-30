import { describe, expect, it } from "@effect/vitest"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import type { Access } from "@rika/remote-execution/protocol"
import { Effect, Inspectable, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { CheckpointError } from "../src/checkpoint"
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
  it.effect("keeps durable pause fencing and retries an unknown provider pause outcome", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const first = yield* authenticate(harness, 1)
      expect((yield* Effect.flip(service.pause({ assignmentId: "assignment-1", generation: 1 }))).kind).toBe(
        "assignment-conflict",
      )
      harness.provider.pauseFailure = true
      expect(
        (yield* Effect.flip(service.pause({ assignmentId: "assignment-1", generation: 1 }, quiescence(first.access))))
          .kind,
      ).toBe("provider")
      expect((yield* readAssignment()).lifecycle._tag).toBe("Paused")
      expect((yield* Effect.flip(service.validateAccess(first.access))).kind).toBe("fenced")
      harness.provider.pauseFailure = false
      expect(
        (yield* service.pause({ assignmentId: "assignment-1", generation: 1 }, quiescence(first.access))).state,
      ).toBe("paused")
      expect(harness.provider.pauses).toEqual(["sandbox-1", "sandbox-1"])
      expect((yield* service.provision("assignment-1", runtimeAuthorization)).state).toBe("provisioning")
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("promotes bootstrap to an ack-safe scoped session without trusting sandbox ID possession", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const bootstrap = harness.provider.bootstraps[0]!.credential
      const fence = {
        target: "orb" as const,
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
        workspaceCapabilities,
        cursors: { command: 0, event: 0, pty: 0 },
        latestCheckpointId: null,
      }
      expect((yield* Effect.flip(service.hello({ ...hello, bootstrapToken: Redacted.make("wrong") }))).kind).toBe(
        "authentication",
      )
      const { welcome, access } = yield* authenticate(harness, 1)
      expect(Inspectable.toStringUnknown(welcome.sessionToken)).toBe('"<redacted:executor-session>"')
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
      const replacement = yield* service.replace({ assignmentId: "assignment-1", generation: 1 }, runtimeAuthorization)
      expect(replacement).toMatchObject({ generation: 2, sandboxId: "sandbox-2", state: "provisioning" })
      expect(harness.provider.kills).not.toContain("sandbox-1")
      expect((yield* Effect.flip(service.reconnect(first.access))).kind).toBe("fenced")
      expect((yield* authenticate(harness, 2)).welcome.cursor).toEqual({ sequence: 4, value: "executor:4" })
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("restores the latest verified checkpoint on replacement and after a bootstrap fault", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const first = yield* authenticate(harness, 1)
      yield* service.checkpoint(first.access, {
        version: 1,
        checkpointId: "checkpoint-replacement",
        archive,
        cursor: { sequence: 0, value: "" },
      })
      harness.provider.bootstrapFailure = true
      expect(
        (yield* Effect.flip(service.replace({ assignmentId: "assignment-1", generation: 1 }, runtimeAuthorization)))
          .kind,
      ).toBe("provider")
      expect(yield* readAssignment()).toMatchObject({ generation: "2", lifecycle: { _tag: "AwaitingBootstrap" } })
      expect(harness.provider.kills).toEqual([])
      harness.provider.bootstrapFailure = false
      yield* service.provision("assignment-1", runtimeAuthorization)
      const retried = harness.provider.bootstraps.at(-1)!
      expect(retried.identity).toMatchObject({ assignmentGeneration: 2, lifecycle: "replacement" })
      expect(retried.restore).toMatchObject({ checkpointId: "checkpoint-replacement", archive })
      expect(harness.provider.creates).toHaveLength(2)
      expect(harness.provider.connects.at(-1)).toEqual({
        sandboxId: "sandbox-2",
        timeoutMillis: Controller.IdleTimeoutMillis,
      })
      const second = yield* authenticate(harness, 2)
      yield* service.ready(
        second.access,
        {
          workspaceId: "workspace-1",
          repositoryId: "repository-1",
          baseCommit: "a".repeat(40),
          headCommit: "b".repeat(40),
          setupHookDigest: `sha256:${"c".repeat(64)}`,
          environmentDigest,
          templateBuildId: "template-build-v1-immutable",
          restoredCheckpointId: "checkpoint-replacement",
        },
        workspaceCapabilities,
        environmentDigest,
      )
      const assignments = yield* ExecutorAssignments
      expect(yield* assignments.listManaged).toMatchObject([
        {
          id: "assignment-1",
          generation: "2",
          latestCheckpointId: "checkpoint-replacement",
          lifecycle: { _tag: "Active", providerInstanceId: "sandbox-2" },
        },
      ])
      expect((yield* Effect.flip(service.validateAccess(first.access))).kind).toBe("fenced")
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("rejects corrupt replacement state and cannot ready a mismatched checkpoint", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const first = yield* authenticate(harness, 1)
      yield* service.checkpoint(first.access, {
        version: 1,
        checkpointId: "checkpoint-replacement",
        archive,
        cursor: { sequence: 0, value: "" },
      })
      harness.checkpointLoadFailure = CheckpointError.make({
        kind: "corrupt",
        message: "checkpoint authentication failed",
      })
      expect(
        (yield* Effect.flip(service.replace({ assignmentId: "assignment-1", generation: 1 }, runtimeAuthorization)))
          .kind,
      ).toBe("checkpoint")
      expect(yield* readAssignment()).toMatchObject({ generation: "1", lifecycle: { _tag: "Active" } })
      expect(harness.provider.creates).toHaveLength(1)

      harness.checkpointLoadFailure = null
      yield* service.replace({ assignmentId: "assignment-1", generation: 1 }, runtimeAuthorization)
      const second = yield* authenticate(harness, 2)
      const proof = {
        workspaceId: "workspace-1",
        repositoryId: "repository-1",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        setupHookDigest: `sha256:${"c".repeat(64)}`,
        environmentDigest,
        templateBuildId: "template-build-v1-immutable",
        restoredCheckpointId: "different-checkpoint",
      }
      expect(
        (yield* Effect.flip(service.ready(second.access, proof, workspaceCapabilities, environmentDigest))).kind,
      ).toBe("checkpoint")
      yield* service.ready(
        second.access,
        { ...proof, restoredCheckpointId: "checkpoint-replacement" },
        workspaceCapabilities,
        environmentDigest,
      )
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("retries a failed cold wake as resume without replacing the persistent Workspace", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      yield* provision()
      const first = yield* authenticate(harness, 1)
      yield* service.pause({ assignmentId: "assignment-1", generation: 1 }, quiescence(first.access))
      harness.provider.connectFailure = true
      expect(
        (yield* Effect.flip(service.resume({ assignmentId: "assignment-1", generation: 1 }, runtimeAuthorization)))
          .kind,
      ).toBe("provider")
      harness.provider.connectFailure = false
      yield* service.provision("assignment-1", runtimeAuthorization)
      expect(harness.provider.bootstraps.at(-1)).toMatchObject({
        sandboxId: "sandbox-1",
        identity: { assignmentGeneration: 1, lifecycle: "resume" },
        restore: null,
      })
      expect(harness.provider.creates).toHaveLength(1)
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
        archive,
        cursor: { sequence: 2, value: "executor:2" },
      }
      const verified = yield* service.checkpoint(access, staged)
      expect(yield* service.checkpoint(access, staged)).toEqual(verified)
      expect(harness.checkpointInspections).toEqual([staged.checkpointId])
      harness.checkpointInspection = { ...harness.checkpointInspection, sizeBytes: 41 }
      expect((yield* Effect.flip(service.checkpoint(access, { ...staged, checkpointId: "checkpoint-2" }))).kind).toBe(
        "checkpoint",
      )
      const credential = yield* service.credential(access, {
        ownerId: "owner-1",
        assignmentId: "assignment-1",
        repositoryId: "repository-1",
        workspaceId: "workspace-1",
        purpose: "git-read",
        assignmentGeneration: 1,
        leaseEpoch: access.leaseEpoch,
      })
      expect(credential).toMatchObject({
        repositoryUrl: "https://github.com/In-Time-Tec/rika.git",
        username: "x-access-token",
      })
      expect(Inspectable.toStringUnknown(credential.token)).toBe('"<redacted:github-installation-token>"')
      expect(json(credential)).not.toContain("ghs_actual_secret")
      expect(harness.checkoutRequests).toEqual([
        {
          installationId: "installation-1",
          owner: "In-Time-Tec",
          repository: "rika",
          ownerId: "owner-1",
          workspaceId: "workspace-1",
          repositoryId: "repository-1",
          purpose: "git-read",
        },
      ])
      const valid = {
        ownerId: "owner-1",
        assignmentId: "assignment-1",
        repositoryId: "repository-1",
        workspaceId: "workspace-1",
        purpose: "github-read" as const,
        assignmentGeneration: 1,
        leaseEpoch: access.leaseEpoch,
      }
      for (const mismatch of [
        { ...valid, ownerId: "owner-2" },
        { ...valid, assignmentId: "assignment-2" },
        { ...valid, repositoryId: "repository-2" },
        { ...valid, workspaceId: "workspace-2" },
        { ...valid, assignmentGeneration: 2 },
        { ...valid, leaseEpoch: access.leaseEpoch + 1 },
      ])
        expect((yield* Effect.flip(service.credential(access, mismatch))).kind).toBe("checkout")
      expect(harness.checkoutRequests).toHaveLength(1)
      expect(
        (yield* Effect.flip(service.revokeCredential(access, { ...valid, repositoryId: "repository-2" }))).kind,
      ).toBe("checkout")
    }).pipe(provideLayer(harness.layer))
  })

  it.effect("retries a verified upload after manifest commit failure without duplicating checkpoint identity", () => {
    const harness = makeHarness()
    return Effect.gen(function* () {
      const service = yield* controller
      const assignments = yield* ExecutorAssignments
      yield* provision()
      const { access } = yield* authenticate(harness, 1)
      const proposal = {
        version: 1 as const,
        checkpointId: "checkpoint-commit-retry",
        archive,
        cursor: { sequence: 0, value: "" },
      }

      harness.checkpointCommitFailures = 1
      expect((yield* Effect.flip(service.checkpoint(access, proposal))).kind).toBe("repository")
      expect(yield* assignments.latestCheckpoint(assignmentInput.id)).toBeUndefined()
      expect(harness.checkpointInspections).toEqual([proposal.checkpointId])

      const committed = yield* service.checkpoint(access, proposal)
      expect((yield* assignments.latestCheckpoint(assignmentInput.id))?.id).toBe(proposal.checkpointId)
      expect(harness.checkpointCommitAttempts).toBe(2)
      expect(harness.checkpointInspections).toEqual([proposal.checkpointId, proposal.checkpointId])
      expect(yield* service.checkpoint(access, proposal)).toEqual(committed)
      expect(harness.checkpointCommitAttempts).toBe(2)
      expect(harness.checkpointInspections).toEqual([proposal.checkpointId, proposal.checkpointId])
    }).pipe(provideLayer(harness.layer))
  })
})
