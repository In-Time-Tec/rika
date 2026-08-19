import { expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import {
  AuditEventId,
  BetterAuthMemberId,
  ClientId,
  CommitCursor,
  CommandId,
  DeviceId,
  EventId,
  ExecutorInstanceId,
  IdempotencyKey,
  LeaseId,
  OrganizationId,
  ProjectId,
  ThreadId,
  Timestamp,
  type ThreadEvent,
  WorkspaceId,
} from "@rika/product/hosted-authority-model"
import { HostedRepository, type AdmitCommandInput } from "@rika/product/hosted-authority-repository"
import { memoryLayer } from "../../src/hosted/memory-hosted-authority-repository"

const ids = {
  organization: OrganizationId.make("org"),
  member: BetterAuthMemberId.make("member"),
  device: DeviceId.make("device"),
  client: ClientId.make("client"),
  project: ProjectId.make("project"),
  workspace: WorkspaceId.make("workspace"),
  thread: ThreadId.make("thread"),
  executorOne: ExecutorInstanceId.make("executor-one"),
  executorTwo: ExecutorInstanceId.make("executor-two"),
}

const at = (second: number) => Timestamp.make(`2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`)

const initialize = Effect.gen(function* () {
  const repository = yield* HostedRepository
  yield* repository.createProject({
    id: ids.project,
    organizationId: ids.organization,
    name: "Hosted",
    createdByMemberId: ids.member,
    now: at(0),
  })
  yield* repository.registerDevice({
    id: ids.device,
    organizationId: ids.organization,
    memberId: ids.member,
    displayName: "Workstation",
    publicKeyFingerprint: "sha256:device",
    now: at(0),
  })
  yield* repository.authenticateClient({
    id: ids.client,
    organizationId: ids.organization,
    memberId: ids.member,
    deviceId: ids.device,
    now: at(0),
    expiresAt: at(59),
  })
  yield* repository.createWorkspace({
    id: ids.workspace,
    organizationId: ids.organization,
    projectId: ids.project,
    createdByMemberId: ids.member,
    executorKind: "e2b",
    now: at(0),
  })
  yield* repository.createThread({
    id: ids.thread,
    organizationId: ids.organization,
    projectId: ids.project,
    workspaceId: ids.workspace,
    createdByMemberId: ids.member,
    executorKind: "e2b",
    now: at(0),
  })
  yield* repository.registerExecutor({
    id: ids.executorOne,
    organizationId: ids.organization,
    executorKind: "e2b",
    deviceId: null,
    now: at(0),
  })
  yield* repository.registerExecutor({
    id: ids.executorTwo,
    organizationId: ids.organization,
    executorKind: "e2b",
    deviceId: null,
    now: at(0),
  })
  return repository
})

const commandInput = (ordinal: number, threadId = ids.thread): AdmitCommandInput => ({
  organizationId: ids.organization,
  threadId,
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

it.layer(memoryLayer)("hosted repository", (test) => {
  test.effect("defaults local threads to creator-only and remote threads to project inheritance", () =>
    Effect.gen(function* () {
      const repository = yield* HostedRepository
      yield* repository.createProject({
        id: ids.project,
        organizationId: ids.organization,
        name: "Sharing",
        createdByMemberId: ids.member,
        now: at(0),
      })
      const localWorkspace = yield* repository.createWorkspace({
        id: WorkspaceId.make("local-workspace"),
        organizationId: ids.organization,
        projectId: ids.project,
        createdByMemberId: ids.member,
        executorKind: "local_device",
        now: at(0),
      })
      const remoteWorkspace = yield* repository.createWorkspace({
        id: WorkspaceId.make("remote-workspace"),
        organizationId: ids.organization,
        projectId: ids.project,
        createdByMemberId: ids.member,
        executorKind: "e2b",
        now: at(0),
      })
      const local = yield* repository.createThread({
        id: ThreadId.make("local-thread"),
        organizationId: ids.organization,
        projectId: ids.project,
        workspaceId: localWorkspace.id,
        createdByMemberId: ids.member,
        executorKind: "local_device",
        now: at(0),
      })
      const remote = yield* repository.createThread({
        id: ThreadId.make("remote-thread"),
        organizationId: ids.organization,
        projectId: ids.project,
        workspaceId: remoteWorkspace.id,
        createdByMemberId: ids.member,
        executorKind: "e2b",
        now: at(0),
      })
      expect(local.inheritProjectGrants).toBe(false)
      expect(remote.inheritProjectGrants).toBe(true)
      expect(
        yield* Effect.result(
          repository.createThread({
            id: ThreadId.make("invalid-local-thread"),
            organizationId: ids.organization,
            projectId: ids.project,
            workspaceId: localWorkspace.id,
            createdByMemberId: ids.member,
            executorKind: "local_device",
            inheritProjectGrants: true,
            now: at(0),
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-authority" } })
    }),
  )
})

it.layer(memoryLayer)("hosted repository command idempotency", (test) => {
  test.effect("admits commands idempotently with gap-free per-thread sequencing", () =>
    Effect.gen(function* () {
      const repository = yield* initialize
      const firstInput = commandInput(1)
      const first = yield* repository.admitCommand(firstInput)
      const replay = yield* repository.admitCommand({ ...firstInput, admittedAt: at(2) })
      const conflict = yield* Effect.result(
        repository.admitCommand({ ...firstInput, commandId: CommandId.make("different-command") }),
      )
      const rest = yield* Effect.all(
        Array.from({ length: 16 }, (_, index) => repository.admitCommand(commandInput(index + 2))),
        { concurrency: "unbounded" },
      )
      expect(first.sequence).toBe("1")
      expect(replay).toEqual(first)
      expect(conflict).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } })
      expect(rest.map((command) => Number(command.sequence)).toSorted((left, right) => left - right)).toEqual(
        Array.from({ length: 16 }, (_, index) => index + 2),
      )
    }),
  )
})

it.layer(memoryLayer)("hosted repository organization cursor", (test) => {
  test.effect("allocates a gap-free commit-ordered cursor across threads in one organization", () =>
    Effect.gen(function* () {
      const repository = yield* initialize
      const otherThread = ThreadId.make("other-thread")
      yield* repository.createThread({
        id: otherThread,
        organizationId: ids.organization,
        projectId: ids.project,
        workspaceId: ids.workspace,
        createdByMemberId: ids.member,
        executorKind: "e2b",
        now: at(0),
      })
      const commands = yield* Effect.all(
        Array.from({ length: 12 }, (_, index) =>
          repository.admitCommand(commandInput(index + 1, index % 2 === 0 ? ids.thread : otherThread)),
        ),
        { concurrency: "unbounded" },
      )
      expect(commands.map((command) => Number(command.commitCursor)).toSorted((left, right) => left - right)).toEqual(
        Array.from({ length: 12 }, (_, index) => index + 1),
      )
      expect(
        commands
          .filter((command) => command.threadId === ids.thread)
          .map((command) => Number(command.sequence))
          .toSorted((left, right) => left - right),
      ).toEqual([1, 2, 3, 4, 5, 6])
      expect(
        commands
          .filter((command) => command.threadId === otherThread)
          .map((command) => Number(command.sequence))
          .toSorted((left, right) => left - right),
      ).toEqual([1, 2, 3, 4, 5, 6])
      const assignment = yield* repository.acquireAssignment({
        organizationId: ids.organization,
        threadId: ids.thread,
        executorInstanceId: ids.executorOne,
        executorKind: "e2b",
        leaseId: LeaseId.make("cursor-assignment"),
        now: at(13),
        expiresAt: at(30),
      })
      const event = yield* repository.appendEvent({
        organizationId: ids.organization,
        threadId: ids.thread,
        eventId: EventId.make("cursor-event"),
        idempotencyKey: IdempotencyKey.make("cursor-event-key"),
        executorInstanceId: ids.executorOne,
        leaseId: assignment.leaseId,
        assignmentGeneration: assignment.generation,
        commandSequence: null,
        event: { _tag: "TerminalOutput", data: "cursor" },
        createdAt: at(14),
      })
      const audit = yield* repository.recordAuditEvent({
        id: AuditEventId.make("cursor-audit"),
        organizationId: ids.organization,
        actorMemberId: ids.member,
        actorClientId: ids.client,
        action: "thread.event.appended",
        resourceKind: "thread",
        resourceId: ids.thread,
        attributes: { eventId: event.eventId },
        occurredAt: at(15),
      })
      expect(event.commitCursor).toBe("13")
      expect(audit.commitCursor).toBe("14")
      expect(
        yield* Effect.result(
          repository.acknowledgeCursor({
            organizationId: ids.organization,
            threadId: ids.thread,
            memberId: ids.member,
            clientId: ids.client,
            commitCursor: CommitCursor.make("12"),
            now: at(16),
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } })
    }),
  )
})

it.layer(memoryLayer)("hosted repository organization ancestry", (test) => {
  test.effect("rejects foreign-organization ancestry for workspaces, clients, executors, and thread access", () =>
    Effect.gen(function* () {
      const repository = yield* initialize
      const foreignOrganization = OrganizationId.make("foreign-org")
      const foreignMember = BetterAuthMemberId.make("foreign-member")
      const foreignProject = ProjectId.make("foreign-project")
      const foreignWorkspace = WorkspaceId.make("foreign-workspace")
      const foreignDevice = DeviceId.make("foreign-device")
      const foreignClient = ClientId.make("foreign-client")
      const foreignExecutor = ExecutorInstanceId.make("foreign-executor")
      yield* repository.createProject({
        id: foreignProject,
        organizationId: foreignOrganization,
        name: "Foreign",
        createdByMemberId: foreignMember,
        now: at(0),
      })
      yield* repository.createWorkspace({
        id: foreignWorkspace,
        organizationId: foreignOrganization,
        projectId: foreignProject,
        createdByMemberId: foreignMember,
        executorKind: "e2b",
        now: at(0),
      })
      yield* repository.registerDevice({
        id: foreignDevice,
        organizationId: foreignOrganization,
        memberId: foreignMember,
        displayName: "Foreign device",
        publicKeyFingerprint: "sha256:foreign",
        now: at(0),
      })
      yield* repository.authenticateClient({
        id: foreignClient,
        organizationId: foreignOrganization,
        memberId: foreignMember,
        deviceId: foreignDevice,
        now: at(0),
        expiresAt: at(59),
      })
      yield* repository.registerExecutor({
        id: foreignExecutor,
        organizationId: foreignOrganization,
        executorKind: "e2b",
        deviceId: null,
        now: at(0),
      })
      const failures = yield* Effect.all([
        Effect.result(
          repository.createWorkspace({
            id: WorkspaceId.make("cross-org-workspace"),
            organizationId: foreignOrganization,
            projectId: ids.project,
            createdByMemberId: foreignMember,
            executorKind: "e2b",
            now: at(0),
          }),
        ),
        Effect.result(
          repository.createThread({
            id: ThreadId.make("cross-org-thread"),
            organizationId: ids.organization,
            projectId: ids.project,
            workspaceId: foreignWorkspace,
            createdByMemberId: ids.member,
            executorKind: "e2b",
            now: at(0),
          }),
        ),
        Effect.result(
          repository.authenticateClient({
            id: ClientId.make("cross-org-client"),
            organizationId: ids.organization,
            memberId: ids.member,
            deviceId: foreignDevice,
            now: at(0),
            expiresAt: at(59),
          }),
        ),
        Effect.result(
          repository.acquireAssignment({
            organizationId: ids.organization,
            threadId: ids.thread,
            executorInstanceId: foreignExecutor,
            executorKind: "e2b",
            leaseId: LeaseId.make("cross-org-assignment"),
            now: at(1),
            expiresAt: at(2),
          }),
        ),
        Effect.result(
          repository.admitCommand({
            ...commandInput(99),
            memberId: foreignMember,
            clientId: foreignClient,
            actor: {
              _tag: "AuthenticatedMember",
              organizationId: ids.organization,
              memberId: foreignMember,
              clientId: foreignClient,
              deviceId: foreignDevice,
            },
          }),
        ),
        Effect.result(
          repository.readEvents({
            organizationId: foreignOrganization,
            threadId: ids.thread,
            memberId: foreignMember,
            clientId: foreignClient,
            afterCommitCursor: CommitCursor.make("0"),
            limit: 10,
          }),
        ),
      ])
      expect(failures.every((result) => result._tag === "Failure")).toBe(true)
    }),
  )
})

it.layer(memoryLayer)("hosted repository executor lease", (test) => {
  test.effect("allows one executor lease winner, increments generation after expiry, and rejects kind fallback", () =>
    Effect.gen(function* () {
      const repository = yield* initialize
      const attempts = yield* Effect.all(
        [ids.executorOne, ids.executorTwo].map((executorInstanceId, index) =>
          Effect.result(
            repository.acquireAssignment({
              organizationId: ids.organization,
              threadId: ids.thread,
              executorInstanceId,
              executorKind: "e2b",
              leaseId: LeaseId.make(`assignment-${index}`),
              now: at(1),
              expiresAt: at(2),
            }),
          ),
        ),
        { concurrency: "unbounded" },
      )
      expect(attempts.filter(Result.isSuccess)).toHaveLength(1)
      expect(attempts.filter(Result.isFailure)).toHaveLength(1)
      const replacement = yield* repository.acquireAssignment({
        organizationId: ids.organization,
        threadId: ids.thread,
        executorInstanceId: ids.executorTwo,
        executorKind: "e2b",
        leaseId: LeaseId.make("replacement-assignment"),
        now: at(3),
        expiresAt: at(9),
      })
      expect(replacement.generation).toBe("2")
      const staleRenewal = yield* Effect.result(
        repository.renewAssignment({
          organizationId: ids.organization,
          threadId: ids.thread,
          executorInstanceId: attempts.find(Result.isSuccess)!.success.executorInstanceId,
          leaseId: attempts.find(Result.isSuccess)!.success.leaseId,
          generation: attempts.find(Result.isSuccess)!.success.generation,
          now: at(4),
          expiresAt: at(8),
        }),
      )
      expect(staleRenewal).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })
      expect(
        yield* Effect.result(
          repository.acquireAssignment({
            organizationId: ids.organization,
            threadId: ids.thread,
            executorInstanceId: ids.executorTwo,
            executorKind: "local_device",
            leaseId: LeaseId.make("fallback-assignment"),
            now: at(10),
            expiresAt: at(11),
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-authority" } })
    }),
  )
})

it.layer(memoryLayer)("hosted repository executor fence and cursor resume", (test) => {
  test.effect("rejects stale executor generations and resumes events strictly after a cursor", () =>
    Effect.gen(function* () {
      const repository = yield* initialize
      const first = yield* repository.acquireAssignment({
        organizationId: ids.organization,
        threadId: ids.thread,
        executorInstanceId: ids.executorOne,
        executorKind: "e2b",
        leaseId: LeaseId.make("first-assignment"),
        now: at(1),
        expiresAt: at(2),
      })
      const current = yield* repository.acquireAssignment({
        organizationId: ids.organization,
        threadId: ids.thread,
        executorInstanceId: ids.executorTwo,
        executorKind: "e2b",
        leaseId: LeaseId.make("current-assignment"),
        now: at(3),
        expiresAt: at(20),
      })
      expect(
        yield* Effect.result(
          repository.appendEvent({
            organizationId: ids.organization,
            threadId: ids.thread,
            eventId: EventId.make("stale-event"),
            idempotencyKey: IdempotencyKey.make("stale-event-key"),
            executorInstanceId: ids.executorOne,
            leaseId: first.leaseId,
            assignmentGeneration: first.generation,
            commandSequence: null,
            event: { _tag: "TerminalOutput", data: "stale" },
            createdAt: at(4),
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })
      const events: Array<ThreadEvent> = []
      for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
        events.push(
          yield* repository.appendEvent({
            organizationId: ids.organization,
            threadId: ids.thread,
            eventId: EventId.make(`event-${ordinal}`),
            idempotencyKey: IdempotencyKey.make(`event-key-${ordinal}`),
            executorInstanceId: ids.executorTwo,
            leaseId: current.leaseId,
            assignmentGeneration: current.generation,
            commandSequence: null,
            event: { _tag: "TerminalOutput", data: String(ordinal) },
            createdAt: at(ordinal + 4),
          }),
        )
      }
      const cursor = yield* repository.acknowledgeCursor({
        organizationId: ids.organization,
        threadId: ids.thread,
        memberId: ids.member,
        clientId: ids.client,
        commitCursor: events[0]!.commitCursor,
        now: at(8),
      })
      const resumed = yield* repository.readEvents({
        organizationId: ids.organization,
        threadId: ids.thread,
        memberId: ids.member,
        clientId: ids.client,
        afterCommitCursor: cursor.commitCursor,
        limit: 100,
      })
      const advanced = yield* repository.acknowledgeCursor({
        organizationId: ids.organization,
        threadId: ids.thread,
        memberId: ids.member,
        clientId: ids.client,
        commitCursor: events[1]!.commitCursor,
        now: at(9),
      })
      const nonRegressing = yield* repository.acknowledgeCursor({
        organizationId: ids.organization,
        threadId: ids.thread,
        memberId: ids.member,
        clientId: ids.client,
        commitCursor: events[0]!.commitCursor,
        now: at(10),
      })
      expect(resumed.map((event) => event.sequence)).toEqual(["2", "3"])
      expect(advanced.commitCursor).toBe(events[1]!.commitCursor)
      expect(nonRegressing.commitCursor).toBe(events[1]!.commitCursor)
    }),
  )
})

it.layer(memoryLayer)("hosted repository terminal writer", (test) => {
  test.effect("serializes terminal writers and requires the renewable writer fence for input", () =>
    Effect.gen(function* () {
      const repository = yield* initialize
      const attempts = yield* Effect.all(
        ["writer-one", "writer-two"].map((leaseId) =>
          Effect.result(
            repository.acquireTerminalWriter({
              organizationId: ids.organization,
              threadId: ids.thread,
              memberId: ids.member,
              clientId: ids.client,
              leaseId: LeaseId.make(leaseId),
              now: at(1),
              expiresAt: at(5),
            }),
          ),
        ),
        { concurrency: "unbounded" },
      )
      const winner = attempts.find(Result.isSuccess)!.success
      expect(attempts.filter(Result.isSuccess)).toHaveLength(1)
      expect(
        yield* Effect.result(
          repository.admitCommand({
            ...commandInput(2),
            command: {
              _tag: "TerminalInput",
              data: "ls\n",
              writerLeaseId: LeaseId.make("wrong-writer"),
              writerGeneration: winner.generation,
            },
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })
      const renewed = yield* repository.renewTerminalWriter({
        organizationId: ids.organization,
        threadId: ids.thread,
        memberId: ids.member,
        clientId: ids.client,
        leaseId: winner.leaseId,
        generation: winner.generation,
        now: at(2),
        expiresAt: at(8),
      })
      const admitted = yield* repository.admitCommand({
        ...commandInput(3),
        command: {
          _tag: "TerminalInput",
          data: "pwd\n",
          writerLeaseId: renewed.leaseId,
          writerGeneration: renewed.generation,
        },
      })
      expect(admitted.command).toMatchObject({ _tag: "TerminalInput", data: "pwd\n" })
      const replacement = yield* repository.acquireTerminalWriter({
        organizationId: ids.organization,
        threadId: ids.thread,
        memberId: ids.member,
        clientId: ids.client,
        leaseId: LeaseId.make("replacement-writer"),
        now: at(9),
        expiresAt: at(12),
      })
      expect(replacement.generation).toBe("2")
      expect(
        yield* Effect.result(
          repository.renewTerminalWriter({
            organizationId: ids.organization,
            threadId: ids.thread,
            memberId: ids.member,
            clientId: ids.client,
            leaseId: renewed.leaseId,
            generation: renewed.generation,
            now: at(10),
            expiresAt: at(13),
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "stale-fence" } })
    }),
  )
})
