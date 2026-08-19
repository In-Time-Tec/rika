import { expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { TestClock } from "effect/testing"
import type { ExecutorAssignment } from "@rika/product/executor-assignment"
import { ExecutorAssignments, type Access, type Version } from "@rika/product/executor-assignments"
import {
  BetterAuthMemberId,
  ClientId,
  CommandId,
  DeviceId,
  EventId,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  IdempotencyKey,
  LeaseId,
  OrganizationId,
  ProjectId,
  Sequence,
  ThreadId,
  Timestamp,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { HostedStore, type AdmitCommandInput } from "@rika/product/hosted-store"
import { layer } from "../../src/hosted/memory-store"

const ids = {
  assignment: ExecutorAssignmentId.make("assignment"),
  client: ClientId.make("client"),
  device: DeviceId.make("device"),
  executor: ExecutorInstanceId.make("executor"),
  member: BetterAuthMemberId.make("member"),
  organization: OrganizationId.make("organization"),
  project: ProjectId.make("project"),
  thread: ThreadId.make("thread"),
  workspace: WorkspaceId.make("workspace"),
}
const testIds = (suffix: string): typeof ids => ({
  assignment: ExecutorAssignmentId.make(`assignment-${suffix}`),
  client: ClientId.make(`client-${suffix}`),
  device: DeviceId.make(`device-${suffix}`),
  executor: ExecutorInstanceId.make(`executor-${suffix}`),
  member: BetterAuthMemberId.make(`member-${suffix}`),
  organization: OrganizationId.make(`organization-${suffix}`),
  project: ProjectId.make(`project-${suffix}`),
  thread: ThreadId.make(`thread-${suffix}`),
  workspace: WorkspaceId.make(`workspace-${suffix}`),
})

const at = (second: number) => Timestamp.make(`2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`)
const version = (assignment: ExecutorAssignment): Version => ({
  assignmentId: assignment.id,
  generation: assignment.generation,
  revision: assignment.revision,
})

const initialize = (currentIds: typeof ids) =>
  Effect.gen(function* () {
    const store = yield* HostedStore
    yield* store.createProject({
      id: currentIds.project,
      organizationId: currentIds.organization,
      name: "Rika",
      createdByMemberId: currentIds.member,
      now: at(0),
    })
    yield* store.registerDevice({
      id: currentIds.device,
      organizationId: currentIds.organization,
      memberId: currentIds.member,
      displayName: "Workstation",
      publicKeyFingerprint: `sha256:${currentIds.device}`,
      now: at(0),
    })
    yield* store.authenticateClient({
      id: currentIds.client,
      organizationId: currentIds.organization,
      memberId: currentIds.member,
      deviceId: currentIds.device,
      now: at(0),
      expiresAt: at(59),
    })
    yield* store.createWorkspace({
      id: currentIds.workspace,
      organizationId: currentIds.organization,
      projectId: currentIds.project,
      createdByMemberId: currentIds.member,
      executorKind: "e2b",
      now: at(0),
    })
    yield* store.createThread({
      id: currentIds.thread,
      organizationId: currentIds.organization,
      projectId: currentIds.project,
      workspaceId: currentIds.workspace,
      createdByMemberId: currentIds.member,
      executorKind: "e2b",
      now: at(0),
    })
    return store
  })

const command = (ordinal: number): AdmitCommandInput => ({
  organizationId: ids.organization,
  threadId: ids.thread,
  memberId: ids.member,
  clientId: ids.client,
  commandId: CommandId.make(`command-${ordinal}`),
  idempotencyKey: IdempotencyKey.make(`command-key-${ordinal}`),
  actor: {
    _tag: "AuthenticatedMember",
    organizationId: ids.organization,
    memberId: ids.member,
    clientId: ids.client,
    deviceId: ids.device,
  },
  command: { _tag: "SubmitPrompt", prompt: `prompt ${ordinal}` },
  admittedAt: at(ordinal),
})

const openAssignment = (currentIds: typeof ids) =>
  Effect.gen(function* () {
    const assignments = yield* ExecutorAssignments
    const created = yield* assignments.create({
      id: currentIds.assignment,
      organizationId: currentIds.organization,
      threadId: currentIds.thread,
    placement: { _tag: "E2BPlacement", templateBuildId: "template", providerScope: "scope" },
    checkout: {
      repositoryId: "repository",
      installationId: "installation",
      owner: "rika",
      name: "rika",
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    })
    const provisioning = yield* assignments.beginProvisioning({
      ...version(created),
      bootstrapCredentialDigest: Redacted.make("bootstrap"),
      bootstrapLifetimeMillis: 60_000,
    })
    const bound = yield* assignments.bindProviderInstance({ ...version(provisioning), providerInstanceId: "sandbox" })
    const active = yield* assignments.openSession({
      ...version(bound),
      providerInstanceId: "sandbox",
      executorInstanceId: currentIds.executor,
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
    return { assignments, active, access }
  })

it.layer(layer)("hosted store", (test) => {
  test.effect("keeps placement immutable and defaults E2B sharing on", () =>
    Effect.gen(function* () {
      const store = yield* HostedStore
      yield* store.createProject({
        id: ProjectId.make("sharing-project"),
        organizationId: ids.organization,
        name: "Rika",
        createdByMemberId: ids.member,
        now: at(0),
      })
      const remote = yield* store.createWorkspace({
        id: WorkspaceId.make("sharing-workspace"),
        organizationId: ids.organization,
        projectId: ProjectId.make("sharing-project"),
        createdByMemberId: ids.member,
        executorKind: "e2b",
        now: at(0),
      })
      expect(remote.inheritProjectGrants).toBe(true)
      expect(
        yield* Effect.result(
          store.createThread({
            id: ThreadId.make("sharing-thread"),
            organizationId: ids.organization,
            projectId: ProjectId.make("sharing-project"),
            workspaceId: WorkspaceId.make("sharing-workspace"),
            createdByMemberId: ids.member,
            executorKind: "local_device",
            now: at(0),
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-authority" } })
    }),
  )

  test.effect("deduplicates commands and serializes terminal writers", () =>
    Effect.gen(function* () {
      const store = yield* initialize(ids)
      const first = yield* store.admitCommand(command(1))
      expect(yield* store.admitCommand({ ...command(1), admittedAt: at(2) })).toEqual(first)

      const writer = yield* store.acquireTerminalWriter({
        organizationId: ids.organization,
        threadId: ids.thread,
        memberId: ids.member,
        clientId: ids.client,
        leaseId: LeaseId.make("writer"),
        now: at(2),
        expiresAt: at(10),
      })
      expect(
        yield* Effect.result(
          store.admitCommand({
            ...command(2),
            command: {
              _tag: "TerminalInput",
              data: "pwd\n",
              writerLeaseId: LeaseId.make("stale-writer"),
              writerGeneration: writer.generation,
            },
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })
    }),
  )

  test.effect("admits executor events only under the current assignment fence", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-01-01T00:00:00.000Z"))
      const eventIds = testIds("event")
      const store = yield* initialize(eventIds)
      const { assignments, active, access } = yield* openAssignment(eventIds)
      const event = yield* store.appendEvent({
        eventId: EventId.make("event"),
        idempotencyKey: IdempotencyKey.make("event-key"),
        assignmentId: access.assignmentId,
        assignmentGeneration: access.assignmentGeneration,
        leaseEpoch: access.leaseEpoch,
        commandSequence: null,
        event: { _tag: "TerminalOutput", data: "hello" },
      })

      expect(event).toMatchObject({
        organizationId: eventIds.organization,
        threadId: eventIds.thread,
        executorInstanceId: eventIds.executor,
        assignmentId: eventIds.assignment,
      })
      const replay = yield* store.appendEvent({
        eventId: event.eventId,
        idempotencyKey: event.idempotencyKey,
        assignmentId: access.assignmentId,
        assignmentGeneration: access.assignmentGeneration,
        leaseEpoch: access.leaseEpoch,
        commandSequence: null,
        event: event.event,
      })
      expect(replay).toEqual(event)

      yield* assignments.beginReplacement({
        ...version(active),
        bootstrapCredentialDigest: Redacted.make("replacement"),
        bootstrapLifetimeMillis: 60_000,
      })
      expect(
        yield* Effect.result(
          store.appendEvent({
            eventId: EventId.make("stale-event"),
            idempotencyKey: IdempotencyKey.make("stale-event-key"),
            assignmentId: access.assignmentId,
            assignmentGeneration: access.assignmentGeneration,
            leaseEpoch: access.leaseEpoch,
            commandSequence: Sequence.make("1"),
            event: { _tag: "TerminalOutput", data: "stale" },
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })
    }),
  )
})
