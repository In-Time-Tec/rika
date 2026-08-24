import { Clock, DateTime, Effect, Layer, Ref, Schema } from "effect"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import {
  ActorAttribution,
  type AuditEvent,
  type AuthenticatedClient,
  type AuthenticatedDevice,
  CommitCursor,
  type CredentialReference,
  FencingGeneration,
  HostedOwner,
  type HostedThread,
  type HostedOwnerRecord,
  type HostedWorkspace,
  type Presence,
  type Project,
  type ProjectGrant,
  type ResumableCursor,
  Sequence,
  type TerminalWriterLease,
  type ThreadCommand,
  type ThreadEvent,
  type ThreadGrant,
  Timestamp,
} from "@rika/product/hosted-model"
import { HostedStore, StoreError, type StoreFailureReason, type StoreService } from "@rika/product/hosted-store"
import { isAuthorized, type AuthorizationAction, type AuthorizationSubject } from "@rika/product/hosted-authorization"
import type { TurnId } from "@rika/product/turn-record"
import { layer as assignmentLayer } from "./memory-assignments"

interface ThreadState {
  readonly thread: HostedThread
  readonly nextCommandSequence: bigint
  readonly nextEventSequence: bigint
}

interface State {
  readonly owners: Map<string, HostedOwnerRecord>
  readonly projects: Map<string, Project>
  readonly projectGrants: Map<string, ProjectGrant>
  readonly workspaces: Map<string, HostedWorkspace>
  readonly threads: Map<string, ThreadState>
  readonly threadGrants: Map<string, ThreadGrant>
  readonly devices: Map<string, AuthenticatedDevice>
  readonly clients: Map<string, AuthenticatedClient>
  readonly clientAuthorities: Map<string, Timestamp>
  readonly commands: Map<string, ReadonlyArray<ThreadCommand>>
  readonly promptTurns: Map<string, { readonly turnId: TurnId; readonly status: "accepted" | "queued" }>
  readonly events: Map<string, ReadonlyArray<ThreadEvent>>
  readonly cursors: Map<string, ResumableCursor>
  readonly writers: Map<string, TerminalWriterLease>
  readonly presence: Map<string, Presence>
  readonly auditEvents: Map<string, AuditEvent>
  readonly credentialReferences: Map<string, CredentialReference>
  readonly ownerCounters: Map<string, bigint>
}

type Mutation<A> =
  | { readonly _tag: "Success"; readonly value: A; readonly state: State }
  | { readonly _tag: "Failure"; readonly error: StoreError }

const emptyState = (): State => ({
  owners: new Map(),
  projects: new Map(),
  projectGrants: new Map(),
  workspaces: new Map(),
  threads: new Map(),
  threadGrants: new Map(),
  devices: new Map(),
  clients: new Map(),
  clientAuthorities: new Map(),
  commands: new Map(),
  promptTurns: new Map(),
  events: new Map(),
  cursors: new Map(),
  writers: new Map(),
  presence: new Map(),
  auditEvents: new Map(),
  credentialReferences: new Map(),
  ownerCounters: new Map(),
})

const fail = (reason: StoreFailureReason, message: string): Mutation<never> => ({
  _tag: "Failure",
  error: StoreError.make({ reason, message }),
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
const clientAuthorityKey = (clientId: string, ownerId: string) => `${clientId}\u0000${ownerId}`
const ownerEquivalent = Schema.toEquivalence(HostedOwner)
const allocateCommitCursor = (current: State, ownerId: string) => {
  const next = current.ownerCounters.get(ownerId) ?? 1n
  return {
    commitCursor: CommitCursor.make(String(next)),
    ownerCounters: replace(current.ownerCounters, ownerId, next + 1n),
  }
}
const commandEquivalent = Schema.toEquivalence(
  Schema.Struct({
    ownerId: Schema.String,
    threadId: Schema.String,
    commandId: Schema.String,
    idempotencyKey: Schema.String,
    actor: ActorAttribution,
    command: Schema.Record(Schema.String, Schema.Unknown),
  }),
)
const eventEquivalent = Schema.toEquivalence(
  Schema.Struct({
    ownerId: Schema.String,
    threadId: Schema.String,
    eventId: Schema.String,
    idempotencyKey: Schema.String,
    assignmentId: Schema.String,
    executorInstanceId: Schema.String,
    assignmentGeneration: Schema.String,
    leaseEpoch: Schema.String,
    commandSequence: Schema.NullOr(Schema.String),
    event: Schema.Record(Schema.String, Schema.Unknown),
  }),
)
const assignmentFailure = (message: string, database: boolean) =>
  StoreError.make({ reason: database ? "database" : "stale-fence", message })

const make = Effect.gen(function* () {
  const state = yield* Ref.make(emptyState())
  const assignments = yield* ExecutorAssignments

  const requireClient = (current: State, input: { ownerId: string; actor: ActorAttribution }, at?: string) => {
    const owner = current.owners.get(input.ownerId)
    const client = current.clients.get(input.actor.clientId)
    const device = current.devices.get(input.actor.deviceId)
    const authorityExpiry = current.clientAuthorities.get(clientAuthorityKey(input.actor.clientId, input.ownerId))
    return client !== undefined &&
      device !== undefined &&
      owner !== undefined &&
      ownerEquivalent(input.actor.owner, owner.identity) &&
      client.userId === input.actor.userId &&
      client.deviceId === input.actor.deviceId &&
      client.revokedAt === null &&
      device.revokedAt === null &&
      authorityExpiry !== undefined &&
      (at === undefined || (client.expiresAt > at && authorityExpiry > at))
      ? client
      : undefined
  }

  const requireAccess = (
    current: State,
    input: { ownerId: string; threadId: string; actor: ActorAttribution },
    action: AuthorizationAction,
    at?: string,
  ) => {
    if (requireClient(current, input, at) === undefined) return false
    const thread = current.threads.get(input.threadId)?.thread
    if (thread === undefined || thread.ownerId !== input.ownerId) return false
    if (input.actor._tag === "PersonalActor" || thread.createdByUserId === input.actor.userId) return true
    const direct = current.threadGrants.get(threadGrantKey(input.threadId, input.actor.membershipId))
    const inherited =
      thread.executorKind === "orb" && thread.inheritProjectGrants && thread.projectId !== undefined
        ? current.projectGrants.get(projectGrantKey(thread.projectId, input.actor.membershipId))
        : undefined
    const authorization: AuthorizationSubject = {
      memberId: input.actor.membershipId,
      executorKind: thread.executorKind,
      inheritProjectGrants: thread.inheritProjectGrants,
    }
    if (direct !== undefined) Object.assign(authorization, { threadRole: direct.role })
    if (inherited !== undefined) Object.assign(authorization, { projectRole: inherited.role })
    return isAuthorized(authorization, action)
  }

  return HostedStore.of({
    putOwner: (input) =>
      mutation(state, (current) => {
        const previous = current.owners.get(input.id)
        if (previous !== undefined) {
          return ownerEquivalent(previous.identity, input.identity)
            ? succeed(previous, current)
            : fail("conflict", "Owner identity cannot be reassigned")
        }
        if ([...current.owners.values()].some((owner) => ownerEquivalent(owner.identity, input.identity))) {
          return fail("conflict", "Owner identity already has a stable owner ID")
        }
        const owner: HostedOwnerRecord = { id: input.id, identity: input.identity, createdAt: input.now }
        return succeed(owner, { ...current, owners: replace(current.owners, input.id, owner) })
      }),
    createProject: (input) =>
      mutation(state, (current) => {
        if (!current.owners.has(input.ownerId)) return fail("not-found", "Owner does not exist")
        if (current.projects.has(input.id)) return fail("conflict", "Project identity already exists")
        const project: Project = {
          id: input.id,
          ownerId: input.ownerId,
          name: input.name,
          createdByUserId: input.createdByUserId,
          createdAt: input.now,
          updatedAt: input.now,
        }
        return succeed(project, {
          ...current,
          projects: replace(current.projects, input.id, project),
        })
      }),
    putProjectGrant: (input) =>
      mutation(state, (current) => {
        const project = current.projects.get(input.projectId)
        const owner = current.owners.get(input.ownerId)
        if (owner?.identity._tag !== "OrganizationOwner")
          return fail("invalid-authority", "Project grants require an organization owner")
        if (project === undefined || project.ownerId !== input.ownerId) {
          return fail("not-found", "Project does not exist for the owner")
        }
        const key = projectGrantKey(input.projectId, input.membershipId)
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
        if (!current.owners.has(input.ownerId)) return fail("not-found", "Owner does not exist")
        if (input.projectId !== undefined) {
          const project = current.projects.get(input.projectId)
          if (project === undefined || project.ownerId !== input.ownerId)
            return fail("not-found", "Project does not exist for the owner")
        }
        if (current.workspaces.has(input.id)) return fail("conflict", "Workspace identity already exists")
        if (input.executorKind === "runner" && input.inheritProjectGrants === true) {
          return fail("invalid-authority", "Local workspaces cannot inherit project grants")
        }
        const workspace: HostedWorkspace = {
          id: input.id,
          ownerId: input.ownerId,
          createdByUserId: input.createdByUserId,
          executorKind: input.executorKind,
          inheritProjectGrants: input.executorKind === "orb" ? (input.inheritProjectGrants ?? true) : false,
          createdAt: input.now,
        }
        if (input.projectId !== undefined) Object.assign(workspace, { projectId: input.projectId })
        return succeed(workspace, {
          ...current,
          workspaces: replace(current.workspaces, input.id, workspace),
        })
      }),
    createThread: (input) =>
      mutation(state, (current) => {
        const workspace = current.workspaces.get(input.workspaceId)
        if (workspace === undefined || workspace.ownerId !== input.ownerId || workspace.projectId !== input.projectId) {
          return fail("not-found", "Workspace does not belong to the project and organization")
        }
        if (workspace.executorKind !== input.executorKind) {
          return fail("invalid-authority", "Thread placement must match its immutable workspace placement")
        }
        if (current.threads.has(input.id)) return fail("conflict", "Thread identity already exists")
        if (input.executorKind === "runner" && input.inheritProjectGrants === true) {
          return fail("invalid-authority", "Local threads cannot inherit project grants")
        }
        const thread: HostedThread = {
          id: input.id,
          ownerId: input.ownerId,
          workspaceId: input.workspaceId,
          createdByUserId: input.createdByUserId,
          executorKind: input.executorKind,
          inheritProjectGrants:
            input.executorKind === "orb" ? (input.inheritProjectGrants ?? workspace.inheritProjectGrants) : false,
          createdAt: input.now,
        }
        if (input.projectId !== undefined) Object.assign(thread, { projectId: input.projectId })
        return succeed(thread, {
          ...current,
          threads: replace(current.threads, input.id, {
            thread,
            nextCommandSequence: 1n,
            nextEventSequence: 1n,
          }),
        })
      }),
    readThread: (input) =>
      Ref.get(state).pipe(
        Effect.map((current) => {
          const thread = current.threads.get(input.threadId)?.thread
          return thread?.ownerId === input.ownerId ? thread : undefined
        }),
      ),
    putThreadGrant: (input) =>
      mutation(state, (current) => {
        const thread = current.threads.get(input.threadId)?.thread
        const owner = current.owners.get(input.ownerId)
        if (owner?.identity._tag !== "OrganizationOwner")
          return fail("invalid-authority", "Thread grants require an organization owner")
        if (thread === undefined || thread.ownerId !== input.ownerId) {
          return fail("not-found", "Thread does not exist for the owner")
        }
        const key = threadGrantKey(input.threadId, input.membershipId)
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
        if (previous !== undefined && (previous.userId !== input.userId || previous.revokedAt !== null)) {
          return fail("invalid-authority", "Device identity cannot be reassigned")
        }
        const device: AuthenticatedDevice = {
          id: input.id,
          userId: input.userId,
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
        if (device === undefined || device.userId !== input.userId || device.revokedAt !== null) {
          return fail("invalid-authority", "Client device is inactive or foreign")
        }
        if (input.expiresAt <= input.now || Date.parse(input.expiresAt) - Date.parse(input.now) > 5 * 60 * 1_000)
          return fail("invalid-authority", "Client authority exceeds five minutes")
        const previous = current.clients.get(input.id)
        if (
          previous !== undefined &&
          (previous.userId !== input.userId || previous.deviceId !== input.deviceId || previous.revokedAt !== null)
        ) {
          return fail("invalid-authority", "Client identity cannot be reassigned")
        }
        const client: AuthenticatedClient = {
          id: input.id,
          userId: input.userId,
          deviceId: input.deviceId,
          authenticatedAt: input.now,
          lastSeenAt: input.now,
          expiresAt: input.expiresAt,
          revokedAt: null,
        }
        return succeed(client, { ...current, clients: replace(current.clients, input.id, client) })
      }),
    validateClient: (input) =>
      Ref.get(state).pipe(
        Effect.filterOrFail(
          (current) => {
            const client = current.clients.get(input.clientId)
            const device = current.devices.get(input.deviceId)
            return (
              client !== undefined &&
              device !== undefined &&
              client.userId === input.userId &&
              client.deviceId === input.deviceId &&
              client.revokedAt === null &&
              device.revokedAt === null &&
              client.expiresAt > input.at
            )
          },
          () => StoreError.make({ reason: "invalid-authority", message: "Client authority is inactive or foreign" }),
        ),
        Effect.asVoid,
      ),
    grantClientAuthority: (input) =>
      mutation(state, (current) => {
        const owner = current.owners.get(input.ownerId)
        const client = current.clients.get(input.actor.clientId)
        const device = current.devices.get(input.actor.deviceId)
        if (
          owner === undefined ||
          client === undefined ||
          device === undefined ||
          !ownerEquivalent(input.actor.owner, owner.identity) ||
          client.userId !== input.actor.userId ||
          client.deviceId !== input.actor.deviceId ||
          client.revokedAt !== null ||
          device.revokedAt !== null ||
          client.expiresAt <= input.now ||
          input.expiresAt <= input.now ||
          Date.parse(input.expiresAt) - Date.parse(input.now) > 5 * 60 * 1_000
        )
          return fail("invalid-authority", "Client owner authority is inactive or foreign")
        const expiresAt = client.expiresAt < input.expiresAt ? client.expiresAt : input.expiresAt
        return succeed(undefined, {
          ...current,
          clientAuthorities: replace(
            current.clientAuthorities,
            clientAuthorityKey(input.actor.clientId, input.ownerId),
            expiresAt,
          ),
        })
      }),
    authorizeThread: (input) =>
      Ref.get(state).pipe(
        Effect.filterOrFail(
          (current) => requireAccess(current, input, input.action, input.at),
          () => StoreError.make({ reason: "invalid-authority", message: "Resource is unavailable" }),
        ),
        Effect.asVoid,
      ),
    admitCommand: (input) =>
      mutation(state, (current) => {
        const threadState = current.threads.get(input.threadId)
        if (threadState === undefined || threadState.thread.ownerId !== input.ownerId) {
          return fail("not-found", "Thread does not exist in the organization")
        }
        const client = requireClient(current, input, input.admittedAt)
        if (!requireAccess(current, input, "thread:control", input.admittedAt) || client === undefined) {
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
            writer.ownerId !== input.ownerId ||
            writer.actor.clientId !== input.actor.clientId ||
            writer.leaseId !== input.command.writerLeaseId ||
            writer.generation !== input.command.writerGeneration ||
            writer.expiresAt <= input.admittedAt
          ) {
            return fail("stale-fence", "Terminal writer lease is expired or fenced")
          }
        }
        const allocated = allocateCommitCursor(current, input.ownerId)
        const command: ThreadCommand = {
          ...input,
          sequence: Sequence.make(String(threadState.nextCommandSequence)),
          commitCursor: allocated.commitCursor,
        }
        return succeed(command, {
          ...current,
          ownerCounters: allocated.ownerCounters,
          threads: replace(current.threads, input.threadId, {
            ...threadState,
            nextCommandSequence: threadState.nextCommandSequence + 1n,
          }),
          commands: replace(current.commands, input.threadId, [...commands, command]),
        })
      }),
    admitPrompt: (input) =>
      mutation(state, (current) => {
        if (input.prompt.length === 0) return fail("conflict", "Prompt cannot be empty")
        const queueCapacity = Math.trunc(input.queueCapacity)
        if (queueCapacity < 1) return fail("conflict", "Prompt queue capacity must be positive")
        if (!Number.isFinite(Date.parse(input.admittedAt)))
          return fail("conflict", "Prompt admission timestamp is invalid")
        const threadState = current.threads.get(input.threadId)
        if (threadState === undefined || threadState.thread.ownerId !== input.ownerId)
          return fail("not-found", "Thread does not exist in the organization")
        const client = requireClient(current, input, input.admittedAt)
        if (!requireAccess(current, input, "thread:control", input.admittedAt) || client === undefined)
          return fail("invalid-authority", "Command actor attribution does not match the authenticated client")
        const commands = current.commands.get(input.threadId) ?? []
        const previous = commands.find(
          (command) => command.commandId === input.commandId || command.idempotencyKey === input.idempotencyKey,
        )
        const comparable = {
          ...input,
          command: { _tag: "SubmitPrompt" as const, prompt: input.prompt, mode: input.executionRoute.mode },
        }
        if (previous !== undefined) {
          const admission = current.promptTurns.get(previous.commandId)
          if (admission === undefined) return fail("conflict", "Command identity was admitted without a Turn")
          return commandEquivalent(previous, comparable)
            ? succeed({ command: previous, ...admission }, current)
            : fail("conflict", "Command identity or idempotency key was reused with different content")
        }
        if (!input.readinessProof) return fail("database", "Prompt admission workers are unavailable")
        if ([...current.promptTurns.values()].some((admission) => admission.turnId === input.turnId))
          return fail("conflict", "Turn identity is already in use")
        const status = commands.some((command) => current.promptTurns.has(command.commandId))
          ? ("queued" as const)
          : ("accepted" as const)
        if (
          status === "queued" &&
          commands.filter((command) => current.promptTurns.get(command.commandId)?.status === "queued").length >=
            queueCapacity
        )
          return fail("conflict", "Thread prompt queue is full")
        const allocated = allocateCommitCursor(current, input.ownerId)
        const command: ThreadCommand = {
          ownerId: input.ownerId,
          threadId: input.threadId,
          commandId: input.commandId,
          idempotencyKey: input.idempotencyKey,
          actor: input.actor,
          command: comparable.command,
          admittedAt: input.admittedAt,
          sequence: Sequence.make(String(threadState.nextCommandSequence)),
          commitCursor: allocated.commitCursor,
        }
        return succeed(
          { command, turnId: input.turnId, status },
          {
            ...current,
            ownerCounters: allocated.ownerCounters,
            threads: replace(current.threads, input.threadId, {
              ...threadState,
              nextCommandSequence: threadState.nextCommandSequence + 1n,
            }),
            commands: replace(current.commands, input.threadId, [...commands, command]),
            promptTurns: replace(current.promptTurns, input.commandId, { turnId: input.turnId, status }),
          },
        )
      }),
    readCommands: (input) =>
      Ref.get(state).pipe(
        Effect.flatMap((current) => {
          const thread = current.threads.get(input.threadId)?.thread
          if (
            !requireAccess(current, input, "thread:view") ||
            thread === undefined ||
            thread.ownerId !== input.ownerId
          ) {
            return Effect.fail(StoreError.make({ reason: "invalid-authority", message: "Client is foreign" }))
          }
          return Effect.succeed(
            (current.commands.get(input.threadId) ?? [])
              .filter((command) => BigInt(command.commitCursor) > BigInt(input.afterCommitCursor))
              .slice(0, Math.min(Math.max(Math.trunc(input.limit), 1), 1_000)),
          )
        }),
      ),
    appendEvent: (input) =>
      assignments.validateFence(input).pipe(
        Effect.mapError((cause) => assignmentFailure(cause.message, cause.reason === "database")),
        Effect.flatMap((assignment) => {
          const lifecycle = assignment.lifecycle
          if (lifecycle._tag !== "Active") {
            return Effect.fail(assignmentFailure("Executor assignment fence is stale", false))
          }
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap((millis) =>
              mutation(state, (current) => {
                const threadState = current.threads.get(assignment.threadId)
                if (threadState === undefined || threadState.thread.ownerId !== assignment.ownerId) {
                  return fail("not-found", "Thread does not exist in the organization")
                }
                const events = current.events.get(assignment.threadId) ?? []
                const previous = events.find(
                  (event) => event.eventId === input.eventId || event.idempotencyKey === input.idempotencyKey,
                )
                const comparable = {
                  ...input,
                  ownerId: assignment.ownerId,
                  threadId: assignment.threadId,
                  executorInstanceId: lifecycle.executorInstanceId,
                }
                if (previous !== undefined) {
                  return eventEquivalent(previous, comparable)
                    ? succeed(previous, current)
                    : fail("conflict", "Event identity or idempotency key was reused with different content")
                }
                const allocated = allocateCommitCursor(current, assignment.ownerId)
                const event: ThreadEvent = {
                  ...comparable,
                  sequence: Sequence.make(String(threadState.nextEventSequence)),
                  commitCursor: allocated.commitCursor,
                  createdAt: Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(millis))),
                }
                return succeed(event, {
                  ...current,
                  ownerCounters: allocated.ownerCounters,
                  threads: replace(current.threads, assignment.threadId, {
                    ...threadState,
                    nextEventSequence: threadState.nextEventSequence + 1n,
                  }),
                  events: replace(current.events, assignment.threadId, [...events, event]),
                })
              }),
            ),
          )
        }),
      ),
    appendRecoveredEvent: () =>
      Effect.fail(
        StoreError.make({
          reason: "invalid-authority",
          message: "Recovered events require PostgreSQL operation authority",
        }),
      ),
    readEvents: (input) =>
      Ref.get(state).pipe(
        Effect.flatMap((current) => {
          const thread = current.threads.get(input.threadId)?.thread
          if (
            !requireAccess(current, input, "thread:view") ||
            thread === undefined ||
            thread.ownerId !== input.ownerId
          ) {
            return Effect.fail(StoreError.make({ reason: "invalid-authority", message: "Client is foreign" }))
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
        if (threadState === undefined || threadState.thread.ownerId !== input.ownerId) {
          return fail("not-found", "Thread does not exist in the organization")
        }
        if (!requireAccess(current, input, "thread:view", input.now)) {
          return fail("invalid-authority", "Client is inactive or foreign")
        }
        const eventExists = (current.events.get(input.threadId) ?? []).some(
          (event) => event.commitCursor === input.commitCursor,
        )
        if (!eventExists) {
          return fail("conflict", "Cursor must reference a persisted thread event")
        }
        const key = cursorKey(input.threadId, input.actor.clientId)
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
        if (!requireAccess(current, input, "terminal:input", input.now)) {
          return fail("invalid-authority", "Client is inactive or foreign")
        }
        const thread = current.threads.get(input.threadId)?.thread
        if (thread === undefined || thread.ownerId !== input.ownerId) {
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
        if (!requireAccess(current, input, "terminal:input", input.now)) {
          return fail("invalid-authority", "Client is inactive or foreign")
        }
        const previous = current.writers.get(input.threadId)
        if (
          previous === undefined ||
          previous.ownerId !== input.ownerId ||
          previous.actor.clientId !== input.actor.clientId ||
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
        if (!requireAccess(current, input, "presence:update", input.now)) {
          return fail("invalid-authority", "Client is inactive or foreign")
        }
        const presence: Presence = { ...input, lastSeenAt: input.now }
        return succeed(presence, {
          ...current,
          presence: replace(current.presence, cursorKey(input.threadId, input.actor.clientId), presence),
        })
      }),
    listPresence: (input) =>
      Ref.get(state).pipe(
        Effect.flatMap((current) =>
          !requireAccess(current, input, "presence:view", input.now)
            ? Effect.fail(StoreError.make({ reason: "invalid-authority", message: "Client is foreign" }))
            : Effect.succeed(
                [...current.presence.values()].filter(
                  (presence) =>
                    presence.ownerId === input.ownerId &&
                    presence.threadId === input.threadId &&
                    presence.expiresAt > input.now,
                ),
              ),
        ),
      ),
    recordAuditEvent: (input) =>
      mutation(state, (current) => {
        if (current.auditEvents.has(input.id)) return fail("conflict", "Audit event identity already exists")
        if (requireClient(current, input, input.occurredAt) === undefined) {
          return fail("invalid-authority", "Audit actor is inactive or foreign")
        }
        const allocated = allocateCommitCursor(current, input.ownerId)
        const event: AuditEvent = { ...input, commitCursor: allocated.commitCursor }
        return succeed(event, {
          ...current,
          auditEvents: replace(current.auditEvents, input.id, event),
          ownerCounters: allocated.ownerCounters,
        })
      }),
    putCredentialReference: (input) =>
      mutation(state, (current) => {
        if (!current.owners.has(input.ownerId)) return fail("not-found", "Owner does not exist")
        if (input.projectId !== undefined) {
          const project = current.projects.get(input.projectId)
          if (project === undefined || project.ownerId !== input.ownerId) {
            return fail("not-found", "Credential project does not exist in the organization")
          }
        }
        const previous = current.credentialReferences.get(input.id)
        if (
          previous !== undefined &&
          (previous.ownerId !== input.ownerId ||
            previous.projectId !== input.projectId ||
            previous.provider !== input.provider ||
            previous.createdByUserId !== input.createdByUserId)
        ) {
          return fail("invalid-authority", "Credential reference identity cannot be reassigned")
        }
        const reference: CredentialReference = {
          id: input.id,
          ownerId: input.ownerId,
          provider: input.provider,
          purpose: input.purpose,
          externalReference: input.externalReference,
          metadata: input.metadata,
          createdByUserId: input.createdByUserId,
          createdAt: previous?.createdAt ?? input.now,
          updatedAt: input.now,
        }
        if (input.projectId !== undefined) Object.assign(reference, { projectId: input.projectId })
        return succeed(reference, {
          ...current,
          credentialReferences: replace(current.credentialReferences, input.id, reference),
        })
      }),
  } satisfies StoreService)
})

const storeLayer = Layer.effect(HostedStore, make).pipe(Layer.provide(assignmentLayer))

export const layer = Layer.merge(storeLayer, assignmentLayer)
