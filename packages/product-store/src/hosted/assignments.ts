import * as PgClient from "@effect/sql-pg/PgClient"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { and, asc, eq, sql as expression } from "drizzle-orm"
import type { PgUpdateSetSource } from "drizzle-orm/pg-core"
import { Effect, Layer, Redacted, Schema } from "effect"
import {
  ExecutorAssignment,
  WorkspaceCheckpointManifest,
  type WorkspaceCheckpointManifest as WorkspaceCheckpointManifestValue,
} from "@rika/product/executor-assignment"
import {
  AssignmentError,
  ExecutorAssignments,
  type Access,
  type AssignmentsService,
  type Fence,
  type Version,
} from "@rika/product/executor-assignments"
import { ExecutorAssignmentId, JsonObject } from "@rika/product/hosted-model"
import {
  rikaHostedCheckpoints,
  rikaHostedExecutorAssignments,
  rikaHostedThreads,
} from "../database/schema/product"

type AssignmentRecord = typeof rikaHostedExecutorAssignments.$inferSelect
type AssignmentRow = Omit<AssignmentRecord, "bootstrapDigest" | "capabilitySnapshot" | "sessionDigest" | "generation" |
  "revision" | "lastLeaseEpoch" | "capabilityGeneration" | "leaseEpoch" | "cursorSequence" | "bootstrapExpiresAt" |
  "leaseExpiresAt" | "lastActiveAt" | "createdAt" | "updatedAt"> & {
  readonly generation: string
  readonly revision: string
  readonly lastLeaseEpoch: string
  readonly capabilityGeneration: string | null
  readonly capabilities: unknown | null
  readonly bootstrapCredentialDigest: string | null
  readonly bootstrapExpiresAt: string | null
  readonly bootstrapLive: boolean
  readonly sessionCredentialDigest: string | null
  readonly leaseEpoch: string | null
  readonly leaseExpiresAt: string | null
  readonly leaseLive: boolean
  readonly cursorSequence: string
  readonly lastActiveAt: string
  readonly createdAt: string
  readonly updatedAt: string
}
type CheckpointRecord = typeof rikaHostedCheckpoints.$inferSelect
type CheckpointRow = Omit<CheckpointRecord, "assignmentGeneration" | "leaseEpoch" | "cursorSequence" | "verifiedAt"> & {
  readonly assignmentGeneration: string
  readonly leaseEpoch: string
  readonly cursorSequence: string
  readonly verifiedAt: string
}

const databaseError = (cause: unknown) =>
  AssignmentError.make({
    reason: "database",
    message: `Executor assignment database operation failed: ${String(cause)}`,
  })
const failure = (reason: AssignmentError["reason"], message: string) => AssignmentError.make({ reason, message })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))
const transaction = <A>(
  db: PgDrizzle.EffectPgDatabase,
  effect: (tx: PgDrizzle.EffectPgDatabase) => Effect.Effect<A, AssignmentError>,
) => db.transaction(effect).pipe(Effect.mapError(databaseError))
const metadataEquivalent = Schema.toEquivalence(JsonObject)
const timestamp = (value: Date | null) => value === null ? null : value.toISOString()

const assignmentFields = {
  id: rikaHostedExecutorAssignments.id,
  ownerId: rikaHostedExecutorAssignments.ownerId,
  threadId: rikaHostedExecutorAssignments.threadId,
  workspaceId: rikaHostedExecutorAssignments.workspaceId,
  executorKind: rikaHostedExecutorAssignments.executorKind,
  placement: rikaHostedExecutorAssignments.placement,
  checkout: rikaHostedExecutorAssignments.checkout,
  generation: rikaHostedExecutorAssignments.generation,
  revision: rikaHostedExecutorAssignments.revision,
  lastLeaseEpoch: rikaHostedExecutorAssignments.lastLeaseEpoch,
  lifecycle: rikaHostedExecutorAssignments.lifecycle,
  capabilityGeneration: rikaHostedExecutorAssignments.capabilityGeneration,
  capabilitySnapshot: rikaHostedExecutorAssignments.capabilitySnapshot,
  providerInstanceId: rikaHostedExecutorAssignments.providerInstanceId,
  bootstrapDigest: rikaHostedExecutorAssignments.bootstrapDigest,
  bootstrapExpiresAt: rikaHostedExecutorAssignments.bootstrapExpiresAt,
  bootstrapLive: expression<boolean>`coalesce(${rikaHostedExecutorAssignments.bootstrapExpiresAt} > clock_timestamp(), false)`,
  executorInstanceId: rikaHostedExecutorAssignments.executorInstanceId,
  processIncarnation: rikaHostedExecutorAssignments.processIncarnation,
  sessionDigest: rikaHostedExecutorAssignments.sessionDigest,
  leaseEpoch: rikaHostedExecutorAssignments.leaseEpoch,
  leaseExpiresAt: rikaHostedExecutorAssignments.leaseExpiresAt,
  leaseLive: expression<boolean>`coalesce(${rikaHostedExecutorAssignments.leaseExpiresAt} > clock_timestamp(), false)`,
  cursorSequence: rikaHostedExecutorAssignments.cursorSequence,
  cursorValue: rikaHostedExecutorAssignments.cursorValue,
  latestCheckpointId: rikaHostedExecutorAssignments.latestCheckpointId,
  lastActiveAt: rikaHostedExecutorAssignments.lastActiveAt,
  createdAt: rikaHostedExecutorAssignments.createdAt,
  updatedAt: rikaHostedExecutorAssignments.updatedAt,
}

const assignmentRow = (row: AssignmentRecord & { readonly bootstrapLive: boolean; readonly leaseLive: boolean }): AssignmentRow => ({
  ...row,
  generation: String(row.generation),
  revision: String(row.revision),
  lastLeaseEpoch: String(row.lastLeaseEpoch),
  capabilityGeneration: row.capabilityGeneration === null ? null : String(row.capabilityGeneration),
  capabilities: row.capabilitySnapshot,
  bootstrapCredentialDigest: row.bootstrapDigest,
  bootstrapExpiresAt: timestamp(row.bootstrapExpiresAt),
  leaseEpoch: row.leaseEpoch === null ? null : String(row.leaseEpoch),
  sessionCredentialDigest: row.sessionDigest,
  leaseExpiresAt: timestamp(row.leaseExpiresAt),
  cursorSequence: String(row.cursorSequence),
  lastActiveAt: row.lastActiveAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

const checkpointRow = (row: CheckpointRecord): CheckpointRow => ({
  ...row,
  assignmentGeneration: String(row.assignmentGeneration),
  leaseEpoch: String(row.leaseEpoch),
  cursorSequence: String(row.cursorSequence),
  verifiedAt: row.verifiedAt.toISOString(),
})

const lifecycle = (row: AssignmentRow) => {
  switch (row.lifecycle) {
    case "pending":
      return { _tag: "Pending" }
    case "provisioning":
      return {
        _tag: "Provisioning",
        providerInstanceId: row.providerInstanceId,
        bootstrapExpiresAt: row.bootstrapExpiresAt,
      }
    case "awaiting_bootstrap":
      return {
        _tag: "AwaitingBootstrap",
        providerInstanceId: row.providerInstanceId,
        bootstrapExpiresAt: row.bootstrapExpiresAt,
      }
    case "active":
      return {
        _tag: "Active",
        providerInstanceId: row.providerInstanceId,
        executorInstanceId: row.executorInstanceId,
        processIncarnation: row.processIncarnation,
        leaseEpoch: row.leaseEpoch,
        leaseExpiresAt: row.leaseExpiresAt,
      }
    case "paused":
      return { _tag: "Paused", providerInstanceId: row.providerInstanceId }
    case "terminated":
      return { _tag: "Terminated" }
  }
}

const decodeAssignment = (row: AssignmentRow) =>
  Schema.decodeUnknownEffect(ExecutorAssignment)({
    id: row.id,
    ownerId: row.ownerId,
    threadId: row.threadId,
    workspaceId: row.workspaceId,
    executorKind: row.executorKind,
    placement: row.placement,
    checkout: row.checkout,
    generation: row.generation,
    revision: row.revision,
    lastLeaseEpoch: row.lastLeaseEpoch,
    lifecycle: lifecycle(row),
    capabilityGeneration: row.capabilityGeneration,
    capabilities: row.capabilities,
    cursor: { sequence: row.cursorSequence, value: row.cursorValue },
    latestCheckpointId: row.latestCheckpointId,
    lastActiveAt: row.lastActiveAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }).pipe(Effect.mapError(databaseError))

const decodeCheckpoint = (row: CheckpointRow) =>
  Schema.decodeUnknownEffect(WorkspaceCheckpointManifest)({
    id: row.id,
    ownerId: row.ownerId,
    threadId: row.threadId,
    assignmentId: row.assignmentId,
    executorInstanceId: row.executorInstanceId,
    assignmentGeneration: row.assignmentGeneration,
    leaseEpoch: row.leaseEpoch,
    objectKey: row.objectKey,
    contentDigest: row.contentDigest,
    sizeBytes: row.sizeBytes,
    format: row.format,
    cursor: { sequence: row.cursorSequence, value: row.cursorValue },
    metadata: row.metadata,
    verifiedAt: row.verifiedAt,
  }).pipe(Effect.mapError(databaseError))

const checkVersion = (row: AssignmentRow, input: Version) =>
  row.generation === input.generation && row.revision === input.revision
    ? Effect.void
    : Effect.fail(failure("conflict", "Executor assignment revision is stale"))

const checkFence = (row: AssignmentRow, input: Fence) =>
  row.lifecycle === "active" && row.generation === input.assignmentGeneration && row.leaseEpoch === input.leaseEpoch
    ? Effect.void
    : Effect.fail(failure("stale-fence", "Executor assignment fence is stale"))

const checkAccess = (row: AssignmentRow, input: Access, requireLiveLease: boolean) =>
  Effect.gen(function* () {
    yield* checkFence(row, input)
    if (
      row.providerInstanceId !== input.providerInstanceId ||
      row.executorInstanceId !== input.executorInstanceId ||
      row.processIncarnation !== input.processIncarnation ||
      (requireLiveLease && !row.leaseLive)
    )
      return yield* failure("stale-fence", "Executor assignment fence is stale")
    if (
      row.sessionCredentialDigest === null ||
      row.sessionCredentialDigest !== Redacted.value(input.presentedSessionCredentialDigest)
    )
      return yield* failure("authentication", "Executor session credential is invalid")
  })

const make = Effect.gen(function* (): Effect.fn.Return<AssignmentsService, never, PgClient.PgClient> {
  yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()

  const select = (executor: PgDrizzle.EffectPgDatabase, assignmentId: string) =>
    query(executor.select(assignmentFields).from(rikaHostedExecutorAssignments)
      .where(eq(rikaHostedExecutorAssignments.id, assignmentId))).pipe(Effect.map((rows) => rows.map(assignmentRow)))

  const selectLocked = (executor: PgDrizzle.EffectPgDatabase, assignmentId: string, lock: "share" | "update") =>
    query(executor.select(assignmentFields).from(rikaHostedExecutorAssignments)
      .where(eq(rikaHostedExecutorAssignments.id, assignmentId)).for(lock)).pipe(
        Effect.map((rows) => rows.map(assignmentRow)),
      )

  const locked = Effect.fn("Assignments.lockAssignment")(function* (
    executor: PgDrizzle.EffectPgDatabase,
    assignmentId: string,
    lock: "share" | "update",
  ) {
    const row = (yield* selectLocked(executor, assignmentId, lock))[0]
    if (row === undefined) return yield* failure("not-found", "Executor assignment does not exist")
    return row
  })

  const updated = Effect.fn("Assignments.readUpdatedAssignment")(function* (
    executor: PgDrizzle.EffectPgDatabase,
    assignmentId: string,
    statement: Effect.Effect<ReadonlyArray<object>, EffectDrizzleQueryError>,
  ) {
    const rows = yield* query(statement)
    if (rows[0] === undefined) return yield* failure("conflict", "Executor assignment changed concurrently")
    return yield* decodeAssignment(yield* locked(executor, assignmentId, "update"))
  })

  const updateVersion = (tx: PgDrizzle.EffectPgDatabase, input: Version,
    values: PgUpdateSetSource<typeof rikaHostedExecutorAssignments>) =>
    tx.update(rikaHostedExecutorAssignments).set(values).where(and(
      eq(rikaHostedExecutorAssignments.id, input.assignmentId),
      eq(rikaHostedExecutorAssignments.generation, Number(input.generation)),
      eq(rikaHostedExecutorAssignments.revision, Number(input.revision)),
    )).returning({ id: rikaHostedExecutorAssignments.id })

  const updateFence = (tx: PgDrizzle.EffectPgDatabase, input: Fence,
    values: PgUpdateSetSource<typeof rikaHostedExecutorAssignments>) =>
    tx.update(rikaHostedExecutorAssignments).set(values).where(and(
      eq(rikaHostedExecutorAssignments.id, input.assignmentId),
      eq(rikaHostedExecutorAssignments.generation, Number(input.assignmentGeneration)),
      eq(rikaHostedExecutorAssignments.leaseEpoch, Number(input.leaseEpoch)),
    )).returning({ id: rikaHostedExecutorAssignments.id })

  const create: AssignmentsService["create"] = Effect.fn("Assignments.create")(function* (input) {
    return yield* transaction(
      db,
      (tx) => Effect.gen(function* () {
        const kind = input.placement._tag === "OrbPlacement" ? "orb" : "runner"
        const threads = yield* query(tx.select({
          executorKind: rikaHostedThreads.executorKind,
          workspaceId: rikaHostedThreads.workspaceId,
        }).from(rikaHostedThreads).where(and(
          eq(rikaHostedThreads.id, input.threadId),
          eq(rikaHostedThreads.ownerId, input.ownerId),
        )).for("key share"))
        if (threads[0]?.executorKind !== kind || threads[0]?.workspaceId !== input.workspaceId)
          return yield* failure(
            "invalid-authority",
            "Assignment workspace and placement must match the immutable Thread authority",
          )
        const rows = yield* query(tx.insert(rikaHostedExecutorAssignments).values({
          id: input.id,
          ownerId: input.ownerId,
          threadId: input.threadId,
          workspaceId: input.workspaceId,
          executorKind: kind,
          placement: input.placement,
          checkout: input.checkout,
          generation: 1,
          revision: 0,
          lastLeaseEpoch: 0,
          lifecycle: "pending",
        }).onConflictDoNothing().returning({ id: rikaHostedExecutorAssignments.id }))
        if (rows[0] === undefined) return yield* failure("conflict", "Thread already has an executor assignment")
        return yield* decodeAssignment(yield* locked(tx, input.id, "update"))
      }),
    )
  })

  const beginProvisioning: AssignmentsService["beginProvisioning"] = Effect.fn("Assignments.beginProvisioning")(
    function* (input) {
      return yield* transaction(
        db,
        (tx) => Effect.gen(function* () {
          const row = yield* locked(tx, input.assignmentId, "update")
          yield* checkVersion(row, input)
          if (row.lifecycle === "active" || row.lifecycle === "terminated")
            return yield* failure("invalid-state", "Assignment cannot begin provisioning")
          const providerInstanceId =
            row.lifecycle === "paused" || row.lifecycle === "provisioning" || row.lifecycle === "awaiting_bootstrap"
              ? row.providerInstanceId
              : null
          return yield* updated(
            tx,
            input.assignmentId,
            tx.update(rikaHostedExecutorAssignments).set({
              revision: expression`${rikaHostedExecutorAssignments.revision} + 1`, lifecycle: "provisioning",
              providerInstanceId, bootstrapDigest: Redacted.value(input.bootstrapCredentialDigest),
              bootstrapExpiresAt: expression`transaction_timestamp() + (${input.bootstrapLifetimeMillis} * interval '1 millisecond')`,
              executorInstanceId: null, processIncarnation: null, sessionDigest: null, leaseEpoch: null,
              leaseExpiresAt: null, updatedAt: expression`transaction_timestamp()`,
            }).where(and(eq(rikaHostedExecutorAssignments.id, input.assignmentId),
              eq(rikaHostedExecutorAssignments.generation, Number(input.generation)),
              eq(rikaHostedExecutorAssignments.revision, Number(input.revision))))
              .returning({ id: rikaHostedExecutorAssignments.id }),
          )
        }),
      )
    },
  )

  const beginReplacement: AssignmentsService["beginReplacement"] = Effect.fn("Assignments.beginReplacement")(
    function* (input) {
      return yield* transaction(
        db,
        (tx) => Effect.gen(function* () {
          const row = yield* locked(tx, input.assignmentId, "update")
          yield* checkVersion(row, input)
          if (row.lifecycle === "terminated") return yield* failure("invalid-state", "Assignment cannot be replaced")
          return yield* updated(
            tx,
            input.assignmentId,
            tx.update(rikaHostedExecutorAssignments).set({
              generation: expression`${rikaHostedExecutorAssignments.generation} + 1`,
              revision: expression`${rikaHostedExecutorAssignments.revision} + 1`, lastLeaseEpoch: 0,
              lifecycle: "provisioning", providerInstanceId: null, capabilityGeneration: null,
              capabilitySnapshot: null, bootstrapDigest: Redacted.value(input.bootstrapCredentialDigest),
              bootstrapExpiresAt: expression`transaction_timestamp() + (${input.bootstrapLifetimeMillis} * interval '1 millisecond')`,
              executorInstanceId: null, processIncarnation: null, sessionDigest: null, leaseEpoch: null,
              leaseExpiresAt: null, updatedAt: expression`transaction_timestamp()`,
            }).where(and(eq(rikaHostedExecutorAssignments.id, input.assignmentId),
              eq(rikaHostedExecutorAssignments.generation, Number(input.generation)),
              eq(rikaHostedExecutorAssignments.revision, Number(input.revision))))
              .returning({ id: rikaHostedExecutorAssignments.id }),
          )
        }),
      )
    },
  )

  const bindProviderInstance: AssignmentsService["bindProviderInstance"] = Effect.fn(
    "Assignments.bindProviderInstance",
  )(function* (input) {
    return yield* transaction(db, (tx) =>
      Effect.gen(function* () {
        const row = yield* locked(tx, input.assignmentId, "update")
        yield* checkVersion(row, input)
        if (row.lifecycle !== "provisioning") return yield* failure("invalid-state", "Assignment is not provisioning")
        if (row.providerInstanceId !== null && row.providerInstanceId !== input.providerInstanceId)
          return yield* failure("conflict", "Assignment is already bound to another provider instance")
        return yield* updated(tx, input.assignmentId, updateVersion(tx, input, {
          revision: expression`${rikaHostedExecutorAssignments.revision} + 1`, lifecycle: "awaiting_bootstrap",
          providerInstanceId: input.providerInstanceId, updatedAt: expression`transaction_timestamp()`,
        }))
      }))
  })

  const openSession: AssignmentsService["openSession"] = Effect.fn("Assignments.openSession")(
    function* (input) {
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const row = yield* locked(tx, input.assignmentId, "update")
          yield* checkVersion(row, input)
          if (row.lifecycle !== "awaiting_bootstrap" || row.providerInstanceId !== input.providerInstanceId)
            return yield* failure("stale-fence", "Executor bootstrap is invalid, expired, or consumed")
          if (row.bootstrapCredentialDigest !== Redacted.value(input.presentedBootstrapCredentialDigest))
            return yield* failure("authentication", "Executor bootstrap credential is invalid")
          if (!row.bootstrapLive) return yield* failure("stale-fence", "Executor bootstrap is expired or consumed")
          return yield* updated(tx, input.assignmentId, updateVersion(tx, input, {
            revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
            lastLeaseEpoch: expression`${rikaHostedExecutorAssignments.lastLeaseEpoch} + 1`, lifecycle: "active",
            bootstrapDigest: null, bootstrapExpiresAt: null, executorInstanceId: input.executorInstanceId,
            processIncarnation: input.processIncarnation, sessionDigest: Redacted.value(input.sessionCredentialDigest),
            leaseEpoch: expression`${rikaHostedExecutorAssignments.lastLeaseEpoch} + 1`,
            capabilityGeneration: expression`${rikaHostedExecutorAssignments.generation}`,
            capabilitySnapshot: input.capabilities,
            leaseExpiresAt: expression`transaction_timestamp() + (${input.leaseLifetimeMillis} * interval '1 millisecond')`,
            lastActiveAt: expression`transaction_timestamp()`, updatedAt: expression`transaction_timestamp()`,
          }))
        }))
    },
  )

  const updateCapabilities: AssignmentsService["updateCapabilities"] = Effect.fn(
    "Assignments.updateCapabilities",
  )(function* (input) {
    return yield* transaction(db, (tx) =>
      Effect.gen(function* () {
        const row = yield* locked(tx, input.access.assignmentId, "update")
        yield* checkAccess(row, input.access, true)
        return yield* updated(tx, input.access.assignmentId, updateFence(tx, input.access, {
          revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
          capabilityGeneration: expression`${rikaHostedExecutorAssignments.generation}`,
          capabilitySnapshot: input.capabilities, lastActiveAt: expression`transaction_timestamp()`,
          updatedAt: expression`transaction_timestamp()`,
        }))
      }))
  })

  const reconnect: AssignmentsService["reconnect"] = Effect.fn("Assignments.reconnect")(function* (input) {
    return yield* transaction(db, (tx) =>
      Effect.gen(function* () {
        const row = yield* locked(tx, input.access.assignmentId, "update")
        yield* checkAccess(row, input.access, false)
        return yield* updated(tx, input.access.assignmentId, updateFence(tx, input.access, {
          revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
          lastLeaseEpoch: expression`${rikaHostedExecutorAssignments.lastLeaseEpoch} + 1`,
          leaseEpoch: expression`${rikaHostedExecutorAssignments.lastLeaseEpoch} + 1`,
          leaseExpiresAt: expression`transaction_timestamp() + (${input.leaseLifetimeMillis} * interval '1 millisecond')`,
          lastActiveAt: expression`transaction_timestamp()`, updatedAt: expression`transaction_timestamp()`,
        }))
      }))
  })

  const heartbeat: AssignmentsService["heartbeat"] = Effect.fn("Assignments.heartbeat")(function* (input) {
    return yield* transaction(db, (tx) =>
      Effect.gen(function* () {
        const row = yield* locked(tx, input.access.assignmentId, "update")
        yield* checkAccess(row, input.access, true)
        if (BigInt(input.cursor.sequence) < BigInt(row.cursorSequence))
          return yield* failure("conflict", "Executor cursor cannot move backwards")
        if (input.cursor.sequence === row.cursorSequence && input.cursor.value !== row.cursorValue)
          return yield* failure("conflict", "Executor cursor conflicts at the same sequence")
        return yield* updated(tx, input.access.assignmentId, updateFence(tx, input.access, {
          revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
          cursorSequence: Number(input.cursor.sequence), cursorValue: input.cursor.value,
          leaseExpiresAt: expression`transaction_timestamp() + (${input.leaseLifetimeMillis} * interval '1 millisecond')`,
          lastActiveAt: expression`transaction_timestamp()`, updatedAt: expression`transaction_timestamp()`,
        }))
      }))
  })

  const authenticate: AssignmentsService["authenticate"] = Effect.fn("Assignments.authenticate")(
    function* (input) {
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const row = yield* locked(tx, input.assignmentId, "share")
          yield* checkAccess(row, input, true)
          return yield* decodeAssignment(row)
        }))
    },
  )

  const release: AssignmentsService["release"] = Effect.fn("Assignments.release")(function* (input) {
    return yield* transaction(db, (tx) =>
      Effect.gen(function* () {
        const row = yield* locked(tx, input.assignmentId, "update")
        yield* checkAccess(row, input, false)
        return yield* updated(tx, input.assignmentId,
          updateFence(tx, input, { revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
            lifecycle: "paused", bootstrapDigest: null, bootstrapExpiresAt: null, executorInstanceId: null,
            processIncarnation: null, sessionDigest: null, leaseEpoch: null, leaseExpiresAt: null,
            updatedAt: expression`clock_timestamp()` }))
      }))
  })

  const validateFence: AssignmentsService["validateFence"] = Effect.fn("Assignments.validateFence")(
    function* (input) {
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const row = yield* locked(tx, input.assignmentId, "share")
          yield* checkFence(row, input)
          if (!row.leaseLive) return yield* failure("stale-fence", "Executor assignment fence is stale")
          return yield* decodeAssignment(row)
        }))
    },
  )

  const pause: AssignmentsService["pause"] = Effect.fn("Assignments.pause")(function* (input) {
    return yield* transaction(db, (tx) => Effect.gen(function* () {
        const row = yield* locked(tx, input.assignmentId, "update")
        yield* checkVersion(row, input)
        if (row.lifecycle !== "active") return yield* failure("invalid-state", "Assignment is not active")
        return yield* updated(tx, input.assignmentId, updateVersion(tx, input, {
          revision: expression`${rikaHostedExecutorAssignments.revision} + 1`, lifecycle: "paused",
          bootstrapDigest: null, bootstrapExpiresAt: null, executorInstanceId: null, processIncarnation: null,
          sessionDigest: null, leaseEpoch: null, leaseExpiresAt: null, updatedAt: expression`transaction_timestamp()`,
        }))
      }))
  })

  const resume: AssignmentsService["resume"] = Effect.fn("Assignments.resume")(function* (input) {
    return yield* transaction(db, (tx) => Effect.gen(function* () {
        const row = yield* locked(tx, input.assignmentId, "update")
        yield* checkVersion(row, input)
        if (row.lifecycle !== "paused") return yield* failure("invalid-state", "Assignment is not paused")
        return yield* updated(tx, input.assignmentId, updateVersion(tx, input, {
          revision: expression`${rikaHostedExecutorAssignments.revision} + 1`, lifecycle: "provisioning",
          bootstrapDigest: Redacted.value(input.bootstrapCredentialDigest),
          bootstrapExpiresAt: expression`transaction_timestamp() + (${input.bootstrapLifetimeMillis} * interval '1 millisecond')`,
          updatedAt: expression`transaction_timestamp()`,
        }))
      }))
  })

  const terminate: AssignmentsService["terminate"] = Effect.fn("Assignments.terminate")(function* (input) {
    return yield* transaction(db, (tx) => Effect.gen(function* () {
        const row = yield* locked(tx, input.assignmentId, "update")
        yield* checkVersion(row, input)
        return yield* updated(tx, input.assignmentId, updateVersion(tx, input, {
          revision: expression`${rikaHostedExecutorAssignments.revision} + 1`, lifecycle: "terminated",
          bootstrapDigest: null, bootstrapExpiresAt: null, executorInstanceId: null, processIncarnation: null,
          sessionDigest: null, leaseEpoch: null, leaseExpiresAt: null, updatedAt: expression`transaction_timestamp()`,
        }))
      }))
  })

  const checkpointById = (executor: PgDrizzle.EffectPgDatabase, checkpointId: string) =>
    query(executor.select().from(rikaHostedCheckpoints).where(eq(rikaHostedCheckpoints.id, checkpointId)))
      .pipe(Effect.map((rows) => rows.map(checkpointRow)))

  const checkpointMatches = (
    checkpoint: WorkspaceCheckpointManifestValue,
    input: Parameters<AssignmentsService["commitCheckpoint"]>[0],
  ) =>
    checkpoint.assignmentId === input.access.assignmentId &&
    checkpoint.assignmentGeneration === input.access.assignmentGeneration &&
    checkpoint.leaseEpoch === input.access.leaseEpoch &&
    checkpoint.objectKey === input.objectKey &&
    checkpoint.contentDigest === input.contentDigest &&
    checkpoint.sizeBytes === input.sizeBytes &&
    checkpoint.format === input.format &&
    checkpoint.cursor.sequence === input.cursor.sequence &&
    checkpoint.cursor.value === input.cursor.value &&
    metadataEquivalent(checkpoint.metadata, input.metadata)

  const commitCheckpoint: AssignmentsService["commitCheckpoint"] = Effect.fn("Assignments.commitCheckpoint")(
    function* (input) {
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const row = yield* locked(tx, input.access.assignmentId, "update")
          yield* checkAccess(row, input.access, true)
          if (input.cursor.sequence !== row.cursorSequence || input.cursor.value !== row.cursorValue)
            return yield* failure("conflict", "Checkpoint cursor is not the acknowledged executor cursor")
          const existingRow = (yield* checkpointById(tx, input.id))[0]
          if (existingRow !== undefined) {
            const existing = yield* decodeCheckpoint(existingRow)
            return checkpointMatches(existing, input)
              ? existing
              : yield* failure("conflict", "Checkpoint identity has different content")
          }
          if (row.executorInstanceId === null || row.leaseEpoch === null)
            return yield* failure("stale-fence", "Executor assignment fence is stale")
          const inserted = yield* query(tx.insert(rikaHostedCheckpoints).values({
            id: input.id, ownerId: row.ownerId, threadId: row.threadId, assignmentId: row.id,
            executorInstanceId: row.executorInstanceId, assignmentGeneration: Number(row.generation),
            leaseEpoch: Number(row.leaseEpoch), objectKey: input.objectKey, contentDigest: input.contentDigest,
            sizeBytes: input.sizeBytes, format: input.format, cursorSequence: Number(input.cursor.sequence),
            cursorValue: input.cursor.value, metadata: input.metadata,
          }).onConflictDoNothing({ target: rikaHostedCheckpoints.id }).returning({ id: rikaHostedCheckpoints.id }))
          if (inserted[0] === undefined) return yield* failure("conflict", "Checkpoint identity has different content")
          const update = yield* query(tx.update(rikaHostedExecutorAssignments).set({
            revision: expression`${rikaHostedExecutorAssignments.revision} + 1`, latestCheckpointId: input.id,
            updatedAt: expression`transaction_timestamp()`,
          }).where(and(eq(rikaHostedExecutorAssignments.id, row.id),
            eq(rikaHostedExecutorAssignments.generation, Number(row.generation)),
            eq(rikaHostedExecutorAssignments.revision, Number(row.revision))))
            .returning({ id: rikaHostedExecutorAssignments.id }))
          if (update[0] === undefined) return yield* failure("conflict", "Executor assignment changed concurrently")
          const committed = (yield* checkpointById(tx, input.id))[0]
          if (committed === undefined) return yield* failure("database", "Committed checkpoint does not exist")
          return yield* decodeCheckpoint(committed)
        }))
    },
  )

  const get: AssignmentsService["get"] = Effect.fn("Assignments.get")(function* (assignmentId) {
    const row = (yield* select(db, assignmentId))[0]
    return row === undefined ? undefined : yield* decodeAssignment(row)
  })

  const getForThread: AssignmentsService["getForThread"] = Effect.fn("Assignments.getForThread")(
    function* (threadId) {
      const rows = yield* query(db.select({ id: rikaHostedExecutorAssignments.id })
        .from(rikaHostedExecutorAssignments).where(eq(rikaHostedExecutorAssignments.threadId, threadId)))
      return rows[0] === undefined ? undefined : yield* get(ExecutorAssignmentId.make(rows[0].id))
    },
  )
  const isBootstrapLive: AssignmentsService["isBootstrapLive"] = Effect.fn(
    "Assignments.isBootstrapLive",
  )(function* (input) {
    const rows = yield* select(db, input.assignmentId)
    const row = rows[0]
    if (row === undefined) return yield* failure("not-found", "Executor assignment does not exist")
    if (row.generation !== input.generation)
      return yield* failure("stale-fence", "Executor assignment fence is stale")
    return (row.lifecycle === "provisioning" || row.lifecycle === "awaiting_bootstrap") && row.bootstrapLive
  })

  const latestCheckpoint: AssignmentsService["latestCheckpoint"] = Effect.fn("Assignments.latestCheckpoint")(
    function* (assignmentId) {
      const rows = yield* query(db.select({ checkpoint: rikaHostedCheckpoints }).from(rikaHostedExecutorAssignments)
        .innerJoin(rikaHostedCheckpoints,
          eq(rikaHostedCheckpoints.id, rikaHostedExecutorAssignments.latestCheckpointId))
        .where(eq(rikaHostedExecutorAssignments.id, assignmentId)))
      return rows[0] === undefined ? undefined : yield* decodeCheckpoint(checkpointRow(rows[0].checkpoint))
    },
  )

  const listManaged: AssignmentsService["listManaged"] = query(db.select(assignmentFields)
    .from(rikaHostedExecutorAssignments).orderBy(asc(rikaHostedExecutorAssignments.id))).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows.map(assignmentRow), decodeAssignment)),
    )

  return ExecutorAssignments.of({
    create,
    get,
    getForThread,
    isBootstrapLive,
    beginProvisioning,
    beginReplacement,
    bindProviderInstance,
    openSession,
    updateCapabilities,
    reconnect,
    heartbeat,
    authenticate,
    release,
    validateFence,
    pause,
    resume,
    terminate,
    commitCheckpoint,
    latestCheckpoint,
    listManaged,
  })
})

export const layer = Layer.effect(ExecutorAssignments, make)
