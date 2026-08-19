import { Effect, Layer, Ref, Schema } from "effect"
import {
  ActorAttribution,
  type AuditEvent,
  type AuthenticatedClient,
  type AuthenticatedDevice,
  type Checkpoint,
  CommitCursor,
  type CredentialReference,
  type ExecutorAssignmentLease,
  type ExecutorInstance,
  FencingGeneration,
  type HostedThread,
  type HostedWorkspace,
  type LocalWorkspaceBinding,
  type Presence,
  type Project,
  type ProjectGrant,
  type ResumableCursor,
  Sequence,
  type TerminalWriterLease,
  type ThreadCommand,
  type ThreadEvent,
  type ThreadGrant,
} from "@rika/product/hosted-authority-model"
import {
  HostedRepository,
  HostedRepositoryError,
  type HostedRepositoryInterface,
  type HostedRepositoryFailureReason,
} from "@rika/product/hosted-authority-repository"

interface ThreadState {
  readonly thread: HostedThread
  readonly nextCommandSequence: bigint
  readonly nextEventSequence: bigint
}

interface State {
  readonly projects: Map<string, Project>
  readonly projectGrants: Map<string, ProjectGrant>
  readonly workspaces: Map<string, HostedWorkspace>
  readonly threads: Map<string, ThreadState>
  readonly threadGrants: Map<string, ThreadGrant>
  readonly devices: Map<string, AuthenticatedDevice>
  readonly clients: Map<string, AuthenticatedClient>
  readonly executors: Map<string, ExecutorInstance>
  readonly assignments: Map<string, ExecutorAssignmentLease>
  readonly commands: Map<string, ReadonlyArray<ThreadCommand>>
  readonly events: Map<string, ReadonlyArray<ThreadEvent>>
  readonly cursors: Map<string, ResumableCursor>
  readonly writers: Map<string, TerminalWriterLease>
  readonly presence: Map<string, Presence>
  readonly bindings: Map<string, LocalWorkspaceBinding>
  readonly checkpoints: Map<string, Checkpoint>
  readonly auditEvents: Map<string, AuditEvent>
  readonly credentialReferences: Map<string, CredentialReference>
  readonly organizationCounters: Map<string, bigint>
}

type Mutation<A> =
  | { readonly _tag: "Success"; readonly value: A; readonly state: State }
  | { readonly _tag: "Failure"; readonly error: HostedRepositoryError }

const emptyState = (): State => ({
  projects: new Map(),
  projectGrants: new Map(),
  workspaces: new Map(),
  threads: new Map(),
  threadGrants: new Map(),
  devices: new Map(),
  clients: new Map(),
  executors: new Map(),
  assignments: new Map(),
  commands: new Map(),
  events: new Map(),
  cursors: new Map(),
  writers: new Map(),
  presence: new Map(),
  bindings: new Map(),
  checkpoints: new Map(),
  auditEvents: new Map(),
  credentialReferences: new Map(),
  organizationCounters: new Map(),
})

const fail = (reason: HostedRepositoryFailureReason, message: string): Mutation<never> => ({
  _tag: "Failure",
  error: HostedRepositoryError.make({ reason, message }),
})
const succeed = <A>(value: A, state: State): Mutation<A> => ({ _tag: "Success", value, state })
const replace = <K, V>(values: Map<K, V>, key: K, value: V) => new Map(values).set(key, value)
const mutation = <A>(ref: Ref.Ref<State>, update: (state: State) => Mutation<A>) =>
  Ref.modify(ref, (state): readonly [Mutation<A>, State] => {
    const result = update(state)
    return result._tag === "Success" ? [result, result.state] : [result, state]
  }).pipe(
    Effect.flatMap((result) => (result._tag === "Success" ? Effect.succeed(result.value) : Effect.fail(result.error))),
  )
const projectGrantKey = (projectId: string, memberId: string) => `${projectId}\u0000${memberId}`
const threadGrantKey = (threadId: string, memberId: string) => `${threadId}\u0000${memberId}`
const cursorKey = (threadId: string, clientId: string) => `${threadId}\u0000${clientId}`
const bindingKey = (threadId: string, deviceId: string) => `${threadId}\u0000${deviceId}`
const allocateCommitCursor = (current: State, organizationId: string) => {
  const next = current.organizationCounters.get(organizationId) ?? 1n
  return {
    commitCursor: CommitCursor.make(String(next)),
    organizationCounters: replace(current.organizationCounters, organizationId, next + 1n),
  }
}
const commandEquivalent = Schema.toEquivalence(
  Schema.Struct({
    organizationId: Schema.String,
    threadId: Schema.String,
    memberId: Schema.String,
    clientId: Schema.String,
    commandId: Schema.String,
    idempotencyKey: Schema.String,
    actor: ActorAttribution,
    command: Schema.Record(Schema.String, Schema.Unknown),
  }),
)
const eventEquivalent = Schema.toEquivalence(
  Schema.Struct({
    organizationId: Schema.String,
    threadId: Schema.String,
    eventId: Schema.String,
    idempotencyKey: Schema.String,
    executorInstanceId: Schema.String,
    assignmentGeneration: Schema.String,
    commandSequence: Schema.NullOr(Schema.String),
    event: Schema.Record(Schema.String, Schema.Unknown),
  }),
)

const make = Effect.gen(function* () {
  const state = yield* Ref.make(emptyState())

  const requireClient = (
    current: State,
    input: { organizationId: string; memberId: string; clientId: string },
    at?: string,
  ) => {
    const client = current.clients.get(input.clientId)
    return client !== undefined &&
      client.organizationId === input.organizationId &&
      client.memberId === input.memberId &&
      client.revokedAt === null &&
      (at === undefined || client.expiresAt > at)
      ? client
      : undefined
  }

  return HostedRepository.of({
    createProject: (input) =>
      mutation(state, (current) => {
        if (current.projects.has(input.id)) return fail("conflict", "Project identity already exists")
        const project: Project = {
          id: input.id,
          organizationId: input.organizationId,
          name: input.name,
          createdByMemberId: input.createdByMemberId,
          createdAt: input.now,
          updatedAt: input.now,
        }
        const owner: ProjectGrant = {
          organizationId: input.organizationId,
          projectId: input.id,
          memberId: input.createdByMemberId,
          role: "owner",
          grantedByMemberId: input.createdByMemberId,
          createdAt: input.now,
          updatedAt: input.now,
        }
        return succeed(project, {
          ...current,
          projects: replace(current.projects, input.id, project),
          projectGrants: replace(current.projectGrants, projectGrantKey(input.id, input.createdByMemberId), owner),
        })
      }),
    putProjectGrant: (input) =>
      mutation(state, (current) => {
        const project = current.projects.get(input.projectId)
        if (project === undefined || project.organizationId !== input.organizationId) {
          return fail("not-found", "Project does not exist in the organization")
        }
        const key = projectGrantKey(input.projectId, input.memberId)
        const previous = current.projectGrants.get(key)
        const grant: ProjectGrant = {
          ...input,
          createdAt: previous?.createdAt ?? input.now,
          updatedAt: input.now,
        }
        return succeed(grant, { ...current, projectGrants: replace(current.projectGrants, key, grant) })
      }),
    createWorkspace: (input) =>
      mutation(state, (current) => {
        const project = current.projects.get(input.projectId)
        if (project === undefined || project.organizationId !== input.organizationId) {
          return fail("not-found", "Project does not exist in the organization")
        }
        if (current.workspaces.has(input.id)) return fail("conflict", "Workspace identity already exists")
        if (input.executorKind === "local_device" && input.inheritProjectGrants === true) {
          return fail("invalid-authority", "Local workspaces cannot inherit project grants")
        }
        const workspace: HostedWorkspace = {
          id: input.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          createdByMemberId: input.createdByMemberId,
          executorKind: input.executorKind,
          inheritProjectGrants: input.executorKind === "e2b" ? (input.inheritProjectGrants ?? true) : false,
          createdAt: input.now,
        }
        return succeed(workspace, {
          ...current,
          workspaces: replace(current.workspaces, input.id, workspace),
        })
      }),
    createThread: (input) =>
      mutation(state, (current) => {
        const project = current.projects.get(input.projectId)
        const workspace = current.workspaces.get(input.workspaceId)
        if (project === undefined || project.organizationId !== input.organizationId) {
          return fail("not-found", "Project does not exist in the organization")
        }
        if (
          workspace === undefined ||
          workspace.organizationId !== input.organizationId ||
          workspace.projectId !== input.projectId
        ) {
          return fail("not-found", "Workspace does not belong to the project and organization")
        }
        if (workspace.executorKind !== input.executorKind) {
          return fail("invalid-authority", "Thread placement must match its immutable workspace placement")
        }
        if (current.threads.has(input.id)) return fail("conflict", "Thread identity already exists")
        if (input.executorKind === "local_device" && input.inheritProjectGrants === true) {
          return fail("invalid-authority", "Local threads cannot inherit project grants")
        }
        const thread: HostedThread = {
          id: input.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          createdByMemberId: input.createdByMemberId,
          executorKind: input.executorKind,
          inheritProjectGrants:
            input.executorKind === "e2b" ? (input.inheritProjectGrants ?? workspace.inheritProjectGrants) : false,
          createdAt: input.now,
        }
        const owner: ThreadGrant = {
          organizationId: input.organizationId,
          threadId: input.id,
          memberId: input.createdByMemberId,
          role: "owner",
          grantedByMemberId: input.createdByMemberId,
          createdAt: input.now,
          updatedAt: input.now,
        }
        return succeed(thread, {
          ...current,
          threads: replace(current.threads, input.id, {
            thread,
            nextCommandSequence: 1n,
            nextEventSequence: 1n,
          }),
          threadGrants: replace(current.threadGrants, threadGrantKey(input.id, input.createdByMemberId), owner),
        })
      }),
    putThreadGrant: (input) =>
      mutation(state, (current) => {
        const thread = current.threads.get(input.threadId)?.thread
        if (thread === undefined || thread.organizationId !== input.organizationId) {
          return fail("not-found", "Thread does not exist in the organization")
        }
        const key = threadGrantKey(input.threadId, input.memberId)
        const previous = current.threadGrants.get(key)
        const grant: ThreadGrant = {
          ...input,
          createdAt: previous?.createdAt ?? input.now,
          updatedAt: input.now,
        }
        return succeed(grant, { ...current, threadGrants: replace(current.threadGrants, key, grant) })
      }),
    registerDevice: (input) =>
      mutation(state, (current) => {
        const previous = current.devices.get(input.id)
        if (
          previous !== undefined &&
          (previous.organizationId !== input.organizationId ||
            previous.memberId !== input.memberId ||
            previous.revokedAt !== null)
        ) {
          return fail("invalid-authority", "Device identity cannot be reassigned")
        }
        const device: AuthenticatedDevice = {
          id: input.id,
          organizationId: input.organizationId,
          memberId: input.memberId,
          displayName: input.displayName,
          publicKeyFingerprint: input.publicKeyFingerprint,
          createdAt: previous?.createdAt ?? input.now,
          lastSeenAt: input.now,
          revokedAt: null,
        }
        return succeed(device, { ...current, devices: replace(current.devices, input.id, device) })
      }),
    authenticateClient: (input) =>
      mutation(state, (current) => {
        const device = current.devices.get(input.deviceId)
        if (
          device === undefined ||
          device.organizationId !== input.organizationId ||
          device.memberId !== input.memberId ||
          device.revokedAt !== null
        ) {
          return fail("invalid-authority", "Client device is inactive or foreign")
        }
        const previous = current.clients.get(input.id)
        if (
          previous !== undefined &&
          (previous.organizationId !== input.organizationId ||
            previous.memberId !== input.memberId ||
            previous.deviceId !== input.deviceId ||
            previous.revokedAt !== null)
        ) {
          return fail("invalid-authority", "Client identity cannot be reassigned")
        }
        const client: AuthenticatedClient = {
          id: input.id,
          organizationId: input.organizationId,
          memberId: input.memberId,
          deviceId: input.deviceId,
          authenticatedAt: previous?.authenticatedAt ?? input.now,
          lastSeenAt: input.now,
          expiresAt: input.expiresAt,
          revokedAt: null,
        }
        return succeed(client, { ...current, clients: replace(current.clients, input.id, client) })
      }),
    registerExecutor: (input) =>
      mutation(state, (current) => {
        if ((input.executorKind === "local_device") !== (input.deviceId !== null)) {
          return fail("invalid-authority", "Executor kind and device identity do not match")
        }
        if (input.deviceId !== null) {
          const device = current.devices.get(input.deviceId)
          if (device === undefined || device.organizationId !== input.organizationId || device.revokedAt !== null) {
            return fail("invalid-authority", "Executor device is inactive or foreign")
          }
        }
        const previous = current.executors.get(input.id)
        if (
          previous !== undefined &&
          (previous.organizationId !== input.organizationId ||
            previous.executorKind !== input.executorKind ||
            previous.deviceId !== input.deviceId)
        ) {
          return fail("invalid-authority", "Executor identity cannot be reassigned")
        }
        const executor: ExecutorInstance = {
          id: input.id,
          organizationId: input.organizationId,
          executorKind: input.executorKind,
          deviceId: input.deviceId,
          status: "online",
          connectedAt: previous?.connectedAt ?? input.now,
          lastSeenAt: input.now,
        }
        return succeed(executor, { ...current, executors: replace(current.executors, input.id, executor) })
      }),
    acquireAssignment: (input) =>
      mutation(state, (current) => {
        const thread = current.threads.get(input.threadId)?.thread
        const executor = current.executors.get(input.executorInstanceId)
        if (thread === undefined || thread.organizationId !== input.organizationId) {
          return fail("not-found", "Thread does not exist in the organization")
        }
        if (
          executor === undefined ||
          executor.organizationId !== input.organizationId ||
          executor.executorKind !== input.executorKind ||
          thread.executorKind !== input.executorKind
        ) {
          return fail("invalid-authority", "Executor does not match the immutable thread executor kind")
        }
        const previous = current.assignments.get(input.threadId)
        if (previous !== undefined && previous.expiresAt > input.now) {
          return fail("lease-unavailable", "Thread already has an active executor lease")
        }
        const generation = FencingGeneration.make(
          String(previous === undefined ? 1n : BigInt(previous.generation) + 1n),
        )
        const assignment: ExecutorAssignmentLease = {
          organizationId: input.organizationId,
          threadId: input.threadId,
          executorInstanceId: input.executorInstanceId,
          executorKind: input.executorKind,
          leaseId: input.leaseId,
          generation,
          acquiredAt: input.now,
          renewedAt: input.now,
          expiresAt: input.expiresAt,
        }
        return succeed(assignment, {
          ...current,
          assignments: replace(current.assignments, input.threadId, assignment),
        })
      }),
    renewAssignment: (input) =>
      mutation(state, (current) => {
        const previous = current.assignments.get(input.threadId)
        if (
          previous === undefined ||
          previous.organizationId !== input.organizationId ||
          previous.executorInstanceId !== input.executorInstanceId ||
          previous.leaseId !== input.leaseId ||
          previous.generation !== input.generation ||
          previous.expiresAt <= input.now
        ) {
          return fail("stale-fence", "Executor lease is expired or fenced")
        }
        const assignment = { ...previous, renewedAt: input.now, expiresAt: input.expiresAt }
        return succeed(assignment, {
          ...current,
          assignments: replace(current.assignments, input.threadId, assignment),
        })
      }),
    admitCommand: (input) =>
      mutation(state, (current) => {
        const threadState = current.threads.get(input.threadId)
        if (threadState === undefined || threadState.thread.organizationId !== input.organizationId) {
          return fail("not-found", "Thread does not exist in the organization")
        }
        const client = requireClient(current, input, input.admittedAt)
        if (
          client === undefined ||
          input.actor.organizationId !== input.organizationId ||
          input.actor.memberId !== input.memberId ||
          input.actor.clientId !== input.clientId ||
          input.actor.deviceId !== client.deviceId
        ) {
          return fail("invalid-authority", "Command actor attribution does not match the authenticated client")
        }
        const commands = current.commands.get(input.threadId) ?? []
        const previous = commands.find(
          (command) => command.commandId === input.commandId || command.idempotencyKey === input.idempotencyKey,
        )
        if (previous !== undefined) {
          return commandEquivalent(previous, input)
            ? succeed(previous, current)
            : fail("conflict", "Command identity or idempotency key was reused with different content")
        }
        if (input.command._tag === "TerminalInput") {
          const writer = current.writers.get(input.threadId)
          if (
            writer === undefined ||
            writer.organizationId !== input.organizationId ||
            writer.memberId !== input.memberId ||
            writer.clientId !== input.clientId ||
            writer.leaseId !== input.command.writerLeaseId ||
            writer.generation !== input.command.writerGeneration ||
            writer.expiresAt <= input.admittedAt
          ) {
            return fail("stale-fence", "Terminal writer lease is expired or fenced")
          }
        }
        const allocated = allocateCommitCursor(current, input.organizationId)
        const command: ThreadCommand = {
          ...input,
          sequence: Sequence.make(String(threadState.nextCommandSequence)),
          commitCursor: allocated.commitCursor,
        }
        return succeed(command, {
          ...current,
          organizationCounters: allocated.organizationCounters,
          threads: replace(current.threads, input.threadId, {
            ...threadState,
            nextCommandSequence: threadState.nextCommandSequence + 1n,
          }),
          commands: replace(current.commands, input.threadId, [...commands, command]),
        })
      }),
    readCommands: (input) =>
      Ref.get(state).pipe(
        Effect.flatMap((current) => {
          const thread = current.threads.get(input.threadId)?.thread
          if (
            requireClient(current, input) === undefined ||
            thread === undefined ||
            thread.organizationId !== input.organizationId
          ) {
            return Effect.fail(
              HostedRepositoryError.make({ reason: "invalid-authority", message: "Client is foreign" }),
            )
          }
          return Effect.succeed(
            (current.commands.get(input.threadId) ?? [])
              .filter((command) => BigInt(command.commitCursor) > BigInt(input.afterCommitCursor))
              .slice(0, Math.min(Math.max(Math.trunc(input.limit), 1), 1_000)),
          )
        }),
      ),
    appendEvent: (input) =>
      mutation(state, (current) => {
        const threadState = current.threads.get(input.threadId)
        if (threadState === undefined || threadState.thread.organizationId !== input.organizationId) {
          return fail("not-found", "Thread does not exist in the organization")
        }
        const events = current.events.get(input.threadId) ?? []
        const previous = events.find(
          (event) => event.eventId === input.eventId || event.idempotencyKey === input.idempotencyKey,
        )
        if (previous !== undefined) {
          return eventEquivalent(previous, input)
            ? succeed(previous, current)
            : fail("conflict", "Event identity or idempotency key was reused with different content")
        }
        const assignment = current.assignments.get(input.threadId)
        if (
          assignment === undefined ||
          assignment.organizationId !== input.organizationId ||
          assignment.executorInstanceId !== input.executorInstanceId ||
          assignment.leaseId !== input.leaseId ||
          assignment.generation !== input.assignmentGeneration ||
          assignment.expiresAt <= input.createdAt
        ) {
          return fail("stale-fence", "Executor assignment is expired or fenced")
        }
        const allocated = allocateCommitCursor(current, input.organizationId)
        const event: ThreadEvent = {
          organizationId: input.organizationId,
          threadId: input.threadId,
          eventId: input.eventId,
          idempotencyKey: input.idempotencyKey,
          executorInstanceId: input.executorInstanceId,
          assignmentGeneration: input.assignmentGeneration,
          sequence: Sequence.make(String(threadState.nextEventSequence)),
          commitCursor: allocated.commitCursor,
          commandSequence: input.commandSequence,
          event: input.event,
          createdAt: input.createdAt,
        }
        return succeed(event, {
          ...current,
          organizationCounters: allocated.organizationCounters,
          threads: replace(current.threads, input.threadId, {
            ...threadState,
            nextEventSequence: threadState.nextEventSequence + 1n,
          }),
          events: replace(current.events, input.threadId, [...events, event]),
        })
      }),
    readEvents: (input) =>
      Ref.get(state).pipe(
        Effect.flatMap((current) => {
          const thread = current.threads.get(input.threadId)?.thread
          if (
            requireClient(current, input) === undefined ||
            thread === undefined ||
            thread.organizationId !== input.organizationId
          ) {
            return Effect.fail(
              HostedRepositoryError.make({ reason: "invalid-authority", message: "Client is foreign" }),
            )
          }
          return Effect.succeed(
            (current.events.get(input.threadId) ?? [])
              .filter((event) => BigInt(event.commitCursor) > BigInt(input.afterCommitCursor))
              .slice(0, Math.min(Math.max(Math.trunc(input.limit), 1), 1_000)),
          )
        }),
      ),
    acknowledgeCursor: (input) =>
      mutation(state, (current) => {
        const threadState = current.threads.get(input.threadId)
        if (threadState === undefined || threadState.thread.organizationId !== input.organizationId) {
          return fail("not-found", "Thread does not exist in the organization")
        }
        if (requireClient(current, input, input.now) === undefined) {
          return fail("invalid-authority", "Client is inactive or foreign")
        }
        const eventExists = (current.events.get(input.threadId) ?? []).some(
          (event) => event.commitCursor === input.commitCursor,
        )
        if (!eventExists) {
          return fail("conflict", "Cursor must reference a persisted thread event")
        }
        const key = cursorKey(input.threadId, input.clientId)
        const previous = current.cursors.get(key)
        const commitCursor =
          previous !== undefined && BigInt(previous.commitCursor) > BigInt(input.commitCursor)
            ? previous.commitCursor
            : input.commitCursor
        const cursor: ResumableCursor = { ...input, commitCursor, updatedAt: input.now }
        return succeed(cursor, { ...current, cursors: replace(current.cursors, key, cursor) })
      }),
    acquireTerminalWriter: (input) =>
      mutation(state, (current) => {
        if (requireClient(current, input, input.now) === undefined) {
          return fail("invalid-authority", "Client is inactive or foreign")
        }
        const thread = current.threads.get(input.threadId)?.thread
        if (thread === undefined || thread.organizationId !== input.organizationId) {
          return fail("not-found", "Thread does not exist in the organization")
        }
        const previous = current.writers.get(input.threadId)
        if (previous !== undefined && previous.expiresAt > input.now) {
          return fail("lease-unavailable", "Thread already has an active terminal writer")
        }
        const generation = FencingGeneration.make(
          String(previous === undefined ? 1n : BigInt(previous.generation) + 1n),
        )
        const writer: TerminalWriterLease = {
          ...input,
          generation,
          acquiredAt: input.now,
          renewedAt: input.now,
        }
        return succeed(writer, { ...current, writers: replace(current.writers, input.threadId, writer) })
      }),
    renewTerminalWriter: (input) =>
      mutation(state, (current) => {
        if (requireClient(current, input, input.now) === undefined) {
          return fail("invalid-authority", "Client is inactive or foreign")
        }
        const previous = current.writers.get(input.threadId)
        if (
          previous === undefined ||
          previous.organizationId !== input.organizationId ||
          previous.memberId !== input.memberId ||
          previous.clientId !== input.clientId ||
          previous.leaseId !== input.leaseId ||
          previous.generation !== input.generation ||
          previous.expiresAt <= input.now
        ) {
          return fail("stale-fence", "Terminal writer lease is expired or fenced")
        }
        const writer = { ...previous, renewedAt: input.now, expiresAt: input.expiresAt }
        return succeed(writer, { ...current, writers: replace(current.writers, input.threadId, writer) })
      }),
    upsertPresence: (input) =>
      mutation(state, (current) => {
        if (requireClient(current, input, input.now) === undefined) {
          return fail("invalid-authority", "Client is inactive or foreign")
        }
        const presence: Presence = { ...input, lastSeenAt: input.now }
        return succeed(presence, {
          ...current,
          presence: replace(current.presence, cursorKey(input.threadId, input.clientId), presence),
        })
      }),
    listPresence: (input) =>
      Ref.get(state).pipe(
        Effect.flatMap((current) =>
          requireClient(current, input, input.now) === undefined
            ? Effect.fail(HostedRepositoryError.make({ reason: "invalid-authority", message: "Client is foreign" }))
            : Effect.succeed(
                [...current.presence.values()].filter(
                  (presence) =>
                    presence.organizationId === input.organizationId &&
                    presence.threadId === input.threadId &&
                    presence.expiresAt > input.now,
                ),
              ),
        ),
      ),
    bindLocalWorkspace: (input) =>
      mutation(state, (current) => {
        const thread = current.threads.get(input.threadId)?.thread
        const device = current.devices.get(input.deviceId)
        if (
          thread === undefined ||
          thread.organizationId !== input.organizationId ||
          thread.executorKind !== "local_device" ||
          device === undefined ||
          device.organizationId !== input.organizationId ||
          device.memberId !== input.memberId
        ) {
          return fail("invalid-authority", "Workspace binding requires the member's local thread and device")
        }
        const key = bindingKey(input.threadId, input.deviceId)
        const previous = current.bindings.get(key)
        const binding: LocalWorkspaceBinding = {
          ...input,
          id: previous?.id ?? input.id,
          createdAt: previous?.createdAt ?? input.now,
          lastSeenAt: input.now,
        }
        return succeed(binding, { ...current, bindings: replace(current.bindings, key, binding) })
      }),
    saveCheckpoint: (input) =>
      mutation(state, (current) => {
        const assignment = current.assignments.get(input.threadId)
        if (
          assignment === undefined ||
          assignment.organizationId !== input.organizationId ||
          assignment.executorInstanceId !== input.executorInstanceId ||
          assignment.leaseId !== input.leaseId ||
          assignment.generation !== input.assignmentGeneration ||
          assignment.expiresAt <= input.createdAt
        ) {
          return fail("stale-fence", "Executor assignment is expired or fenced")
        }
        if (current.checkpoints.has(input.id)) return fail("conflict", "Checkpoint identity already exists")
        const checkpoint: Checkpoint = {
          id: input.id,
          organizationId: input.organizationId,
          threadId: input.threadId,
          executorInstanceId: input.executorInstanceId,
          assignmentGeneration: input.assignmentGeneration,
          eventSequence: input.eventSequence,
          batonCheckpointReference: input.batonCheckpointReference,
          metadata: input.metadata,
          createdAt: input.createdAt,
        }
        return succeed(checkpoint, {
          ...current,
          checkpoints: replace(current.checkpoints, input.id, checkpoint),
        })
      }),
    recordAuditEvent: (input) =>
      mutation(state, (current) => {
        if (current.auditEvents.has(input.id)) return fail("conflict", "Audit event identity already exists")
        if (
          requireClient(
            current,
            {
              organizationId: input.organizationId,
              memberId: input.actorMemberId,
              clientId: input.actorClientId,
            },
            input.occurredAt,
          ) === undefined
        ) {
          return fail("invalid-authority", "Audit actor is inactive or foreign")
        }
        const allocated = allocateCommitCursor(current, input.organizationId)
        const event: AuditEvent = { ...input, commitCursor: allocated.commitCursor }
        return succeed(event, {
          ...current,
          auditEvents: replace(current.auditEvents, input.id, event),
          organizationCounters: allocated.organizationCounters,
        })
      }),
    putCredentialReference: (input) =>
      mutation(state, (current) => {
        if (input.projectId !== null) {
          const project = current.projects.get(input.projectId)
          if (project === undefined || project.organizationId !== input.organizationId) {
            return fail("not-found", "Credential project does not exist in the organization")
          }
        }
        const previous = current.credentialReferences.get(input.id)
        if (
          previous !== undefined &&
          (previous.organizationId !== input.organizationId ||
            previous.projectId !== input.projectId ||
            previous.provider !== input.provider ||
            previous.createdByMemberId !== input.createdByMemberId)
        ) {
          return fail("invalid-authority", "Credential reference identity cannot be reassigned")
        }
        const reference: CredentialReference = {
          id: input.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          provider: input.provider,
          purpose: input.purpose,
          externalReference: input.externalReference,
          metadata: input.metadata,
          createdByMemberId: input.createdByMemberId,
          createdAt: previous?.createdAt ?? input.now,
          updatedAt: input.now,
        }
        return succeed(reference, {
          ...current,
          credentialReferences: replace(current.credentialReferences, input.id, reference),
        })
      }),
  } satisfies HostedRepositoryInterface)
})

export const memoryLayer = Layer.effect(HostedRepository, make)
