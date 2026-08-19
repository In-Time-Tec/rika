import * as PgClient from "@effect/sql-pg/PgClient"
import { Effect, Layer, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import {
  ActorAttribution,
  AuditEvent,
  AuthenticatedClient,
  AuthenticatedDevice,
  Checkpoint,
  CommitCursor,
  CredentialReference,
  ExecutorAssignmentLease,
  ExecutorInstance,
  HostedThread,
  HostedWorkspace,
  JsonObject,
  LocalWorkspaceBinding,
  Presence,
  Project,
  ProjectGrant,
  ResumableCursor,
  Sequence,
  TerminalWriterLease,
  ThreadCommand,
  ThreadEvent,
  ThreadGrant,
} from "@rika/product/hosted-authority-model"
import {
  HostedRepository,
  HostedRepositoryError,
  type AcquireAssignmentInput,
  type AcquireTerminalWriterInput,
  type AdmitCommandInput,
  type AppendEventInput,
  type AuthenticateClientInput,
  type BindLocalWorkspaceInput,
  type CreateProjectInput,
  type CreateThreadInput,
  type CreateWorkspaceInput,
  type HostedRepositoryInterface,
  type PutCredentialReferenceInput,
  type PutProjectGrantInput,
  type PutThreadGrantInput,
  type RecordAuditEventInput,
  type RegisterDeviceInput,
  type RegisterExecutorInput,
  type RenewAssignmentInput,
  type RenewTerminalWriterInput,
  type SaveCheckpointInput,
  type UpsertPresenceInput,
} from "@rika/product/hosted-authority-repository"

const databaseError = (cause: unknown) =>
  HostedRepositoryError.make({ reason: "database", message: `Hosted PostgreSQL operation failed: ${String(cause)}` })
const failure = (reason: HostedRepositoryError["reason"], message: string) =>
  HostedRepositoryError.make({ reason, message })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))
const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(databaseError))
const limit = (value: number) => Math.min(Math.max(Math.trunc(value), 1), 1_000)
const transaction = <A>(sql: SqlClient, effect: Effect.Effect<A, HostedRepositoryError>) =>
  sql.withTransaction(effect).pipe(Effect.catchTag("SqlError", databaseError))
const commandEquivalent = Schema.toEquivalence(
  Schema.Struct({
    organizationId: ThreadCommand.fields.organizationId,
    threadId: ThreadCommand.fields.threadId,
    memberId: ThreadCommand.fields.memberId,
    clientId: ThreadCommand.fields.clientId,
    commandId: ThreadCommand.fields.commandId,
    idempotencyKey: ThreadCommand.fields.idempotencyKey,
    actor: ActorAttribution,
    command: JsonObject,
  }),
)
const eventEquivalent = Schema.toEquivalence(
  Schema.Struct({
    organizationId: ThreadEvent.fields.organizationId,
    threadId: ThreadEvent.fields.threadId,
    eventId: ThreadEvent.fields.eventId,
    idempotencyKey: ThreadEvent.fields.idempotencyKey,
    executorInstanceId: ThreadEvent.fields.executorInstanceId,
    assignmentGeneration: ThreadEvent.fields.assignmentGeneration,
    commandSequence: ThreadEvent.fields.commandSequence,
    event: JsonObject,
  }),
)

const allocateCommitCursor = Effect.fn("PostgresHostedRepository.allocateCommitCursor")(function* (
  sql: SqlClient,
  organizationId: string,
) {
  const rows = yield* query(sql<{ readonly cursor: string }>`UPDATE rika_hosted_organization_counters
    SET next_commit_cursor = next_commit_cursor + 1
    WHERE organization_id = ${organizationId}
    RETURNING (next_commit_cursor - 1)::text AS cursor`)
  if (rows[0] === undefined) return yield* failure("invalid-authority", "Organization authority is not initialized")
  return CommitCursor.make(rows[0].cursor)
})

const requireActiveClient = Effect.fn("PostgresHostedRepository.requireActiveClient")(function* (
  sql: SqlClient,
  input: {
    readonly organizationId: string
    readonly memberId: string
    readonly clientId: string
    readonly at?: string
  },
) {
  const rows = yield* query(sql<{ readonly deviceId: string }>`SELECT device_id AS "deviceId"
    FROM rika_hosted_clients
    WHERE id = ${input.clientId}
      AND organization_id = ${input.organizationId}
      AND member_id = ${input.memberId}
      AND revoked_at IS NULL
      AND expires_at > ${input.at === undefined ? sql.literal("transaction_timestamp()") : input.at}::timestamptz`)
  if (rows[0] === undefined)
    return yield* failure("invalid-authority", "The authenticated client is inactive or foreign")
  return rows[0]
})

const make = Effect.gen(function* (): Effect.fn.Return<HostedRepositoryInterface, never, PgClient.PgClient> {
  const sql = yield* PgClient.PgClient

  const createProject = Effect.fn("PostgresHostedRepository.createProject")(function* (input: CreateProjectInput) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const rows = yield* query(sql`INSERT INTO rika_hosted_projects
          (id, organization_id, name, created_by_member_id, created_at, updated_at)
          VALUES (${input.id}, ${input.organizationId}, ${input.name}, ${input.createdByMemberId}, ${input.now}, ${input.now})
          RETURNING id, organization_id AS "organizationId", name,
            created_by_member_id AS "createdByMemberId",
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`)
        yield* query(sql`INSERT INTO rika_hosted_project_grants
          (organization_id, project_id, member_id, role, granted_by_member_id, created_at, updated_at)
          VALUES (${input.organizationId}, ${input.id}, ${input.createdByMemberId}, 'owner',
            ${input.createdByMemberId}, ${input.now}, ${input.now})`)
        yield* query(sql`INSERT INTO rika_hosted_organization_counters (organization_id)
          VALUES (${input.organizationId}) ON CONFLICT (organization_id) DO NOTHING`)
        return yield* decode(Project, rows[0])
      }),
    )
  })

  const putProjectGrant = Effect.fn("PostgresHostedRepository.putProjectGrant")(function* (
    input: PutProjectGrantInput,
  ) {
    const rows = yield* query(sql`INSERT INTO rika_hosted_project_grants
      (organization_id, project_id, member_id, role, granted_by_member_id, created_at, updated_at)
      VALUES (${input.organizationId}, ${input.projectId}, ${input.memberId}, ${input.role},
        ${input.grantedByMemberId}, ${input.now}, ${input.now})
      ON CONFLICT (project_id, member_id) DO UPDATE SET
        role = EXCLUDED.role,
        granted_by_member_id = EXCLUDED.granted_by_member_id,
        updated_at = EXCLUDED.updated_at
      WHERE rika_hosted_project_grants.organization_id = EXCLUDED.organization_id
      RETURNING organization_id AS "organizationId", project_id AS "projectId", member_id AS "memberId", role,
        granted_by_member_id AS "grantedByMemberId",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`)
    if (rows[0] === undefined)
      return yield* failure("invalid-authority", "Project grant belongs to another organization")
    return yield* decode(ProjectGrant, rows[0])
  })

  const createWorkspace = Effect.fn("PostgresHostedRepository.createWorkspace")(function* (
    input: CreateWorkspaceInput,
  ) {
    const inheritProjectGrants = input.executorKind === "e2b" ? (input.inheritProjectGrants ?? true) : false
    if (input.executorKind === "local_device" && input.inheritProjectGrants === true) {
      return yield* failure("invalid-authority", "Local workspaces cannot inherit project grants")
    }
    const rows = yield* query(sql`INSERT INTO rika_hosted_workspaces
      (id, organization_id, project_id, created_by_member_id, executor_kind, inherit_project_grants, created_at)
      VALUES (${input.id}, ${input.organizationId}, ${input.projectId}, ${input.createdByMemberId},
        ${input.executorKind}, ${inheritProjectGrants}, ${input.now})
      RETURNING id, organization_id AS "organizationId", project_id AS "projectId",
        created_by_member_id AS "createdByMemberId", executor_kind AS "executorKind",
        inherit_project_grants AS "inheritProjectGrants",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`)
    return yield* decode(HostedWorkspace, rows[0])
  })

  const createThread = Effect.fn("PostgresHostedRepository.createThread")(function* (input: CreateThreadInput) {
    const inheritProjectGrants = input.executorKind === "e2b" ? (input.inheritProjectGrants ?? true) : false
    if (input.executorKind === "local_device" && input.inheritProjectGrants === true) {
      return yield* failure("invalid-authority", "Local threads cannot inherit project grants")
    }
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const rows = yield* query(sql`INSERT INTO rika_hosted_threads
          (id, organization_id, project_id, workspace_id, created_by_member_id, executor_kind,
            inherit_project_grants, created_at)
          VALUES (${input.id}, ${input.organizationId}, ${input.projectId}, ${input.workspaceId}, ${input.createdByMemberId},
            ${input.executorKind}, ${inheritProjectGrants}, ${input.now})
          RETURNING id, organization_id AS "organizationId", project_id AS "projectId", workspace_id AS "workspaceId",
            created_by_member_id AS "createdByMemberId", executor_kind AS "executorKind",
            inherit_project_grants AS "inheritProjectGrants",
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`)
        yield* query(sql`INSERT INTO rika_hosted_thread_grants
          (organization_id, thread_id, member_id, role, granted_by_member_id, created_at, updated_at)
          VALUES (${input.organizationId}, ${input.id}, ${input.createdByMemberId}, 'owner',
            ${input.createdByMemberId}, ${input.now}, ${input.now})`)
        return yield* decode(HostedThread, rows[0])
      }),
    )
  })

  const putThreadGrant = Effect.fn("PostgresHostedRepository.putThreadGrant")(function* (input: PutThreadGrantInput) {
    const rows = yield* query(sql`INSERT INTO rika_hosted_thread_grants
      (organization_id, thread_id, member_id, role, granted_by_member_id, created_at, updated_at)
      VALUES (${input.organizationId}, ${input.threadId}, ${input.memberId}, ${input.role},
        ${input.grantedByMemberId}, ${input.now}, ${input.now})
      ON CONFLICT (thread_id, member_id) DO UPDATE SET
        role = EXCLUDED.role,
        granted_by_member_id = EXCLUDED.granted_by_member_id,
        updated_at = EXCLUDED.updated_at
      WHERE rika_hosted_thread_grants.organization_id = EXCLUDED.organization_id
      RETURNING organization_id AS "organizationId", thread_id AS "threadId", member_id AS "memberId", role,
        granted_by_member_id AS "grantedByMemberId",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`)
    if (rows[0] === undefined)
      return yield* failure("invalid-authority", "Thread grant belongs to another organization")
    return yield* decode(ThreadGrant, rows[0])
  })

  const registerDevice = Effect.fn("PostgresHostedRepository.registerDevice")(function* (input: RegisterDeviceInput) {
    const rows = yield* query(sql`INSERT INTO rika_hosted_devices
      (id, organization_id, member_id, display_name, public_key_fingerprint, created_at, last_seen_at)
      VALUES (${input.id}, ${input.organizationId}, ${input.memberId}, ${input.displayName},
        ${input.publicKeyFingerprint}, ${input.now}, ${input.now})
      ON CONFLICT (id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        public_key_fingerprint = EXCLUDED.public_key_fingerprint,
        last_seen_at = EXCLUDED.last_seen_at
      WHERE rika_hosted_devices.organization_id = EXCLUDED.organization_id
        AND rika_hosted_devices.member_id = EXCLUDED.member_id
        AND rika_hosted_devices.revoked_at IS NULL
      RETURNING id, organization_id AS "organizationId", member_id AS "memberId",
        display_name AS "displayName", public_key_fingerprint AS "publicKeyFingerprint",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
        to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenAt",
        CASE WHEN revoked_at IS NULL THEN NULL
          ELSE to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "revokedAt"`)
    if (rows[0] === undefined) return yield* failure("invalid-authority", "Device identity cannot be reassigned")
    return yield* decode(AuthenticatedDevice, rows[0])
  })

  const authenticateClient = Effect.fn("PostgresHostedRepository.authenticateClient")(function* (
    input: AuthenticateClientInput,
  ) {
    const rows = yield* query(sql`INSERT INTO rika_hosted_clients
      (id, organization_id, member_id, device_id, authenticated_at, last_seen_at, expires_at)
      VALUES (${input.id}, ${input.organizationId}, ${input.memberId}, ${input.deviceId},
        ${input.now}, ${input.now}, ${input.expiresAt})
      ON CONFLICT (id) DO UPDATE SET
        last_seen_at = EXCLUDED.last_seen_at,
        expires_at = EXCLUDED.expires_at
      WHERE rika_hosted_clients.organization_id = EXCLUDED.organization_id
        AND rika_hosted_clients.member_id = EXCLUDED.member_id
        AND rika_hosted_clients.device_id = EXCLUDED.device_id
        AND rika_hosted_clients.revoked_at IS NULL
      RETURNING id, organization_id AS "organizationId", member_id AS "memberId", device_id AS "deviceId",
        to_char(authenticated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "authenticatedAt",
        to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenAt",
        to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt",
        CASE WHEN revoked_at IS NULL THEN NULL
          ELSE to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "revokedAt"`)
    if (rows[0] === undefined) return yield* failure("invalid-authority", "Client identity cannot be reassigned")
    return yield* decode(AuthenticatedClient, rows[0])
  })

  const registerExecutor = Effect.fn("PostgresHostedRepository.registerExecutor")(function* (
    input: RegisterExecutorInput,
  ) {
    if ((input.executorKind === "local_device") !== (input.deviceId !== null)) {
      return yield* failure("invalid-authority", "Executor kind and device identity do not match")
    }
    const rows = yield* query(sql`INSERT INTO rika_hosted_executor_instances
      (id, organization_id, executor_kind, device_id, status, connected_at, last_seen_at)
      VALUES (${input.id}, ${input.organizationId}, ${input.executorKind}, ${input.deviceId}, 'online',
        ${input.now}, ${input.now})
      ON CONFLICT (id) DO UPDATE SET status = 'online', last_seen_at = EXCLUDED.last_seen_at
      WHERE rika_hosted_executor_instances.organization_id = EXCLUDED.organization_id
        AND rika_hosted_executor_instances.executor_kind = EXCLUDED.executor_kind
        AND rika_hosted_executor_instances.device_id IS NOT DISTINCT FROM EXCLUDED.device_id
      RETURNING id, organization_id AS "organizationId", executor_kind AS "executorKind",
        device_id AS "deviceId", status,
        to_char(connected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "connectedAt",
        to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenAt"`)
    if (rows[0] === undefined) return yield* failure("invalid-authority", "Executor identity cannot be reassigned")
    return yield* decode(ExecutorInstance, rows[0])
  })

  const acquireAssignment = Effect.fn("PostgresHostedRepository.acquireAssignment")(function* (
    input: AcquireAssignmentInput,
  ) {
    const rows = yield* query(sql`INSERT INTO rika_hosted_executor_assignments
      (organization_id, thread_id, executor_instance_id, executor_kind, lease_id, generation,
        acquired_at, renewed_at, expires_at)
      VALUES (${input.organizationId}, ${input.threadId}, ${input.executorInstanceId}, ${input.executorKind},
        ${input.leaseId}, 1, ${input.now}, ${input.now}, ${input.expiresAt})
      ON CONFLICT (thread_id) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        executor_instance_id = EXCLUDED.executor_instance_id,
        executor_kind = EXCLUDED.executor_kind,
        lease_id = EXCLUDED.lease_id,
        generation = rika_hosted_executor_assignments.generation + 1,
        acquired_at = EXCLUDED.acquired_at,
        renewed_at = EXCLUDED.renewed_at,
        expires_at = EXCLUDED.expires_at
      WHERE rika_hosted_executor_assignments.organization_id = EXCLUDED.organization_id
        AND rika_hosted_executor_assignments.expires_at <= ${input.now}::timestamptz
      RETURNING organization_id AS "organizationId", thread_id AS "threadId",
        executor_instance_id AS "executorInstanceId", executor_kind AS "executorKind", lease_id AS "leaseId",
        generation::text AS generation,
        to_char(acquired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "acquiredAt",
        to_char(renewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "renewedAt",
        to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"`)
    if (rows[0] === undefined) return yield* failure("lease-unavailable", "Thread already has an active executor lease")
    return yield* decode(ExecutorAssignmentLease, rows[0])
  })

  const renewAssignment = Effect.fn("PostgresHostedRepository.renewAssignment")(function* (
    input: RenewAssignmentInput,
  ) {
    const rows = yield* query(sql`UPDATE rika_hosted_executor_assignments SET
      renewed_at = ${input.now}, expires_at = ${input.expiresAt}
      WHERE organization_id = ${input.organizationId}
        AND thread_id = ${input.threadId}
        AND executor_instance_id = ${input.executorInstanceId}
        AND lease_id = ${input.leaseId}
        AND generation = ${input.generation}::bigint
        AND expires_at > ${input.now}::timestamptz
      RETURNING organization_id AS "organizationId", thread_id AS "threadId",
        executor_instance_id AS "executorInstanceId", executor_kind AS "executorKind", lease_id AS "leaseId",
        generation::text AS generation,
        to_char(acquired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "acquiredAt",
        to_char(renewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "renewedAt",
        to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"`)
    if (rows[0] === undefined) return yield* failure("stale-fence", "Executor lease is expired or fenced")
    return yield* decode(ExecutorAssignmentLease, rows[0])
  })

  const admitCommand = Effect.fn("PostgresHostedRepository.admitCommand")(function* (input: AdmitCommandInput) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const locked = yield* query(sql`SELECT id FROM rika_hosted_threads
          WHERE id = ${input.threadId} AND organization_id = ${input.organizationId} FOR UPDATE`)
        if (locked[0] === undefined) return yield* failure("not-found", "Thread does not exist in the organization")
        const client = yield* requireActiveClient(sql, { ...input, at: input.admittedAt })
        if (
          input.actor.organizationId !== input.organizationId ||
          input.actor.memberId !== input.memberId ||
          input.actor.clientId !== input.clientId ||
          input.actor.deviceId !== client.deviceId
        ) {
          return yield* failure(
            "invalid-authority",
            "Command actor attribution does not match the authenticated client",
          )
        }
        const existingRows = yield* query(sql`SELECT organization_id AS "organizationId", thread_id AS "threadId",
          member_id AS "memberId", client_id AS "clientId", command_id AS "commandId",
          idempotency_key AS "idempotencyKey", actor, sequence::text AS sequence,
          commit_cursor::text AS "commitCursor", command,
          to_char(admitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "admittedAt"
          FROM rika_hosted_thread_commands
          WHERE thread_id = ${input.threadId}
            AND (command_id = ${input.commandId} OR idempotency_key = ${input.idempotencyKey})`)
        if (existingRows[0] !== undefined) {
          const existing = yield* decode(ThreadCommand, existingRows[0])
          if (!commandEquivalent(existing, input)) {
            return yield* failure("conflict", "Command identity or idempotency key was reused with different content")
          }
          return existing
        }
        if (input.command._tag === "TerminalInput") {
          const writer = yield* query(sql`SELECT 1 FROM rika_hosted_terminal_writer_leases
            WHERE organization_id = ${input.organizationId}
              AND thread_id = ${input.threadId}
              AND member_id = ${input.memberId}
              AND client_id = ${input.clientId}
              AND lease_id = ${input.command.writerLeaseId}
              AND generation = ${input.command.writerGeneration}::bigint
              AND expires_at > ${input.admittedAt}::timestamptz`)
          if (writer[0] === undefined)
            return yield* failure("stale-fence", "Terminal writer lease is expired or fenced")
        }
        const sequences = yield* query(sql<{ readonly sequence: string }>`UPDATE rika_hosted_threads
          SET next_command_sequence = next_command_sequence + 1
          WHERE id = ${input.threadId} AND organization_id = ${input.organizationId}
          RETURNING (next_command_sequence - 1)::text AS sequence`)
        const sequence = Sequence.make(sequences[0]!.sequence)
        const commitCursor = yield* allocateCommitCursor(sql, input.organizationId)
        const rows = yield* query(sql`INSERT INTO rika_hosted_thread_commands
          (organization_id, thread_id, member_id, client_id, command_id, idempotency_key,
            actor, sequence, commit_cursor, command, admitted_at)
          VALUES (${input.organizationId}, ${input.threadId}, ${input.memberId}, ${input.clientId},
            ${input.commandId}, ${input.idempotencyKey}, ${sql.json(input.actor)}, ${sequence}::bigint,
            ${commitCursor}::bigint, ${sql.json(input.command)}, ${input.admittedAt})
          RETURNING organization_id AS "organizationId", thread_id AS "threadId", member_id AS "memberId",
            client_id AS "clientId", command_id AS "commandId", idempotency_key AS "idempotencyKey",
            actor, sequence::text AS sequence, commit_cursor::text AS "commitCursor", command,
            to_char(admitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "admittedAt"`)
        return yield* decode(ThreadCommand, rows[0])
      }),
    )
  })

  const readCommands: HostedRepositoryInterface["readCommands"] = Effect.fn("PostgresHostedRepository.readCommands")(
    function* (input) {
      yield* requireActiveClient(sql, input)
      const rows = yield* query(sql`SELECT organization_id AS "organizationId", thread_id AS "threadId",
      member_id AS "memberId", client_id AS "clientId", command_id AS "commandId",
      idempotency_key AS "idempotencyKey", actor, sequence::text AS sequence,
      commit_cursor::text AS "commitCursor", command,
      to_char(admitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "admittedAt"
      FROM rika_hosted_thread_commands
      WHERE organization_id = ${input.organizationId} AND thread_id = ${input.threadId}
        AND commit_cursor > ${input.afterCommitCursor}::bigint
      ORDER BY commit_cursor ASC LIMIT ${limit(input.limit)}`)
      return yield* Effect.forEach(rows, (row) => decode(ThreadCommand, row))
    },
  )

  const appendEvent = Effect.fn("PostgresHostedRepository.appendEvent")(function* (input: AppendEventInput) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const locked = yield* query(sql`SELECT id FROM rika_hosted_threads
          WHERE id = ${input.threadId} AND organization_id = ${input.organizationId} FOR UPDATE`)
        if (locked[0] === undefined) return yield* failure("not-found", "Thread does not exist in the organization")
        const existingRows = yield* query(sql`SELECT organization_id AS "organizationId", thread_id AS "threadId",
          event_id AS "eventId", idempotency_key AS "idempotencyKey",
          executor_instance_id AS "executorInstanceId", assignment_generation::text AS "assignmentGeneration",
          sequence::text AS sequence, commit_cursor::text AS "commitCursor",
          command_sequence::text AS "commandSequence", event,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
          FROM rika_hosted_thread_events
          WHERE thread_id = ${input.threadId}
            AND (event_id = ${input.eventId} OR idempotency_key = ${input.idempotencyKey})`)
        if (existingRows[0] !== undefined) {
          const existing = yield* decode(ThreadEvent, existingRows[0])
          if (!eventEquivalent(existing, input)) {
            return yield* failure("conflict", "Event identity or idempotency key was reused with different content")
          }
          return existing
        }
        const assignment = yield* query(sql`SELECT 1 FROM rika_hosted_executor_assignments
          WHERE organization_id = ${input.organizationId}
            AND thread_id = ${input.threadId}
            AND executor_instance_id = ${input.executorInstanceId}
            AND lease_id = ${input.leaseId}
            AND generation = ${input.assignmentGeneration}::bigint
            AND expires_at > ${input.createdAt}::timestamptz`)
        if (assignment[0] === undefined)
          return yield* failure("stale-fence", "Executor assignment is expired or fenced")
        const sequences = yield* query(sql<{ readonly sequence: string }>`UPDATE rika_hosted_threads
          SET next_event_sequence = next_event_sequence + 1
          WHERE id = ${input.threadId} AND organization_id = ${input.organizationId}
          RETURNING (next_event_sequence - 1)::text AS sequence`)
        const sequence = Sequence.make(sequences[0]!.sequence)
        const commitCursor = yield* allocateCommitCursor(sql, input.organizationId)
        const rows = yield* query(sql`INSERT INTO rika_hosted_thread_events
          (organization_id, thread_id, event_id, idempotency_key, executor_instance_id,
            assignment_generation, sequence, commit_cursor, command_sequence, event, created_at)
          VALUES (${input.organizationId}, ${input.threadId}, ${input.eventId}, ${input.idempotencyKey},
            ${input.executorInstanceId}, ${input.assignmentGeneration}::bigint, ${sequence}::bigint,
            ${commitCursor}::bigint, ${input.commandSequence}::bigint, ${sql.json(input.event)}, ${input.createdAt})
          RETURNING organization_id AS "organizationId", thread_id AS "threadId", event_id AS "eventId",
            idempotency_key AS "idempotencyKey", executor_instance_id AS "executorInstanceId",
            assignment_generation::text AS "assignmentGeneration", sequence::text AS sequence,
            commit_cursor::text AS "commitCursor",
            command_sequence::text AS "commandSequence", event,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`)
        return yield* decode(ThreadEvent, rows[0])
      }),
    )
  })

  const readEvents: HostedRepositoryInterface["readEvents"] = Effect.fn("PostgresHostedRepository.readEvents")(
    function* (input) {
      yield* requireActiveClient(sql, input)
      const rows = yield* query(sql`SELECT organization_id AS "organizationId", thread_id AS "threadId",
        event_id AS "eventId", idempotency_key AS "idempotencyKey",
        executor_instance_id AS "executorInstanceId", assignment_generation::text AS "assignmentGeneration",
        sequence::text AS sequence, commit_cursor::text AS "commitCursor",
        command_sequence::text AS "commandSequence", event,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
        FROM rika_hosted_thread_events
        WHERE organization_id = ${input.organizationId} AND thread_id = ${input.threadId}
          AND commit_cursor > ${input.afterCommitCursor}::bigint
        ORDER BY commit_cursor ASC LIMIT ${limit(input.limit)}`)
      return yield* Effect.forEach(rows, (row) => decode(ThreadEvent, row))
    },
  )

  const acknowledgeCursor: HostedRepositoryInterface["acknowledgeCursor"] = Effect.fn(
    "PostgresHostedRepository.acknowledgeCursor",
  )(function* (input) {
    yield* requireActiveClient(sql, { ...input, at: input.now })
    const events = yield* query(sql`SELECT 1 FROM rika_hosted_thread_events
      WHERE thread_id = ${input.threadId}
        AND organization_id = ${input.organizationId}
        AND commit_cursor = ${input.commitCursor}::bigint`)
    if (events[0] === undefined) {
      return yield* failure("conflict", "Cursor must reference a persisted thread event")
    }
    const rows = yield* query(sql`INSERT INTO rika_hosted_client_cursors
      (organization_id, thread_id, member_id, client_id, commit_cursor, updated_at)
      VALUES (${input.organizationId}, ${input.threadId}, ${input.memberId}, ${input.clientId},
        ${input.commitCursor}::bigint, ${input.now})
      ON CONFLICT (thread_id, client_id) DO UPDATE SET
        commit_cursor = GREATEST(rika_hosted_client_cursors.commit_cursor, EXCLUDED.commit_cursor),
        updated_at = EXCLUDED.updated_at
      RETURNING organization_id AS "organizationId", thread_id AS "threadId", member_id AS "memberId",
        client_id AS "clientId", commit_cursor::text AS "commitCursor",
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`)
    return yield* decode(ResumableCursor, rows[0])
  })

  const acquireTerminalWriter = Effect.fn("PostgresHostedRepository.acquireTerminalWriter")(function* (
    input: AcquireTerminalWriterInput,
  ) {
    yield* requireActiveClient(sql, { ...input, at: input.now })
    const rows = yield* query(sql`INSERT INTO rika_hosted_terminal_writer_leases
      (organization_id, thread_id, member_id, client_id, lease_id, generation, acquired_at, renewed_at, expires_at)
      VALUES (${input.organizationId}, ${input.threadId}, ${input.memberId}, ${input.clientId},
        ${input.leaseId}, 1, ${input.now}, ${input.now}, ${input.expiresAt})
      ON CONFLICT (thread_id) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        member_id = EXCLUDED.member_id,
        client_id = EXCLUDED.client_id,
        lease_id = EXCLUDED.lease_id,
        generation = rika_hosted_terminal_writer_leases.generation + 1,
        acquired_at = EXCLUDED.acquired_at,
        renewed_at = EXCLUDED.renewed_at,
        expires_at = EXCLUDED.expires_at
      WHERE rika_hosted_terminal_writer_leases.organization_id = EXCLUDED.organization_id
        AND rika_hosted_terminal_writer_leases.expires_at <= ${input.now}::timestamptz
      RETURNING organization_id AS "organizationId", thread_id AS "threadId", member_id AS "memberId",
        client_id AS "clientId", lease_id AS "leaseId", generation::text AS generation,
        to_char(acquired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "acquiredAt",
        to_char(renewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "renewedAt",
        to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"`)
    if (rows[0] === undefined)
      return yield* failure("lease-unavailable", "Thread already has an active terminal writer")
    return yield* decode(TerminalWriterLease, rows[0])
  })

  const renewTerminalWriter = Effect.fn("PostgresHostedRepository.renewTerminalWriter")(function* (
    input: RenewTerminalWriterInput,
  ) {
    yield* requireActiveClient(sql, { ...input, at: input.now })
    const rows = yield* query(sql`UPDATE rika_hosted_terminal_writer_leases SET
      renewed_at = ${input.now}, expires_at = ${input.expiresAt}
      WHERE organization_id = ${input.organizationId}
        AND thread_id = ${input.threadId}
        AND member_id = ${input.memberId}
        AND client_id = ${input.clientId}
        AND lease_id = ${input.leaseId}
        AND generation = ${input.generation}::bigint
        AND expires_at > ${input.now}::timestamptz
      RETURNING organization_id AS "organizationId", thread_id AS "threadId", member_id AS "memberId",
        client_id AS "clientId", lease_id AS "leaseId", generation::text AS generation,
        to_char(acquired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "acquiredAt",
        to_char(renewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "renewedAt",
        to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"`)
    if (rows[0] === undefined) return yield* failure("stale-fence", "Terminal writer lease is expired or fenced")
    return yield* decode(TerminalWriterLease, rows[0])
  })

  const upsertPresence = Effect.fn("PostgresHostedRepository.upsertPresence")(function* (input: UpsertPresenceInput) {
    yield* requireActiveClient(sql, { ...input, at: input.now })
    const rows = yield* query(sql`INSERT INTO rika_hosted_presence
      (organization_id, thread_id, member_id, client_id, status, last_seen_at, expires_at)
      VALUES (${input.organizationId}, ${input.threadId}, ${input.memberId}, ${input.clientId},
        ${input.status}, ${input.now}, ${input.expiresAt})
      ON CONFLICT (thread_id, client_id) DO UPDATE SET
        status = EXCLUDED.status,
        last_seen_at = EXCLUDED.last_seen_at,
        expires_at = EXCLUDED.expires_at
      RETURNING organization_id AS "organizationId", thread_id AS "threadId", member_id AS "memberId",
        client_id AS "clientId", status,
        to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenAt",
        to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"`)
    return yield* decode(Presence, rows[0])
  })

  const listPresence: HostedRepositoryInterface["listPresence"] = Effect.fn("PostgresHostedRepository.listPresence")(
    function* (input) {
      yield* requireActiveClient(sql, { ...input, at: input.now })
      const rows = yield* query(sql`SELECT organization_id AS "organizationId", thread_id AS "threadId",
      member_id AS "memberId", client_id AS "clientId", status,
      to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenAt",
      to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"
      FROM rika_hosted_presence
      WHERE organization_id = ${input.organizationId} AND thread_id = ${input.threadId}
        AND expires_at > ${input.now}::timestamptz
      ORDER BY member_id, client_id`)
      return yield* Effect.forEach(rows, (row) => decode(Presence, row))
    },
  )

  const bindLocalWorkspace = Effect.fn("PostgresHostedRepository.bindLocalWorkspace")(function* (
    input: BindLocalWorkspaceInput,
  ) {
    const rows = yield* query(sql`INSERT INTO rika_hosted_local_workspace_bindings
      (id, organization_id, thread_id, member_id, device_id, root_path, workspace_fingerprint,
        created_at, last_seen_at)
      VALUES (${input.id}, ${input.organizationId}, ${input.threadId}, ${input.memberId}, ${input.deviceId},
        ${input.rootPath}, ${input.workspaceFingerprint}, ${input.now}, ${input.now})
      ON CONFLICT (thread_id, device_id) DO UPDATE SET
        root_path = EXCLUDED.root_path,
        workspace_fingerprint = EXCLUDED.workspace_fingerprint,
        last_seen_at = EXCLUDED.last_seen_at
      WHERE rika_hosted_local_workspace_bindings.organization_id = EXCLUDED.organization_id
        AND rika_hosted_local_workspace_bindings.member_id = EXCLUDED.member_id
      RETURNING id, organization_id AS "organizationId", thread_id AS "threadId", member_id AS "memberId",
        device_id AS "deviceId", root_path AS "rootPath", workspace_fingerprint AS "workspaceFingerprint",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
        to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenAt"`)
    if (rows[0] === undefined)
      return yield* failure("invalid-authority", "Workspace binding identity cannot be reassigned")
    return yield* decode(LocalWorkspaceBinding, rows[0])
  })

  const saveCheckpoint = Effect.fn("PostgresHostedRepository.saveCheckpoint")(function* (input: SaveCheckpointInput) {
    const assignments = yield* query(sql`SELECT 1 FROM rika_hosted_executor_assignments
      WHERE organization_id = ${input.organizationId}
        AND thread_id = ${input.threadId}
        AND executor_instance_id = ${input.executorInstanceId}
        AND lease_id = ${input.leaseId}
        AND generation = ${input.assignmentGeneration}::bigint
        AND expires_at > ${input.createdAt}::timestamptz`)
    if (assignments[0] === undefined) return yield* failure("stale-fence", "Executor assignment is expired or fenced")
    const rows = yield* query(sql`INSERT INTO rika_hosted_checkpoints
      (id, organization_id, thread_id, executor_instance_id, assignment_generation, event_sequence,
        baton_checkpoint_reference, metadata, created_at)
      VALUES (${input.id}, ${input.organizationId}, ${input.threadId}, ${input.executorInstanceId},
        ${input.assignmentGeneration}::bigint, ${input.eventSequence}::bigint,
        ${input.batonCheckpointReference}, ${sql.json(input.metadata)}, ${input.createdAt})
      ON CONFLICT (id) DO NOTHING
      RETURNING id, organization_id AS "organizationId", thread_id AS "threadId",
        executor_instance_id AS "executorInstanceId", assignment_generation::text AS "assignmentGeneration",
        event_sequence::text AS "eventSequence", baton_checkpoint_reference AS "batonCheckpointReference", metadata,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`)
    if (rows[0] === undefined) return yield* failure("conflict", "Checkpoint identity already exists")
    return yield* decode(Checkpoint, rows[0])
  })

  const recordAuditEvent = Effect.fn("PostgresHostedRepository.recordAuditEvent")(function* (
    input: RecordAuditEventInput,
  ) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        yield* requireActiveClient(sql, {
          organizationId: input.organizationId,
          memberId: input.actorMemberId,
          clientId: input.actorClientId,
          at: input.occurredAt,
        })
        const commitCursor = yield* allocateCommitCursor(sql, input.organizationId)
        const rows = yield* query(sql`INSERT INTO rika_hosted_audit_events
          (id, organization_id, actor_member_id, actor_client_id, action, resource_kind, resource_id,
            commit_cursor, attributes, occurred_at)
          VALUES (${input.id}, ${input.organizationId}, ${input.actorMemberId}, ${input.actorClientId},
            ${input.action}, ${input.resourceKind}, ${input.resourceId}, ${commitCursor}::bigint,
            ${sql.json(input.attributes)}, ${input.occurredAt})
          RETURNING id, organization_id AS "organizationId", actor_member_id AS "actorMemberId",
            actor_client_id AS "actorClientId", action, resource_kind AS "resourceKind", resource_id AS "resourceId",
            commit_cursor::text AS "commitCursor", attributes,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt"`)
        return yield* decode(AuditEvent, rows[0])
      }),
    )
  })

  const putCredentialReference = Effect.fn("PostgresHostedRepository.putCredentialReference")(function* (
    input: PutCredentialReferenceInput,
  ) {
    const rows = yield* query(sql`INSERT INTO rika_hosted_credential_references
      (id, organization_id, project_id, provider, purpose, external_reference, metadata,
        created_by_member_id, created_at, updated_at)
      VALUES (${input.id}, ${input.organizationId}, ${input.projectId}, ${input.provider}, ${input.purpose},
        ${input.externalReference}, ${sql.json(input.metadata)}, ${input.createdByMemberId}, ${input.now}, ${input.now})
      ON CONFLICT (id) DO UPDATE SET
        purpose = EXCLUDED.purpose,
        external_reference = EXCLUDED.external_reference,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at
      WHERE rika_hosted_credential_references.organization_id = EXCLUDED.organization_id
        AND rika_hosted_credential_references.project_id IS NOT DISTINCT FROM EXCLUDED.project_id
        AND rika_hosted_credential_references.provider = EXCLUDED.provider
        AND rika_hosted_credential_references.created_by_member_id = EXCLUDED.created_by_member_id
      RETURNING id, organization_id AS "organizationId", project_id AS "projectId", provider, purpose,
        external_reference AS "externalReference", metadata, created_by_member_id AS "createdByMemberId",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`)
    if (rows[0] === undefined)
      return yield* failure("invalid-authority", "Credential reference identity cannot be reassigned")
    return yield* decode(CredentialReference, rows[0])
  })

  return HostedRepository.of({
    createProject,
    putProjectGrant,
    createWorkspace,
    createThread,
    putThreadGrant,
    registerDevice,
    authenticateClient,
    registerExecutor,
    acquireAssignment,
    renewAssignment,
    admitCommand,
    readCommands,
    appendEvent,
    readEvents,
    acknowledgeCursor,
    acquireTerminalWriter,
    renewTerminalWriter,
    upsertPresence,
    listPresence,
    bindLocalWorkspace,
    saveCheckpoint,
    recordAuditEvent,
    putCredentialReference,
  })
})

export const layer = Layer.effect(HostedRepository, make)
