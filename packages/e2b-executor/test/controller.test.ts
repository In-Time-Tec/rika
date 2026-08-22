import { describe, expect, it } from "@effect/vitest"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import type { Access } from "@rika/remote-execution/protocol"
import { Effect, Redacted, Schema } from "effect"
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
      expect(Object.keys(harness.provider.creates[0]!.environment).sort()).toEqual([
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
      expect(yield* Effect.flip(service.provision(assignmentInput.id, setupAuthorization))).toMatchObject({
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
      const replacement = yield* service.replace({ assignmentId: "assignment-1", generation: 1 }, runtimeAuthorization)
      expect(replacement).toMatchObject({ generation: 2, sandboxId: "sandbox-2", state: "provisioning" })
      expect(harness.provider.kills).toContain("sandbox-1")
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
      expect((yield* Effect.flip(service.ready(second.access, proof, environmentDigest))).kind).toBe("checkpoint")
      yield* service.ready(
        second.access,
        { ...proof, restoredCheckpointId: "checkpoint-replacement" },
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
      expect(String(credential.token)).toBe("<redacted:github-installation-token>")
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
      expect((yield* Effect.flip(service.ready(access, proof, `sha256:${"f".repeat(64)}`))).kind).toBe("fenced")
      yield* service.ready(access, proof, environmentDigest)
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
      expect(yield* service.provision("assignment-1", setupAuthorization)).toMatchObject({
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
      expect((yield* Effect.flip(service.provision("assignment-1", setupAuthorization))).kind).toBe("provider")
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
      expect((yield* Effect.flip(service.provision("assignment-1", setupAuthorization))).kind).toBe("provider")
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
      expect(yield* service.cleanupOrphans).toEqual([])
      yield* TestClock.adjust("5 minutes")
      expect(yield* service.cleanupOrphans).toEqual(["sandbox-orphan"])
      expect(harness.provider.kills).toEqual(["sandbox-orphan"])
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
          metadata: { "rika.app-id": "rika", "rika.deployment-id": "test" },
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
        metadata: { "rika.app-id": "rika", "rika.deployment-id": "previous-deployment" },
      },
    ]
    return Effect.gen(function* () {
      const service = yield* controller
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
        bootstrapLifetimeMillis: 60_000,
      })
      yield* TestClock.adjust("5 minutes")
      expect(yield* service.cleanupOrphans).toEqual([])
      expect(harness.provider.kills).toEqual([])
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
      yield* service.replace({ assignmentId: "assignment-1", generation: 1 }, runtimeAuthorization)
      expect((yield* Effect.flip(service.validateAccess(renewed))).kind).toBe("fenced")
    }).pipe(provideLayer(harness.layer))
  })
})
