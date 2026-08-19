import { expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { AssignmentRevision, type ExecutorAssignment } from "@rika/product/executor-assignment"
import {
  ExecutorAssignments,
  type Access,
  type Version,
} from "@rika/product/executor-assignments"
import {
  CheckpointId,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  OrganizationId,
  Sequence,
  ThreadId,
} from "@rika/product/hosted-model"
import { layer } from "../../src/hosted/memory-assignments"

const ids = {
  checkpoint: CheckpointId.make("checkpoint"),
  executor: ExecutorInstanceId.make("executor"),
  organization: OrganizationId.make("organization"),
}

const checkout = {
  repositoryId: "repository",
  installationId: "installation",
  owner: "rika",
  name: "rika",
  commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
}

const version = (assignment: ExecutorAssignment): Version => ({
  assignmentId: assignment.id,
  generation: assignment.generation,
  revision: assignment.revision,
})

const open = (suffix: string) =>
  Effect.gen(function* () {
    const assignments = yield* ExecutorAssignments
    const created = yield* assignments.create({
      id: ExecutorAssignmentId.make(`assignment-${suffix}`),
      organizationId: ids.organization,
      threadId: ThreadId.make(`thread-${suffix}`),
      placement: { _tag: "E2BPlacement", templateBuildId: "template", providerScope: "scope" },
      checkout,
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

      expect(active).not.toHaveProperty("bootstrapCredentialDigest")
      expect(active).not.toHaveProperty("sessionCredentialDigest")
      expect(active.lifecycle).toMatchObject({ _tag: "Active", leaseEpoch: "1" })

      const bootstrapReplay = yield* Effect.result(
        assignments.openSession({
          ...version(active),
          providerInstanceId: "sandbox",
          executorInstanceId: ids.executor,
          processIncarnation: "process",
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
      const replacement = yield* assignments.beginReplacement({
        ...version(active),
        bootstrapCredentialDigest: Redacted.make("replacement-bootstrap"),
        bootstrapLifetimeMillis: 60_000,
      })

      expect(replacement.generation).toBe("2")
      expect(replacement.lifecycle).toMatchObject({ _tag: "Provisioning", providerInstanceId: null })
      expect(yield* Effect.result(assignments.authenticate(access))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "stale-fence" },
      })
    }),
  )
})
