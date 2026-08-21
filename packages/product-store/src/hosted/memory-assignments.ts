import { Clock, DateTime, Effect, Layer, Redacted, Ref } from "effect"
import {
  AssignmentRevision,
  type ExecutorAssignment,
  type WorkspaceCheckpointManifest,
} from "@rika/product/executor-assignment"
import { AssignmentLeaseEpoch, FencingGeneration, Sequence } from "@rika/product/hosted-model"
import {
  AssignmentError,
  ExecutorAssignments,
  type Access,
  type AssignmentFailureReason,
  type AssignmentsService,
  type Fence,
} from "@rika/product/executor-assignments"

interface AssignmentCredentials {
  readonly bootstrap?: Redacted.Redacted<string>
  readonly session?: Redacted.Redacted<string>
}

interface State {
  readonly assignments: Map<string, ExecutorAssignment>
  readonly credentials: Map<string, AssignmentCredentials>
  readonly checkpoints: Map<string, WorkspaceCheckpointManifest>
}

type FailedMutation = { readonly _tag: "Failure"; readonly error: AssignmentError }
type Mutation<A> = { readonly _tag: "Success"; readonly value: A; readonly state: State } | FailedMutation

const fail = (reason: AssignmentFailureReason, message: string): FailedMutation => ({
  _tag: "Failure",
  error: AssignmentError.make({ reason, message }),
})
const succeed = <A>(value: A, state: State): Mutation<A> => ({ _tag: "Success", value, state })
const timestamp = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))
const increment = (value: string) => String(BigInt(value) + 1n)

const make = Effect.gen(function* () {
  const state = yield* Ref.make<State>({ assignments: new Map(), credentials: new Map(), checkpoints: new Map() })

  const mutation = <A>(update: (state: State, now: string) => Mutation<A>) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((millis) =>
        Ref.modify(state, (current): readonly [Mutation<A>, State] => {
          const result = update(current, timestamp(millis))
          return result._tag === "Success" ? [result, result.state] : [result, current]
        }),
      ),
      Effect.flatMap((result) =>
        result._tag === "Success" ? Effect.succeed(result.value) : Effect.fail(result.error),
      ),
    )

  const load = (current: State, assignmentId: string) => current.assignments.get(assignmentId)
  const save = (current: State, assignment: ExecutorAssignment): State => ({
    ...current,
    assignments: new Map(current.assignments).set(assignment.id, assignment),
  })
  const saveCredentials = (current: State, assignmentId: string, credentials: AssignmentCredentials): State => ({
    ...current,
    credentials: new Map(current.credentials).set(assignmentId, credentials),
  })
  const version = (
    assignment: ExecutorAssignment | undefined,
    input: { readonly generation: string; readonly revision: string },
  ): FailedMutation | undefined => {
    if (assignment === undefined) return fail("not-found", "Executor assignment does not exist")
    if (assignment.generation !== input.generation || assignment.revision !== input.revision)
      return fail("conflict", "Executor assignment revision is stale")
    return undefined
  }
  const access = (
    assignment: ExecutorAssignment | undefined,
    credentials: AssignmentCredentials | undefined,
    input: Access,
    now: string,
    requireLiveLease = true,
  ): FailedMutation | undefined => {
    if (assignment === undefined) return fail("not-found", "Executor assignment does not exist")
    const lifecycle = assignment.lifecycle
    if (
      lifecycle._tag !== "Active" ||
      assignment.generation !== input.assignmentGeneration ||
      lifecycle.providerInstanceId !== input.providerInstanceId ||
      lifecycle.executorInstanceId !== input.executorInstanceId ||
      lifecycle.processIncarnation !== input.processIncarnation ||
      lifecycle.leaseEpoch !== input.leaseEpoch ||
      (requireLiveLease && lifecycle.leaseExpiresAt <= now)
    )
      return fail("stale-fence", "Executor assignment fence is stale")
    if (
      credentials?.session === undefined ||
      Redacted.value(credentials.session) !== Redacted.value(input.presentedSessionCredentialDigest)
    )
      return fail("authentication", "Executor session credential is invalid")
    return undefined
  }
  const fence = (assignment: ExecutorAssignment | undefined, input: Fence, now: string): FailedMutation | undefined => {
    if (assignment === undefined) return fail("not-found", "Executor assignment does not exist")
    const lifecycle = assignment.lifecycle
    if (
      lifecycle._tag !== "Active" ||
      assignment.generation !== input.assignmentGeneration ||
      lifecycle.leaseEpoch !== input.leaseEpoch ||
      lifecycle.leaseExpiresAt <= now
    )
      return fail("stale-fence", "Executor assignment fence is stale")
    return undefined
  }
  const revised = (
    assignment: ExecutorAssignment,
    now: string,
    changes: Partial<ExecutorAssignment>,
  ): ExecutorAssignment => ({
    ...assignment,
    ...changes,
    revision: AssignmentRevision.make(increment(assignment.revision)),
    updatedAt: now,
  })

  return ExecutorAssignments.of({
    create: (input) =>
      mutation((current, now) => {
        if (current.assignments.has(input.id)) return fail("conflict", "Executor assignment identity already exists")
        if ([...current.assignments.values()].some((assignment) => assignment.threadId === input.threadId))
          return fail("conflict", "Thread already has an executor assignment")
        const executorKind = input.placement._tag === "E2BPlacement" ? "e2b" : "local_device"
        const assignment: ExecutorAssignment = {
          id: input.id,
          ownerId: input.ownerId,
          threadId: input.threadId,
          workspaceId: input.workspaceId,
          executorKind,
          placement: input.placement,
          checkout: input.checkout,
          generation: FencingGeneration.make("1"),
          revision: AssignmentRevision.make("0"),
          lastLeaseEpoch: Sequence.make("0"),
          lifecycle: { _tag: "Pending" },
          capabilityGeneration: null,
          capabilities: null,
          cursor: { sequence: Sequence.make("0"), value: "" },
          latestCheckpointId: null,
          lastActiveAt: now,
          createdAt: now,
          updatedAt: now,
        }
        return succeed(assignment, saveCredentials(save(current, assignment), assignment.id, {}))
      }),
    get: (assignmentId) => Effect.map(Ref.get(state), (current) => load(current, assignmentId)),
    beginProvisioning: (input) =>
      mutation((current, now) => {
        const assignment = load(current, input.assignmentId)
        const invalid = version(assignment, input)
        if (invalid !== undefined) return invalid
        if (assignment!.lifecycle._tag === "Active" || assignment!.lifecycle._tag === "Terminated")
          return fail("invalid-state", "Assignment cannot begin provisioning")
        let providerInstanceId: string | null = null
        if (
          assignment!.lifecycle._tag === "Paused" ||
          assignment!.lifecycle._tag === "Provisioning" ||
          assignment!.lifecycle._tag === "AwaitingBootstrap"
        )
          providerInstanceId = assignment!.lifecycle.providerInstanceId
        const next = revised(assignment!, now, {
          lifecycle: {
            _tag: "Provisioning",
            providerInstanceId,
            bootstrapExpiresAt: timestamp(
              DateTime.toEpochMillis(DateTime.makeUnsafe(now)) + input.bootstrapLifetimeMillis,
            ),
          },
        })
        return succeed(
          next,
          saveCredentials(save(current, next), next.id, { bootstrap: input.bootstrapCredentialDigest }),
        )
      }),
    beginReplacement: (input) =>
      mutation((current, now) => {
        const assignment = load(current, input.assignmentId)
        const invalid = version(assignment, input)
        if (invalid !== undefined) return invalid
        if (assignment!.lifecycle._tag === "Terminated") return fail("invalid-state", "Assignment cannot be replaced")
        const next = revised(assignment!, now, {
          generation: FencingGeneration.make(increment(assignment!.generation)),
          lastLeaseEpoch: Sequence.make("0"),
          capabilityGeneration: null,
          capabilities: null,
          lifecycle: {
            _tag: "Provisioning",
            providerInstanceId: null,
            bootstrapExpiresAt: timestamp(
              DateTime.toEpochMillis(DateTime.makeUnsafe(now)) + input.bootstrapLifetimeMillis,
            ),
          },
        })
        return succeed(
          next,
          saveCredentials(save(current, next), next.id, { bootstrap: input.bootstrapCredentialDigest }),
        )
      }),
    bindProviderInstance: (input) =>
      mutation((current, now) => {
        const assignment = load(current, input.assignmentId)
        const invalid = version(assignment, input)
        if (invalid !== undefined) return invalid
        const lifecycle = assignment!.lifecycle
        if (lifecycle._tag !== "Provisioning") return fail("invalid-state", "Assignment is not provisioning")
        if (lifecycle.providerInstanceId !== null && lifecycle.providerInstanceId !== input.providerInstanceId)
          return fail("conflict", "Assignment is already bound to another provider instance")
        const next = revised(assignment!, now, {
          lifecycle: {
            _tag: "AwaitingBootstrap",
            providerInstanceId: input.providerInstanceId,
            bootstrapExpiresAt: lifecycle.bootstrapExpiresAt,
          },
        })
        return succeed(next, save(current, next))
      }),
    openSession: (input) =>
      mutation((current, now) => {
        const assignment = load(current, input.assignmentId)
        const invalid = version(assignment, input)
        if (invalid !== undefined) return invalid
        const lifecycle = assignment!.lifecycle
        if (lifecycle._tag !== "AwaitingBootstrap" || lifecycle.providerInstanceId !== input.providerInstanceId)
          return fail("stale-fence", "Executor bootstrap is invalid, expired, or consumed")
        const credentials = current.credentials.get(assignment!.id)
        if (
          credentials?.bootstrap === undefined ||
          Redacted.value(credentials.bootstrap) !== Redacted.value(input.presentedBootstrapCredentialDigest)
        )
          return fail("authentication", "Executor bootstrap credential is invalid")
        if (lifecycle.bootstrapExpiresAt <= now) return fail("stale-fence", "Executor bootstrap is expired or consumed")
        const leaseEpoch = AssignmentLeaseEpoch.make(increment(assignment!.lastLeaseEpoch))
        const next = revised(assignment!, now, {
          lastLeaseEpoch: Sequence.make(leaseEpoch),
          lifecycle: {
            _tag: "Active",
            providerInstanceId: input.providerInstanceId,
            executorInstanceId: input.executorInstanceId,
            processIncarnation: input.processIncarnation,
            leaseEpoch,
            leaseExpiresAt: timestamp(DateTime.toEpochMillis(DateTime.makeUnsafe(now)) + input.leaseLifetimeMillis),
          },
          capabilityGeneration: assignment!.generation,
          capabilities: input.capabilities,
          lastActiveAt: now,
        })
        return succeed(next, saveCredentials(save(current, next), next.id, { session: input.sessionCredentialDigest }))
      }),
    reconnect: (input) =>
      mutation((current, now) => {
        const assignment = load(current, input.access.assignmentId)
        const invalid = access(assignment, current.credentials.get(input.access.assignmentId), input.access, now, false)
        if (invalid !== undefined) return invalid
        const lifecycle = assignment!.lifecycle
        if (lifecycle._tag !== "Active") return fail("invalid-state", "Assignment is not active")
        const leaseEpoch = AssignmentLeaseEpoch.make(increment(assignment!.lastLeaseEpoch))
        const next = revised(assignment!, now, {
          lastLeaseEpoch: Sequence.make(leaseEpoch),
          lifecycle: {
            ...lifecycle,
            leaseEpoch,
            leaseExpiresAt: timestamp(DateTime.toEpochMillis(DateTime.makeUnsafe(now)) + input.leaseLifetimeMillis),
          },
          lastActiveAt: now,
        })
        return succeed(next, save(current, next))
      }),
    heartbeat: (input) =>
      mutation((current, now) => {
        const assignment = load(current, input.access.assignmentId)
        const invalid = access(assignment, current.credentials.get(input.access.assignmentId), input.access, now)
        if (invalid !== undefined) return invalid
        if (BigInt(input.cursor.sequence) < BigInt(assignment!.cursor.sequence))
          return fail("conflict", "Executor cursor cannot move backwards")
        if (input.cursor.sequence === assignment!.cursor.sequence && input.cursor.value !== assignment!.cursor.value)
          return fail("conflict", "Executor cursor conflicts at the same sequence")
        const lifecycle = assignment!.lifecycle
        if (lifecycle._tag !== "Active") return fail("invalid-state", "Assignment is not active")
        const next = revised(assignment!, now, {
          cursor: input.cursor,
          lifecycle: {
            ...lifecycle,
            leaseExpiresAt: timestamp(DateTime.toEpochMillis(DateTime.makeUnsafe(now)) + input.leaseLifetimeMillis),
          },
          lastActiveAt: now,
        })
        return succeed(next, save(current, next))
      }),
    authenticate: (input) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((millis) => {
          const now = timestamp(millis)
          return Ref.get(state).pipe(
            Effect.flatMap((current) => {
              const assignment = load(current, input.assignmentId)
              const invalid = access(assignment, current.credentials.get(input.assignmentId), input, now)
              return invalid === undefined ? Effect.succeed(assignment!) : Effect.fail(invalid.error)
            }),
          )
        }),
      ),
    release: (input) =>
      mutation((current, now) => {
        const assignment = load(current, input.assignmentId)
        const invalid = access(assignment, current.credentials.get(input.assignmentId), input, now, false)
        if (invalid !== undefined) return invalid
        const lifecycle = assignment!.lifecycle
        if (lifecycle._tag !== "Active") return fail("invalid-state", "Assignment is not active")
        const next = revised(assignment!, now, {
          lifecycle: { _tag: "Paused", providerInstanceId: lifecycle.providerInstanceId },
        })
        return succeed(next, saveCredentials(save(current, next), next.id, {}))
      }),
    validateFence: (input) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((millis) => {
          const now = timestamp(millis)
          return Ref.get(state).pipe(
            Effect.flatMap((current) => {
              const assignment = load(current, input.assignmentId)
              const invalid = fence(assignment, input, now)
              return invalid === undefined ? Effect.succeed(assignment!) : Effect.fail(invalid.error)
            }),
          )
        }),
      ),
    pause: (input) =>
      mutation((current, now) => {
        const assignment = load(current, input.assignmentId)
        const invalid = version(assignment, input)
        if (invalid !== undefined) return invalid
        const lifecycle = assignment!.lifecycle
        if (lifecycle._tag !== "Active") return fail("invalid-state", "Assignment is not active")
        const next = revised(assignment!, now, {
          lifecycle: { _tag: "Paused", providerInstanceId: lifecycle.providerInstanceId },
        })
        return succeed(next, saveCredentials(save(current, next), next.id, {}))
      }),
    resume: (input) =>
      mutation((current, now) => {
        const assignment = load(current, input.assignmentId)
        const invalid = version(assignment, input)
        if (invalid !== undefined) return invalid
        if (assignment!.lifecycle._tag !== "Paused") return fail("invalid-state", "Assignment is not paused")
        const next = revised(assignment!, now, {
          lifecycle: {
            _tag: "Provisioning",
            providerInstanceId: assignment!.lifecycle.providerInstanceId,
            bootstrapExpiresAt: timestamp(
              DateTime.toEpochMillis(DateTime.makeUnsafe(now)) + input.bootstrapLifetimeMillis,
            ),
          },
        })
        return succeed(
          next,
          saveCredentials(save(current, next), next.id, { bootstrap: input.bootstrapCredentialDigest }),
        )
      }),
    terminate: (input) =>
      mutation((current, now) => {
        const assignment = load(current, input.assignmentId)
        const invalid = version(assignment, input)
        if (invalid !== undefined) return invalid
        const next = revised(assignment!, now, { lifecycle: { _tag: "Terminated" } })
        return succeed(next, saveCredentials(save(current, next), next.id, {}))
      }),
    commitCheckpoint: (input) =>
      mutation((current, now) => {
        const assignment = load(current, input.access.assignmentId)
        const invalid = access(assignment, current.credentials.get(input.access.assignmentId), input.access, now)
        if (invalid !== undefined) return invalid
        if (input.cursor.sequence !== assignment!.cursor.sequence || input.cursor.value !== assignment!.cursor.value)
          return fail("conflict", "Checkpoint cursor is not the acknowledged executor cursor")
        const existing = current.checkpoints.get(input.id)
        if (existing !== undefined) {
          const same =
            existing.assignmentId === input.access.assignmentId &&
            existing.assignmentGeneration === input.access.assignmentGeneration &&
            existing.objectKey === input.objectKey &&
            existing.contentDigest === input.contentDigest &&
            existing.sizeBytes === input.sizeBytes &&
            existing.cursor.sequence === input.cursor.sequence &&
            existing.cursor.value === input.cursor.value
          return same ? succeed(existing, current) : fail("conflict", "Checkpoint identity has different content")
        }
        const lifecycle = assignment!.lifecycle
        if (lifecycle._tag !== "Active") return fail("invalid-state", "Assignment is not active")
        const checkpoint: WorkspaceCheckpointManifest = {
          id: input.id,
          ownerId: assignment!.ownerId,
          threadId: assignment!.threadId,
          assignmentId: assignment!.id,
          executorInstanceId: lifecycle.executorInstanceId,
          assignmentGeneration: assignment!.generation,
          leaseEpoch: lifecycle.leaseEpoch,
          objectKey: input.objectKey,
          contentDigest: input.contentDigest,
          sizeBytes: input.sizeBytes,
          format: input.format,
          cursor: input.cursor,
          metadata: input.metadata,
          verifiedAt: now,
        }
        const next = revised(assignment!, now, { latestCheckpointId: input.id })
        return succeed(checkpoint, {
          assignments: new Map(current.assignments).set(next.id, next),
          credentials: current.credentials,
          checkpoints: new Map(current.checkpoints).set(input.id, checkpoint),
        })
      }),
    latestCheckpoint: (assignmentId) =>
      Effect.map(Ref.get(state), (current) => {
        const checkpointId = current.assignments.get(assignmentId)?.latestCheckpointId
        return checkpointId === null || checkpointId === undefined ? undefined : current.checkpoints.get(checkpointId)
      }),
    listManaged: Effect.map(Ref.get(state), (current) => [...current.assignments.values()]),
  } satisfies AssignmentsService)
})

export const layer = Layer.effect(ExecutorAssignments, make)
