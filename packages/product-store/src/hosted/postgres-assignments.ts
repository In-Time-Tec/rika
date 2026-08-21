import * as PgClient from "@effect/sql-pg/PgClient"
import { Effect, Layer, Redacted, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
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
import { JsonObject } from "@rika/product/hosted-model"

type AssignmentLifecycle = "active" | "awaiting_bootstrap" | "paused" | "pending" | "provisioning" | "terminated"

interface AssignmentRow {
  readonly id: string
  readonly ownerId: string
  readonly threadId: string
  readonly workspaceId: string
  readonly executorKind: "e2b" | "local_device"
  readonly placement: unknown
  readonly checkout: unknown
  readonly generation: string
  readonly revision: string
  readonly lastLeaseEpoch: string
  readonly lifecycle: AssignmentLifecycle
  readonly capabilityGeneration: string | null
  readonly capabilities: unknown | null
  readonly providerInstanceId: string | null
  readonly bootstrapCredentialDigest: string | null
  readonly bootstrapExpiresAt: string | null
  readonly bootstrapLive: boolean
  readonly executorInstanceId: string | null
  readonly processIncarnation: string | null
  readonly sessionCredentialDigest: string | null
  readonly leaseEpoch: string | null
  readonly leaseExpiresAt: string | null
  readonly leaseLive: boolean
  readonly cursorSequence: string
  readonly cursorValue: string
  readonly latestCheckpointId: string | null
  readonly lastActiveAt: string
  readonly createdAt: string
  readonly updatedAt: string
}

interface CheckpointRow {
  readonly id: string
  readonly ownerId: string
  readonly threadId: string
  readonly assignmentId: string
  readonly executorInstanceId: string
  readonly assignmentGeneration: string
  readonly leaseEpoch: string
  readonly objectKey: string
  readonly contentDigest: string
  readonly sizeBytes: number
  readonly format: "tar.zst"
  readonly cursorSequence: string
  readonly cursorValue: string
  readonly metadata: unknown
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
const transaction = <A>(sql: SqlClient, effect: Effect.Effect<A, AssignmentError>) =>
  sql.withTransaction(effect).pipe(Effect.catchTag("SqlError", databaseError))
const metadataEquivalent = Schema.toEquivalence(JsonObject)

const lifecycle = (row: AssignmentRow): unknown => {
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
  const sql = yield* PgClient.PgClient

  const select = (assignmentId: string) =>
    query(sql<AssignmentRow>`SELECT id, owner_id AS "ownerId", thread_id AS "threadId",
      workspace_id AS "workspaceId", executor_kind AS "executorKind", placement, checkout,
      generation::text AS generation,
      revision::text AS revision, last_lease_epoch::text AS "lastLeaseEpoch", lifecycle,
      capability_generation::text AS "capabilityGeneration", capability_snapshot AS capabilities,
      provider_instance_id AS "providerInstanceId", bootstrap_digest AS "bootstrapCredentialDigest",
      CASE WHEN bootstrap_expires_at IS NULL THEN NULL
        ELSE to_char(bootstrap_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "bootstrapExpiresAt",
      COALESCE(bootstrap_expires_at > clock_timestamp(), false) AS "bootstrapLive",
      executor_instance_id AS "executorInstanceId", process_incarnation AS "processIncarnation",
      session_digest AS "sessionCredentialDigest", lease_epoch::text AS "leaseEpoch",
      CASE WHEN lease_expires_at IS NULL THEN NULL
        ELSE to_char(lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "leaseExpiresAt",
      COALESCE(lease_expires_at > clock_timestamp(), false) AS "leaseLive",
      cursor_sequence::text AS "cursorSequence", cursor_value AS "cursorValue",
      latest_checkpoint_id AS "latestCheckpointId",
      to_char(last_active_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastActiveAt",
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
      FROM rika_hosted_executor_assignments WHERE id = ${assignmentId}`)

  const selectLocked = (assignmentId: string, lock: "SHARE" | "UPDATE") =>
    lock === "UPDATE"
      ? query(sql<AssignmentRow>`SELECT id, owner_id AS "ownerId", thread_id AS "threadId",
          workspace_id AS "workspaceId", executor_kind AS "executorKind", placement, checkout,
          generation::text AS generation,
          revision::text AS revision, last_lease_epoch::text AS "lastLeaseEpoch", lifecycle,
          capability_generation::text AS "capabilityGeneration", capability_snapshot AS capabilities,
          provider_instance_id AS "providerInstanceId", bootstrap_digest AS "bootstrapCredentialDigest",
          CASE WHEN bootstrap_expires_at IS NULL THEN NULL
            ELSE to_char(bootstrap_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "bootstrapExpiresAt",
          COALESCE(bootstrap_expires_at > clock_timestamp(), false) AS "bootstrapLive",
          executor_instance_id AS "executorInstanceId", process_incarnation AS "processIncarnation",
          session_digest AS "sessionCredentialDigest", lease_epoch::text AS "leaseEpoch",
          CASE WHEN lease_expires_at IS NULL THEN NULL
            ELSE to_char(lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "leaseExpiresAt",
          COALESCE(lease_expires_at > clock_timestamp(), false) AS "leaseLive",
          cursor_sequence::text AS "cursorSequence", cursor_value AS "cursorValue",
          latest_checkpoint_id AS "latestCheckpointId",
          to_char(last_active_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastActiveAt",
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
          to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
          FROM rika_hosted_executor_assignments WHERE id = ${assignmentId} FOR UPDATE`)
      : query(sql<AssignmentRow>`SELECT id, owner_id AS "ownerId", thread_id AS "threadId",
          workspace_id AS "workspaceId", executor_kind AS "executorKind", placement, checkout,
          generation::text AS generation,
          revision::text AS revision, last_lease_epoch::text AS "lastLeaseEpoch", lifecycle,
          capability_generation::text AS "capabilityGeneration", capability_snapshot AS capabilities,
          provider_instance_id AS "providerInstanceId", bootstrap_digest AS "bootstrapCredentialDigest",
          CASE WHEN bootstrap_expires_at IS NULL THEN NULL
            ELSE to_char(bootstrap_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "bootstrapExpiresAt",
          COALESCE(bootstrap_expires_at > clock_timestamp(), false) AS "bootstrapLive",
          executor_instance_id AS "executorInstanceId", process_incarnation AS "processIncarnation",
          session_digest AS "sessionCredentialDigest", lease_epoch::text AS "leaseEpoch",
          CASE WHEN lease_expires_at IS NULL THEN NULL
            ELSE to_char(lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "leaseExpiresAt",
          COALESCE(lease_expires_at > clock_timestamp(), false) AS "leaseLive",
          cursor_sequence::text AS "cursorSequence", cursor_value AS "cursorValue",
          latest_checkpoint_id AS "latestCheckpointId",
          to_char(last_active_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastActiveAt",
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
          to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
          FROM rika_hosted_executor_assignments WHERE id = ${assignmentId} FOR SHARE`)

  const locked = Effect.fn("PostgresAssignments.locked")(function* (assignmentId: string, lock: "SHARE" | "UPDATE") {
    const row = (yield* selectLocked(assignmentId, lock))[0]
    if (row === undefined) return yield* failure("not-found", "Executor assignment does not exist")
    return row
  })

  const updated = Effect.fn("PostgresAssignments.updated")(function* (
    assignmentId: string,
    statement: Effect.Effect<ReadonlyArray<object>, SqlError>,
  ) {
    const rows = yield* query(statement)
    if (rows[0] === undefined) return yield* failure("conflict", "Executor assignment changed concurrently")
    return yield* decodeAssignment(yield* locked(assignmentId, "UPDATE"))
  })

  const create: AssignmentsService["create"] = Effect.fn("PostgresAssignments.create")(function* (input) {
    if (String(input.id) !== String(input.threadId))
      return yield* failure("invalid-authority", "Executor assignment identity must equal its thread identity")
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const kind = input.placement._tag === "E2BPlacement" ? "e2b" : "local_device"
        const threads = yield* query(sql<{ readonly executorKind: string; readonly workspaceId: string }>`SELECT
          executor_kind AS "executorKind", workspace_id AS "workspaceId"
          FROM rika_hosted_threads
          WHERE id = ${input.threadId} AND owner_id = ${input.ownerId}
          FOR KEY SHARE`)
        if (threads[0]?.executorKind !== kind || threads[0]?.workspaceId !== input.workspaceId)
          return yield* failure(
            "invalid-authority",
            "Assignment workspace and placement must match the immutable Thread authority",
          )
        const rows = yield* query(sql`INSERT INTO rika_hosted_executor_assignments
          (id, owner_id, thread_id, workspace_id, executor_kind, placement, checkout, generation, revision,
            last_lease_epoch, lifecycle)
          VALUES (${input.id}, ${input.ownerId}, ${input.threadId}, ${input.workspaceId}, ${kind},
            ${sql.json(input.placement)},
            ${input.checkout === null ? null : sql.json(input.checkout)}, 1, 0, 0, 'pending')
          ON CONFLICT DO NOTHING RETURNING id`)
        if (rows[0] === undefined) return yield* failure("conflict", "Thread already has an executor assignment")
        return yield* decodeAssignment(yield* locked(input.id, "UPDATE"))
      }),
    )
  })

  const beginProvisioning: AssignmentsService["beginProvisioning"] = Effect.fn("PostgresAssignments.beginProvisioning")(
    function* (input) {
      return yield* transaction(
        sql,
        Effect.gen(function* () {
          const row = yield* locked(input.assignmentId, "UPDATE")
          yield* checkVersion(row, input)
          if (row.lifecycle === "active" || row.lifecycle === "terminated")
            return yield* failure("invalid-state", "Assignment cannot begin provisioning")
          const providerInstanceId =
            row.lifecycle === "paused" || row.lifecycle === "provisioning" || row.lifecycle === "awaiting_bootstrap"
              ? row.providerInstanceId
              : null
          return yield* updated(
            input.assignmentId,
            sql`UPDATE rika_hosted_executor_assignments SET
        revision = revision + 1, lifecycle = 'provisioning', provider_instance_id = ${providerInstanceId},
        bootstrap_digest = ${Redacted.value(input.bootstrapCredentialDigest)},
        bootstrap_expires_at = transaction_timestamp() + (${input.bootstrapLifetimeMillis} * interval '1 millisecond'),
        executor_instance_id = NULL, process_incarnation = NULL, session_digest = NULL,
        lease_epoch = NULL, lease_expires_at = NULL, updated_at = transaction_timestamp()
        WHERE id = ${input.assignmentId} AND generation = ${input.generation}::bigint
          AND revision = ${input.revision}::bigint RETURNING id`,
          )
        }),
      )
    },
  )

  const beginReplacement: AssignmentsService["beginReplacement"] = Effect.fn("PostgresAssignments.beginReplacement")(
    function* (input) {
      return yield* transaction(
        sql,
        Effect.gen(function* () {
          const row = yield* locked(input.assignmentId, "UPDATE")
          yield* checkVersion(row, input)
          if (row.lifecycle === "terminated") return yield* failure("invalid-state", "Assignment cannot be replaced")
          return yield* updated(
            input.assignmentId,
            sql`UPDATE rika_hosted_executor_assignments SET
        generation = generation + 1, revision = revision + 1, last_lease_epoch = 0,
        lifecycle = 'provisioning', provider_instance_id = NULL,
        capability_generation = NULL, capability_snapshot = NULL,
        bootstrap_digest = ${Redacted.value(input.bootstrapCredentialDigest)},
        bootstrap_expires_at = transaction_timestamp() + (${input.bootstrapLifetimeMillis} * interval '1 millisecond'),
        executor_instance_id = NULL, process_incarnation = NULL, session_digest = NULL,
        lease_epoch = NULL, lease_expires_at = NULL, updated_at = transaction_timestamp()
        WHERE id = ${input.assignmentId} AND generation = ${input.generation}::bigint
          AND revision = ${input.revision}::bigint RETURNING id`,
          )
        }),
      )
    },
  )

  const bindProviderInstance: AssignmentsService["bindProviderInstance"] = Effect.fn(
    "PostgresAssignments.bindProviderInstance",
  )(function* (input) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const row = yield* locked(input.assignmentId, "UPDATE")
        yield* checkVersion(row, input)
        if (row.lifecycle !== "provisioning") return yield* failure("invalid-state", "Assignment is not provisioning")
        if (row.providerInstanceId !== null && row.providerInstanceId !== input.providerInstanceId)
          return yield* failure("conflict", "Assignment is already bound to another provider instance")
        return yield* updated(
          input.assignmentId,
          sql`UPDATE rika_hosted_executor_assignments SET
        revision = revision + 1, lifecycle = 'awaiting_bootstrap',
        provider_instance_id = ${input.providerInstanceId}, updated_at = transaction_timestamp()
        WHERE id = ${input.assignmentId} AND generation = ${input.generation}::bigint
          AND revision = ${input.revision}::bigint RETURNING id`,
        )
      }),
    )
  })

  const openSession: AssignmentsService["openSession"] = Effect.fn("PostgresAssignments.openSession")(
    function* (input) {
      return yield* transaction(
        sql,
        Effect.gen(function* () {
          const row = yield* locked(input.assignmentId, "UPDATE")
          yield* checkVersion(row, input)
          if (row.lifecycle !== "awaiting_bootstrap" || row.providerInstanceId !== input.providerInstanceId)
            return yield* failure("stale-fence", "Executor bootstrap is invalid, expired, or consumed")
          if (row.bootstrapCredentialDigest !== Redacted.value(input.presentedBootstrapCredentialDigest))
            return yield* failure("authentication", "Executor bootstrap credential is invalid")
          if (!row.bootstrapLive) return yield* failure("stale-fence", "Executor bootstrap is expired or consumed")
          return yield* updated(
            input.assignmentId,
            sql`UPDATE rika_hosted_executor_assignments SET
        revision = revision + 1, last_lease_epoch = last_lease_epoch + 1, lifecycle = 'active',
        bootstrap_digest = NULL, bootstrap_expires_at = NULL,
        executor_instance_id = ${input.executorInstanceId}, process_incarnation = ${input.processIncarnation},
        session_digest = ${Redacted.value(input.sessionCredentialDigest)}, lease_epoch = last_lease_epoch + 1,
        capability_generation = generation, capability_snapshot = ${sql.json(input.capabilities)},
        lease_expires_at = transaction_timestamp() + (${input.leaseLifetimeMillis} * interval '1 millisecond'),
        last_active_at = transaction_timestamp(), updated_at = transaction_timestamp()
        WHERE id = ${input.assignmentId} AND generation = ${input.generation}::bigint
          AND revision = ${input.revision}::bigint RETURNING id`,
          )
        }),
      )
    },
  )

  const reconnect: AssignmentsService["reconnect"] = Effect.fn("PostgresAssignments.reconnect")(function* (input) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const row = yield* locked(input.access.assignmentId, "UPDATE")
        yield* checkAccess(row, input.access, false)
        return yield* updated(
          input.access.assignmentId,
          sql`UPDATE rika_hosted_executor_assignments SET
        revision = revision + 1, last_lease_epoch = last_lease_epoch + 1,
        lease_epoch = last_lease_epoch + 1,
        lease_expires_at = transaction_timestamp() + (${input.leaseLifetimeMillis} * interval '1 millisecond'),
        last_active_at = transaction_timestamp(), updated_at = transaction_timestamp()
        WHERE id = ${input.access.assignmentId} AND generation = ${input.access.assignmentGeneration}::bigint
          AND lease_epoch = ${input.access.leaseEpoch}::bigint RETURNING id`,
        )
      }),
    )
  })

  const heartbeat: AssignmentsService["heartbeat"] = Effect.fn("PostgresAssignments.heartbeat")(function* (input) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const row = yield* locked(input.access.assignmentId, "UPDATE")
        yield* checkAccess(row, input.access, true)
        if (BigInt(input.cursor.sequence) < BigInt(row.cursorSequence))
          return yield* failure("conflict", "Executor cursor cannot move backwards")
        if (input.cursor.sequence === row.cursorSequence && input.cursor.value !== row.cursorValue)
          return yield* failure("conflict", "Executor cursor conflicts at the same sequence")
        return yield* updated(
          input.access.assignmentId,
          sql`UPDATE rika_hosted_executor_assignments SET
        revision = revision + 1, cursor_sequence = ${input.cursor.sequence}::bigint,
        cursor_value = ${input.cursor.value},
        lease_expires_at = transaction_timestamp() + (${input.leaseLifetimeMillis} * interval '1 millisecond'),
        last_active_at = transaction_timestamp(), updated_at = transaction_timestamp()
        WHERE id = ${input.access.assignmentId} AND generation = ${input.access.assignmentGeneration}::bigint
          AND lease_epoch = ${input.access.leaseEpoch}::bigint RETURNING id`,
        )
      }),
    )
  })

  const authenticate: AssignmentsService["authenticate"] = Effect.fn("PostgresAssignments.authenticate")(
    function* (input) {
      return yield* transaction(
        sql,
        Effect.gen(function* () {
          const row = yield* locked(input.assignmentId, "SHARE")
          yield* checkAccess(row, input, true)
          return yield* decodeAssignment(row)
        }),
      )
    },
  )

  const release: AssignmentsService["release"] = Effect.fn("PostgresAssignments.release")(function* (input) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const row = yield* locked(input.assignmentId, "UPDATE")
        yield* checkAccess(row, input, false)
        return yield* updated(
          input.assignmentId,
          sql`UPDATE rika_hosted_executor_assignments SET
        revision = revision + 1, lifecycle = 'paused', bootstrap_digest = NULL, bootstrap_expires_at = NULL,
        executor_instance_id = NULL, process_incarnation = NULL, session_digest = NULL,
        lease_epoch = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
        WHERE id = ${row.id} AND generation = ${row.generation}::bigint
          AND lease_epoch = ${row.leaseEpoch}::bigint AND lifecycle = 'active' RETURNING id`,
        )
      }),
    )
  })

  const validateFence: AssignmentsService["validateFence"] = Effect.fn("PostgresAssignments.validateFence")(
    function* (input) {
      return yield* transaction(
        sql,
        Effect.gen(function* () {
          const row = yield* locked(input.assignmentId, "SHARE")
          yield* checkFence(row, input)
          if (!row.leaseLive) return yield* failure("stale-fence", "Executor assignment fence is stale")
          return yield* decodeAssignment(row)
        }),
      )
    },
  )

  const pause: AssignmentsService["pause"] = Effect.fn("PostgresAssignments.pause")(function* (input) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const row = yield* locked(input.assignmentId, "UPDATE")
        yield* checkVersion(row, input)
        if (row.lifecycle !== "active") return yield* failure("invalid-state", "Assignment is not active")
        return yield* updated(
          input.assignmentId,
          sql`UPDATE rika_hosted_executor_assignments SET
        revision = revision + 1, lifecycle = 'paused', bootstrap_digest = NULL, bootstrap_expires_at = NULL,
        executor_instance_id = NULL, process_incarnation = NULL, session_digest = NULL,
        lease_epoch = NULL, lease_expires_at = NULL, updated_at = transaction_timestamp()
        WHERE id = ${input.assignmentId} AND generation = ${input.generation}::bigint
          AND revision = ${input.revision}::bigint RETURNING id`,
        )
      }),
    )
  })

  const resume: AssignmentsService["resume"] = Effect.fn("PostgresAssignments.resume")(function* (input) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const row = yield* locked(input.assignmentId, "UPDATE")
        yield* checkVersion(row, input)
        if (row.lifecycle !== "paused") return yield* failure("invalid-state", "Assignment is not paused")
        return yield* updated(
          input.assignmentId,
          sql`UPDATE rika_hosted_executor_assignments SET
        revision = revision + 1, lifecycle = 'provisioning',
        bootstrap_digest = ${Redacted.value(input.bootstrapCredentialDigest)},
        bootstrap_expires_at = transaction_timestamp() + (${input.bootstrapLifetimeMillis} * interval '1 millisecond'),
        updated_at = transaction_timestamp()
        WHERE id = ${input.assignmentId} AND generation = ${input.generation}::bigint
          AND revision = ${input.revision}::bigint RETURNING id`,
        )
      }),
    )
  })

  const terminate: AssignmentsService["terminate"] = Effect.fn("PostgresAssignments.terminate")(function* (input) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const row = yield* locked(input.assignmentId, "UPDATE")
        yield* checkVersion(row, input)
        return yield* updated(
          input.assignmentId,
          sql`UPDATE rika_hosted_executor_assignments SET
        revision = revision + 1, lifecycle = 'terminated', bootstrap_digest = NULL, bootstrap_expires_at = NULL,
        executor_instance_id = NULL, process_incarnation = NULL, session_digest = NULL,
        lease_epoch = NULL, lease_expires_at = NULL, updated_at = transaction_timestamp()
        WHERE id = ${input.assignmentId} AND generation = ${input.generation}::bigint
          AND revision = ${input.revision}::bigint RETURNING id`,
        )
      }),
    )
  })

  const checkpointById = (checkpointId: string) =>
    query(sql<CheckpointRow>`SELECT id, owner_id AS "ownerId", thread_id AS "threadId",
      assignment_id AS "assignmentId", executor_instance_id AS "executorInstanceId",
      assignment_generation::text AS "assignmentGeneration", lease_epoch::text AS "leaseEpoch",
      object_key AS "objectKey", content_digest AS "contentDigest", size_bytes::float8 AS "sizeBytes", format,
      cursor_sequence::text AS "cursorSequence", cursor_value AS "cursorValue", metadata,
      to_char(verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "verifiedAt"
      FROM rika_hosted_checkpoints WHERE id = ${checkpointId}`)

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

  const commitCheckpoint: AssignmentsService["commitCheckpoint"] = Effect.fn("PostgresAssignments.commitCheckpoint")(
    function* (input) {
      return yield* transaction(
        sql,
        Effect.gen(function* () {
          const row = yield* locked(input.access.assignmentId, "UPDATE")
          yield* checkAccess(row, input.access, true)
          if (input.cursor.sequence !== row.cursorSequence || input.cursor.value !== row.cursorValue)
            return yield* failure("conflict", "Checkpoint cursor is not the acknowledged executor cursor")
          const existingRow = (yield* checkpointById(input.id))[0]
          if (existingRow !== undefined) {
            const existing = yield* decodeCheckpoint(existingRow)
            return checkpointMatches(existing, input)
              ? existing
              : yield* failure("conflict", "Checkpoint identity has different content")
          }
          const inserted = yield* query(sql`INSERT INTO rika_hosted_checkpoints
        (id, owner_id, thread_id, assignment_id, executor_instance_id, assignment_generation,
          lease_epoch, object_key, content_digest, size_bytes, format, cursor_sequence, cursor_value, metadata)
        VALUES (${input.id}, ${row.ownerId}, ${row.threadId}, ${row.id}, ${row.executorInstanceId},
          ${row.generation}::bigint, ${row.leaseEpoch}::bigint, ${input.objectKey}, ${input.contentDigest},
          ${input.sizeBytes}, ${input.format}, ${input.cursor.sequence}::bigint, ${input.cursor.value},
          ${sql.json(input.metadata)}) ON CONFLICT (id) DO NOTHING RETURNING id`)
          if (inserted[0] === undefined) return yield* failure("conflict", "Checkpoint identity has different content")
          const update = yield* query(sql`UPDATE rika_hosted_executor_assignments SET
        revision = revision + 1, latest_checkpoint_id = ${input.id}, updated_at = transaction_timestamp()
        WHERE id = ${row.id} AND generation = ${row.generation}::bigint
          AND revision = ${row.revision}::bigint RETURNING id`)
          if (update[0] === undefined) return yield* failure("conflict", "Executor assignment changed concurrently")
          return yield* decodeCheckpoint((yield* checkpointById(input.id))[0]!)
        }),
      )
    },
  )

  const get: AssignmentsService["get"] = Effect.fn("PostgresAssignments.get")(function* (assignmentId) {
    const row = (yield* select(assignmentId))[0]
    return row === undefined ? undefined : yield* decodeAssignment(row)
  })

  const listManaged: AssignmentsService["listManaged"] = query(
    sql<AssignmentRow>`SELECT id, owner_id AS "ownerId", thread_id AS "threadId",
        workspace_id AS "workspaceId", executor_kind AS "executorKind", placement, checkout,
        generation::text AS generation,
        revision::text AS revision, last_lease_epoch::text AS "lastLeaseEpoch", lifecycle,
        capability_generation::text AS "capabilityGeneration", capability_snapshot AS capabilities,
        provider_instance_id AS "providerInstanceId", bootstrap_digest AS "bootstrapCredentialDigest",
        CASE WHEN bootstrap_expires_at IS NULL THEN NULL
          ELSE to_char(bootstrap_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "bootstrapExpiresAt",
        COALESCE(bootstrap_expires_at > clock_timestamp(), false) AS "bootstrapLive",
        executor_instance_id AS "executorInstanceId", process_incarnation AS "processIncarnation",
        session_digest AS "sessionCredentialDigest", lease_epoch::text AS "leaseEpoch",
        CASE WHEN lease_expires_at IS NULL THEN NULL
          ELSE to_char(lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "leaseExpiresAt",
        COALESCE(lease_expires_at > clock_timestamp(), false) AS "leaseLive",
        cursor_sequence::text AS "cursorSequence", cursor_value AS "cursorValue",
        latest_checkpoint_id AS "latestCheckpointId",
        to_char(last_active_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastActiveAt",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
        FROM rika_hosted_executor_assignments ORDER BY id`,
  ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeAssignment)))

  return ExecutorAssignments.of({
    create,
    get,
    beginProvisioning,
    beginReplacement,
    bindProviderInstance,
    openSession,
    reconnect,
    heartbeat,
    authenticate,
    release,
    validateFence,
    pause,
    resume,
    terminate,
    commitCheckpoint,
    listManaged,
  })
})

export const layer = Layer.effect(ExecutorAssignments, make)
