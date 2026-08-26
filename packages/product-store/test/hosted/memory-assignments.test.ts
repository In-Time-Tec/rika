import { expect, it } from "@effect/vitest"

import { Effect, Redacted } from "effect"
import { TestClock } from "effect/testing"
import {
  AssignmentRevision,
  type ExecutorAssignment,
  type WorkspaceCapabilitySnapshot,
} from "@rika/product/executor-assignment"
import { ExecutorAssignments, type Access, type Version } from "@rika/product/executor-assignments"
import {
  CheckpointId,
  DeviceId,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  OwnerId,
  Sequence,
  ThreadId,
  Timestamp,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { CheckoutFingerprint } from "@rika/product/runner-registration"
import { layer } from "../../src/hosted/memory-assignments"

const ids = {
  checkpoint: CheckpointId.make("checkpoint"),
  executor: ExecutorInstanceId.make("executor"),
  owner: OwnerId.make("owner"),
}

const version = (assignment: ExecutorAssignment): Version => ({
  assignmentId: assignment.id,
  generation: assignment.generation,
  revision: assignment.revision,
})

const capabilities = (digestCharacter: string): WorkspaceCapabilitySnapshot => ({
  environmentDigest: `sha256:${digestCharacter.repeat(64)}`,
  capturedAt: Timestamp.make("2026-01-01T00:00:00.000Z"),
  filesystem: { _tag: "Ready", detail: "workspace filesystem" },
  typescriptKernel: { _tag: "Ready", detail: "TypeScript kernel" },
  git: { _tag: "Ready", detail: "git" },
  process: { _tag: "Ready", detail: "process execution" },
  pty: { _tag: "Ready", detail: "PTY" },
  browser: { _tag: "Unavailable", reason: "browser not installed" },
  services: { _tag: "Ready", detail: "repository services" },
  workspaceLifecycle: { _tag: "Ready", detail: "workspace lifecycle" },
})

const open = (suffix: string) =>
  Effect.gen(function* () {
    const assignments = yield* ExecutorAssignments
    const created = yield* assignments.create({
      id: ExecutorAssignmentId.make(`assignment-${suffix}`),
      ownerId: ids.owner,
      threadId: ThreadId.make(`thread-${suffix}`),
      workspaceId: WorkspaceId.make(`workspace-${suffix}`),
      placement: { _tag: "OrbPlacement", templateBuildId: "template", providerScope: "scope" },
      checkout: null,
    })
    const provisioning = yield* assignments.beginProvisioning({
      ...version(created),
      bootstrapCredentialDigest: Redacted.make("bootstrap"),
      bootstrapLifetimeMillis: 60_000,
    })
    const bound = yield* assignments.bindProviderInstance({
      ...version(provisioning),
      providerInstanceId: "sandbox",
    })
    const active = yield* assignments.openSession({
      ...version(bound),
      providerInstanceId: "sandbox",
      executorInstanceId: ids.executor,
      processIncarnation: "process",
      capabilities: capabilities("a"),
      presentedBootstrapCredentialDigest: Redacted.make("bootstrap"),
      sessionCredentialDigest: Redacted.make("session"),
      leaseLifetimeMillis: 60_000,
    })
    if (active.lifecycle._tag !== "Active") return yield* Effect.die(new Error("assignment did not become active"))
    const access: Access = {
      assignmentId: active.id,
      assignmentGeneration: active.generation,
      providerInstanceId: active.lifecycle.providerInstanceId,
      executorInstanceId: active.lifecycle.executorInstanceId,
      processIncarnation: active.lifecycle.processIncarnation,
      leaseEpoch: active.lifecycle.leaseEpoch,
      presentedSessionCredentialDigest: Redacted.make("session"),
    }
    return { assignments, bound, active, access }
  })

it.layer(layer)("executor assignments", (test) => {
  test.effect("consumes bootstrap credentials and fences old sessions on reconnect", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-01-01T00:00:00.000Z"))
      const { assignments, bound, active, access } = yield* open("session")

      expect(yield* assignments.getForThread(ThreadId.make("thread-session"))).toEqual(active)
      expect(yield* assignments.getForThread(ThreadId.make("missing-thread"))).toBeUndefined()
      expect(active).not.toHaveProperty("bootstrapCredentialDigest")
      expect(active).not.toHaveProperty("sessionCredentialDigest")
      expect(active.lifecycle).toMatchObject({ _tag: "Active", leaseEpoch: "1" })

      const bootstrapReplay = yield* Effect.result(
        assignments.openSession({
          ...version(active),
          providerInstanceId: "sandbox",
          executorInstanceId: ids.executor,
          processIncarnation: "process",
          capabilities: capabilities("b"),
          presentedBootstrapCredentialDigest: Redacted.make("bootstrap"),
          sessionCredentialDigest: Redacted.make("another-session"),
          leaseLifetimeMillis: 60_000,
        }),
      )
      expect(bootstrapReplay).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })

      const reconnected = yield* assignments.reconnect({ access, leaseLifetimeMillis: 60_000 })
      expect(reconnected.lifecycle).toMatchObject({ _tag: "Active", leaseEpoch: "2" })
      expect(yield* Effect.result(assignments.authenticate(access))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "stale-fence" },
      })

      expect(AssignmentRevision.make(bound.revision)).toBe("2")
    }),
  )

  test.effect("advances cursors and publishes checkpoints only under the current fence", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-01-01T00:00:00.000Z"))
      const { assignments, active, access } = yield* open("checkpoint")
      const cursor = { sequence: Sequence.make("1"), value: "event-1" }
      yield* assignments.heartbeat({ access, cursor, leaseLifetimeMillis: 60_000 })

      const checkpoint = yield* assignments.commitCheckpoint({
        access,
        id: ids.checkpoint,
        objectKey: "checkpoints/checkpoint.tar.zst",
        contentDigest: `sha256:${"a".repeat(64)}`,
        sizeBytes: 1024,
        format: "tar.zst",
        cursor,
        metadata: { source: "filesystem" },
      })
      const replay = yield* assignments.commitCheckpoint({
        access,
        id: ids.checkpoint,
        objectKey: checkpoint.objectKey,
        contentDigest: checkpoint.contentDigest,
        sizeBytes: checkpoint.sizeBytes,
        format: checkpoint.format,
        cursor,
        metadata: checkpoint.metadata,
      })

      expect(replay).toEqual(checkpoint)
      expect(yield* assignments.latestCheckpoint(active.id)).toEqual(checkpoint)
      expect((yield* assignments.get(active.id))?.latestCheckpointId).toBe(ids.checkpoint)
      expect(
        yield* Effect.result(
          assignments.heartbeat({
            access,
            cursor: { sequence: Sequence.make("0"), value: "" },
            leaseLifetimeMillis: 60_000,
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } })
    }),
  )

  test.effect("increments generation before replacement credentials become usable", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-01-01T00:00:00.000Z"))
      const { assignments, active, access } = yield* open("replacement")
      if (active.placement._tag !== "OrbPlacement") return yield* Effect.die("assignment is not placed in an Orb")
      const replacement = yield* assignments.beginReplacement({
        ...version(active),
        placement: { ...active.placement, templateBuildId: "template-v2" },
        bootstrapCredentialDigest: Redacted.make("replacement-bootstrap"),
        bootstrapLifetimeMillis: 60_000,
      })

      expect(replacement.generation).toBe("2")
      expect(replacement.placement).toEqual({
        _tag: "OrbPlacement",
        templateBuildId: "template-v2",
        providerScope: "scope",
      })
      expect(replacement.lifecycle).toMatchObject({ _tag: "Provisioning", providerInstanceId: null })
      expect(replacement).toMatchObject({ capabilityGeneration: null, capabilities: null })
      expect(yield* Effect.result(assignments.authenticate(access))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "stale-fence" },
      })
    }),
  )

  test.effect("rejects replacement attempts that change immutable placement authority", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-01-01T00:00:00.000Z"))
      const { assignments, active } = yield* open("replacement-authority")
      const placements: ReadonlyArray<ExecutorAssignment["placement"]> = [
        { _tag: "OrbPlacement", templateBuildId: "template-v2", providerScope: "another-scope" },
        {
          _tag: "RunnerPlacement",
          deviceId: DeviceId.make("another-device"),
          checkoutFingerprint: CheckoutFingerprint.make("another-checkout"),
          requestingDeviceId: DeviceId.make("another-requester"),
        },
      ]

      for (const placement of placements)
        expect(
          yield* Effect.result(
            assignments.beginReplacement({
              ...version(active),
              placement,
              bootstrapCredentialDigest: Redacted.make("replacement-bootstrap"),
              bootstrapLifetimeMillis: 60_000,
            }),
          ),
        ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-authority" } })

      expect(yield* assignments.get(active.id)).toEqual(active)
    }),
  )

  test.effect("preserves capabilities through same-generation transitions and replaces them for the successor", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-01-01T00:00:00.000Z"))
      const { assignments, active, access } = yield* open("capabilities")

      expect(active.capabilityGeneration).toBe(active.generation)
      expect(active.capabilities?.environmentDigest).toBe(`sha256:${"a".repeat(64)}`)
      const refreshedCapabilities = capabilities("c")
      const updated = yield* assignments.updateCapabilities({ access, capabilities: refreshedCapabilities })
      expect(updated.capabilityGeneration).toBe(updated.generation)
      expect(updated.capabilities).toEqual(refreshedCapabilities)
      const paused = yield* assignments.pause(version(updated))
      expect(paused.capabilities).toEqual(refreshedCapabilities)
      const replacement = yield* assignments.beginReplacement({
        ...version(paused),
        placement: paused.placement,
        bootstrapCredentialDigest: Redacted.make("replacement-capabilities"),
        bootstrapLifetimeMillis: 60_000,
      })
      expect(replacement).toMatchObject({ capabilityGeneration: null, capabilities: null })
      const bound = yield* assignments.bindProviderInstance({
        ...version(replacement),
        providerInstanceId: "sandbox-successor",
      })
      const successorCapabilities = capabilities("b")
      const successor = yield* assignments.openSession({
        ...version(bound),
        providerInstanceId: "sandbox-successor",
        executorInstanceId: ids.executor,
        processIncarnation: "process-successor",
        capabilities: successorCapabilities,
        presentedBootstrapCredentialDigest: Redacted.make("replacement-capabilities"),
        sessionCredentialDigest: Redacted.make("successor-session"),
        leaseLifetimeMillis: 60_000,
      })
      expect(successor.capabilityGeneration).toBe(successor.generation)
      expect(successor.capabilities).toEqual(successorCapabilities)
      expect(successor.capabilities?.environmentDigest).toBe(`sha256:${"b".repeat(64)}`)
    }),
  )

  test.effect("preserves an explicit absent repository checkout", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-01-01T00:00:00.000Z"))
      const { active } = yield* open("no-checkout")

      expect(active.checkout).toBeNull()
    }),
  )
})
