import * as PgClient from "@effect/sql-pg/PgClient"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { and, asc, eq, not, or, sql as expression } from "drizzle-orm"
import type { PgUpdateSetSource } from "drizzle-orm/pg-core"
import { Effect, Layer, Redacted } from "effect"
import {
  AssignmentError,
  ExecutorAssignments,
  type AssignmentsService,
  type Fence,
  type Version,
} from "@rika/product/executor-assignments"
import { ExecutorAssignmentId } from "@rika/product/hosted-model"
import { rikaHostedExecutorAssignments, rikaHostedThreads } from "../../database/schema/product"
import { assignmentRow, assignmentFields, databaseError, decodeAssignment } from "./assignment-row"
import { fencingOperations } from "./assignment-fencing"
import { lifecycleOperations } from "./assignment-lifecycle"
import { checkpointOperations } from "./assignment-checkpoints"
import { assignmentChecks, type AssignmentOperations } from "./assignment-operations"

const failure = (reason: AssignmentError["reason"], message: string) => AssignmentError.make({ reason, message })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))
const transaction = <A>(
  db: PgDrizzle.EffectPgDatabase,
  effect: (tx: PgDrizzle.EffectPgDatabase) => Effect.Effect<A, AssignmentError>,
) => db.transaction(effect).pipe(Effect.mapError(databaseError))

const make = Effect.gen(function* (): Effect.fn.Return<AssignmentsService, never, PgClient.PgClient> {
  yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()
  const checkVersion = (
    row: Parameters<typeof assignmentChecks.checkVersion>[1],
    input: Parameters<typeof assignmentChecks.checkVersion>[2],
  ) => assignmentChecks.checkVersion(failure, row, input)
  const checkFence = (
    row: Parameters<typeof assignmentChecks.checkFence>[1],
    input: Parameters<typeof assignmentChecks.checkFence>[2],
  ) => assignmentChecks.checkFence(failure, row, input)
  const checkAccess = (
    row: Parameters<typeof assignmentChecks.checkAccess>[1],
    input: Parameters<typeof assignmentChecks.checkAccess>[2],
    requireLiveLease: boolean,
  ) => assignmentChecks.checkAccess(failure, row, input, requireLiveLease)

  const select = (executor: PgDrizzle.EffectPgDatabase, assignmentId: string) =>
    query(
      executor
        .select(assignmentFields)
        .from(rikaHostedExecutorAssignments)
        .where(eq(rikaHostedExecutorAssignments.id, assignmentId)),
    ).pipe(Effect.map((rows) => rows.map(assignmentRow)))

  const selectLocked = (executor: PgDrizzle.EffectPgDatabase, assignmentId: string, lock: "share" | "update") =>
    query(
      executor
        .select(assignmentFields)
        .from(rikaHostedExecutorAssignments)
        .where(eq(rikaHostedExecutorAssignments.id, assignmentId))
        .for(lock),
    ).pipe(Effect.map((rows) => rows.map(assignmentRow)))

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

  const updateVersion = (
    tx: PgDrizzle.EffectPgDatabase,
    input: Version,
    values: PgUpdateSetSource<typeof rikaHostedExecutorAssignments>,
  ) =>
    tx
      .update(rikaHostedExecutorAssignments)
      .set(values)
      .where(
        and(
          eq(rikaHostedExecutorAssignments.id, input.assignmentId),
          eq(rikaHostedExecutorAssignments.generation, Number(input.generation)),
          eq(rikaHostedExecutorAssignments.revision, Number(input.revision)),
        ),
      )
      .returning({ id: rikaHostedExecutorAssignments.id })

  const updateFence = (
    tx: PgDrizzle.EffectPgDatabase,
    input: Fence,
    values: PgUpdateSetSource<typeof rikaHostedExecutorAssignments>,
  ) =>
    tx
      .update(rikaHostedExecutorAssignments)
      .set(values)
      .where(
        and(
          eq(rikaHostedExecutorAssignments.id, input.assignmentId),
          eq(rikaHostedExecutorAssignments.generation, Number(input.assignmentGeneration)),
          eq(rikaHostedExecutorAssignments.leaseEpoch, Number(input.leaseEpoch)),
        ),
      )
      .returning({ id: rikaHostedExecutorAssignments.id })

  const orphanAssignmentCondition = (assignmentId: string | undefined) =>
    assignmentId === undefined ? undefined : eq(rikaHostedExecutorAssignments.id, assignmentId)

  const lockOrphanAuthority = Effect.fn("Assignments.lockOrphanAuthority")(function* (
    executor: PgDrizzle.EffectPgDatabase,
    input: { readonly providerInstanceId: string; readonly assignmentId?: string; readonly generation?: string },
  ) {
    const rows = yield* query(
      executor
        .select({
          id: rikaHostedExecutorAssignments.id,
          generation: rikaHostedExecutorAssignments.generation,
          revision: rikaHostedExecutorAssignments.revision,
          lifecycle: rikaHostedExecutorAssignments.lifecycle,
          providerInstanceId: rikaHostedExecutorAssignments.providerInstanceId,
          bootstrapLive: expression<boolean>`coalesce(${rikaHostedExecutorAssignments.bootstrapExpiresAt} > clock_timestamp(), false)`,
        })
        .from(rikaHostedExecutorAssignments)
        .where(
          or(
            eq(rikaHostedExecutorAssignments.providerInstanceId, input.providerInstanceId),
            orphanAssignmentCondition(input.assignmentId),
          ),
        )
        .orderBy(asc(rikaHostedExecutorAssignments.id))
        .for("update"),
    )
    const bound = rows.find((row) => row.providerInstanceId === input.providerInstanceId)
    const identified = rows.find((row) => row.id === input.assignmentId)
    const matched = String(identified?.generation) === input.generation ? identified : undefined
    const row = bound ?? matched
    if (row === undefined)
      return identified === undefined ? ({ status: "preserved" } as const) : ({ status: "candidate" } as const)
    if (row.lifecycle === "active" || row.lifecycle === "paused")
      return bound === undefined ? ({ status: "candidate" } as const) : ({ status: "preserved" } as const)
    if (row.lifecycle === "terminated") return { status: "candidate" } as const
    const bootstrapping = row.lifecycle === "provisioning" || row.lifecycle === "awaiting_bootstrap"
    if (bootstrapping && row.bootstrapLive)
      return row.providerInstanceId === null || bound !== undefined
        ? ({ status: "preserved" } as const)
        : ({ status: "candidate" } as const)
    return { status: "candidate", retire: row } as const
  })

  const inspectOrphan: AssignmentsService["inspectOrphan"] = Effect.fn("PostgresAssignments.inspectOrphan")(
    function* (input) {
      return yield* transaction(db, (tx) =>
        lockOrphanAuthority(tx, input).pipe(Effect.map((authority) => authority.status)),
      )
    },
  )

  const claimOrphan: AssignmentsService["claimOrphan"] = Effect.fn("PostgresAssignments.claimOrphan")(
    function* (input) {
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const authority = yield* lockOrphanAuthority(tx, input)
          if (authority.status === "preserved") return "preserved"
          if (!("retire" in authority)) return "claimed"
          const row = authority.retire
          const retired = yield* query(
            tx
              .update(rikaHostedExecutorAssignments)
              .set({
                generation: expression`${rikaHostedExecutorAssignments.generation} + 1`,
                revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
                lastLeaseEpoch: 0,
                lifecycle: "pending",
                providerInstanceId: null,
                bootstrapDigest: null,
                bootstrapExpiresAt: null,
                executorInstanceId: null,
                processIncarnation: null,
                sessionDigest: null,
                leaseEpoch: null,
                leaseExpiresAt: null,
                capabilityGeneration: null,
                capabilitySnapshot: null,
                updatedAt: expression`transaction_timestamp()`,
              })
              .where(
                and(
                  eq(rikaHostedExecutorAssignments.id, row.id),
                  eq(rikaHostedExecutorAssignments.generation, row.generation),
                  eq(rikaHostedExecutorAssignments.revision, row.revision),
                ),
              )
              .returning({ id: rikaHostedExecutorAssignments.id }),
          )
          if (retired[0] === undefined) return yield* failure("conflict", "Executor assignment changed concurrently")
          return "claimed"
        }),
      )
    },
  )

  const create: AssignmentsService["create"] = Effect.fn("Assignments.create")(function* (input) {
    return yield* transaction(db, (tx) =>
      Effect.gen(function* () {
        const kind = input.placement._tag === "OrbPlacement" ? "orb" : "runner"
        const threads = yield* query(
          tx
            .select({
              executorKind: rikaHostedThreads.executorKind,
              workspaceId: rikaHostedThreads.workspaceId,
            })
            .from(rikaHostedThreads)
            .where(and(eq(rikaHostedThreads.id, input.threadId), eq(rikaHostedThreads.ownerId, input.ownerId)))
            .for("key share"),
        )
        if (threads[0]?.executorKind !== kind || threads[0]?.workspaceId !== input.workspaceId)
          return yield* failure(
            "invalid-authority",
            "Assignment workspace and placement must match the immutable Thread authority",
          )
        const rows = yield* query(
          tx
            .insert(rikaHostedExecutorAssignments)
            .values({
              id: input.id,
              ownerId: input.ownerId,
              threadId: input.threadId,
              workspaceId: input.workspaceId,
              executorKind: kind,
              placement: input.placement,
              checkout: input.checkout,
              workspaceSeed: input.workspaceSeed ?? null,
              generation: 1,
              revision: 0,
              lastLeaseEpoch: 0,
              lifecycle: "pending",
            })
            .onConflictDoNothing()
            .returning({ id: rikaHostedExecutorAssignments.id }),
        )
        if (rows[0] === undefined) return yield* failure("conflict", "Thread already has an executor assignment")
        return yield* decodeAssignment(yield* locked(tx, input.id, "update"))
      }),
    )
  })

  const beginProvisioning: AssignmentsService["beginProvisioning"] = Effect.fn("Assignments.beginProvisioning")(
    function* (input) {
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
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
            tx
              .update(rikaHostedExecutorAssignments)
              .set({
                revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
                lifecycle: "provisioning",
                providerInstanceId,
                bootstrapDigest: Redacted.value(input.bootstrapCredentialDigest),
                bootstrapExpiresAt: expression`transaction_timestamp() + (${input.bootstrapLifetimeMillis} * interval '1 millisecond')`,
                executorInstanceId: null,
                processIncarnation: null,
                sessionDigest: null,
                leaseEpoch: null,
                leaseExpiresAt: null,
                updatedAt: expression`transaction_timestamp()`,
              })
              .where(
                and(
                  eq(rikaHostedExecutorAssignments.id, input.assignmentId),
                  eq(rikaHostedExecutorAssignments.generation, Number(input.generation)),
                  eq(rikaHostedExecutorAssignments.revision, Number(input.revision)),
                ),
              )
              .returning({ id: rikaHostedExecutorAssignments.id }),
          )
        }),
      )
    },
  )

  const beginReplacement: AssignmentsService["beginReplacement"] = Effect.fn("Assignments.beginReplacement")(
    function* (input) {
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const row = yield* locked(tx, input.assignmentId, "update")
          yield* checkVersion(row, input)
          if (row.lifecycle === "terminated") return yield* failure("invalid-state", "Assignment cannot be replaced")
          const assignment = yield* decodeAssignment(row)
          if (assignment.placement._tag !== input.placement._tag)
            return yield* failure("invalid-authority", "Replacement placement must preserve the Executor kind")
          if (
            assignment.placement._tag === "OrbPlacement" &&
            input.placement._tag === "OrbPlacement" &&
            assignment.placement.providerScope !== input.placement.providerScope
          )
            return yield* failure("invalid-authority", "Replacement placement must preserve the Orb provider scope")
          if (
            assignment.placement._tag === "RunnerPlacement" &&
            input.placement._tag === "RunnerPlacement" &&
            (assignment.placement.deviceId !== input.placement.deviceId ||
              assignment.placement.checkoutFingerprint !== input.placement.checkoutFingerprint ||
              assignment.placement.requestingDeviceId !== input.placement.requestingDeviceId)
          )
            return yield* failure("invalid-authority", "Replacement placement must preserve the Runner authority")
          return yield* updated(
            tx,
            input.assignmentId,
            tx
              .update(rikaHostedExecutorAssignments)
              .set({
                placement: input.placement,
                generation: expression`${rikaHostedExecutorAssignments.generation} + 1`,
                revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
                lastLeaseEpoch: 0,
                lifecycle: "provisioning",
                providerInstanceId: null,
                capabilityGeneration: null,
                capabilitySnapshot: null,
                bootstrapDigest: Redacted.value(input.bootstrapCredentialDigest),
                bootstrapExpiresAt: expression`transaction_timestamp() + (${input.bootstrapLifetimeMillis} * interval '1 millisecond')`,
                executorInstanceId: null,
                processIncarnation: null,
                sessionDigest: null,
                leaseEpoch: null,
                leaseExpiresAt: null,
                updatedAt: expression`transaction_timestamp()`,
              })
              .where(
                and(
                  eq(rikaHostedExecutorAssignments.id, input.assignmentId),
                  eq(rikaHostedExecutorAssignments.generation, Number(input.generation)),
                  eq(rikaHostedExecutorAssignments.revision, Number(input.revision)),
                ),
              )
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
        return yield* updated(
          tx,
          input.assignmentId,
          updateVersion(tx, input, {
            revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
            lifecycle: "awaiting_bootstrap",
            providerInstanceId: input.providerInstanceId,
            updatedAt: expression`transaction_timestamp()`,
          }),
        )
      }),
    )
  })

  const openSession: AssignmentsService["openSession"] = Effect.fn("Assignments.openSession")(function* (input) {
    return yield* transaction(db, (tx) =>
      Effect.gen(function* () {
        const row = yield* locked(tx, input.assignmentId, "update")
        yield* checkVersion(row, input)
        if (row.lifecycle !== "awaiting_bootstrap" || row.providerInstanceId !== input.providerInstanceId)
          return yield* failure("stale-fence", "Executor bootstrap is invalid, expired, or consumed")
        if (row.bootstrapCredentialDigest !== Redacted.value(input.presentedBootstrapCredentialDigest))
          return yield* failure("authentication", "Executor bootstrap credential is invalid")
        if (!row.bootstrapLive) return yield* failure("stale-fence", "Executor bootstrap is expired or consumed")
        return yield* updated(
          tx,
          input.assignmentId,
          updateVersion(tx, input, {
            revision: expression`${rikaHostedExecutorAssignments.revision} + 1`,
            lastLeaseEpoch: expression`${rikaHostedExecutorAssignments.lastLeaseEpoch} + 1`,
            lifecycle: "active",
            bootstrapDigest: null,
            bootstrapExpiresAt: null,
            executorInstanceId: input.executorInstanceId,
            processIncarnation: input.processIncarnation,
            sessionDigest: Redacted.value(input.sessionCredentialDigest),
            leaseEpoch: expression`${rikaHostedExecutorAssignments.lastLeaseEpoch} + 1`,
            capabilityGeneration: expression`${rikaHostedExecutorAssignments.generation}`,
            capabilitySnapshot: input.capabilities,
            leaseExpiresAt: expression`transaction_timestamp() + (${input.leaseLifetimeMillis} * interval '1 millisecond')`,
            lastActiveAt: expression`transaction_timestamp()`,
            updatedAt: expression`transaction_timestamp()`,
          }),
        )
      }),
    )
  })

  const get: AssignmentsService["get"] = Effect.fn("Assignments.get")(function* (assignmentId) {
    const row = (yield* select(db, assignmentId))[0]
    return row === undefined ? undefined : yield* decodeAssignment(row)
  })

  const getForThread: AssignmentsService["getForThread"] = Effect.fn("Assignments.getForThread")(function* (threadId) {
    const rows = yield* query(
      db
        .select({ id: rikaHostedExecutorAssignments.id })
        .from(rikaHostedExecutorAssignments)
        .where(eq(rikaHostedExecutorAssignments.threadId, threadId)),
    )
    return rows[0] === undefined ? undefined : yield* get(ExecutorAssignmentId.make(rows[0].id))
  })
  const isBootstrapLive: AssignmentsService["isBootstrapLive"] = Effect.fn("Assignments.isBootstrapLive")(
    function* (input) {
      const rows = yield* select(db, input.assignmentId)
      const row = rows[0]
      if (row === undefined) return yield* failure("not-found", "Executor assignment does not exist")
      if (row.generation !== input.generation)
        return yield* failure("stale-fence", "Executor assignment fence is stale")
      return (row.lifecycle === "provisioning" || row.lifecycle === "awaiting_bootstrap") && row.bootstrapLive
    },
  )

  const operations: AssignmentOperations = {
    db,
    transaction: (effect) => transaction(db, effect),
    locked,
    updated,
    updateVersion,
    updateFence,
    query,
    failure,
    checkVersion,
    checkFence,
    checkAccess,
  }
  const { updateCapabilities, reconnect, heartbeat, authenticate, release, validateFence } =
    fencingOperations(operations)
  const { pause, resume, terminate } = lifecycleOperations(operations)
  const { commitCheckpoint, latestCheckpoint } = checkpointOperations(operations)

  const listManaged: AssignmentsService["listManaged"] = query(
    db
      .select(assignmentFields)
      .from(rikaHostedExecutorAssignments)
      .where(not(eq(rikaHostedExecutorAssignments.lifecycle, "terminated")))
      .orderBy(asc(rikaHostedExecutorAssignments.id))
      .limit(1_000),
  ).pipe(Effect.flatMap((rows) => Effect.forEach(rows.map(assignmentRow), decodeAssignment)))

  return ExecutorAssignments.of({
    create,
    get,
    getForThread,
    isBootstrapLive,
    inspectOrphan,
    claimOrphan,
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
