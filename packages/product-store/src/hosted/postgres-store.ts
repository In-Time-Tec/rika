import * as PgClient from "@effect/sql-pg/PgClient"
import { Effect, Layer, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import {
  ActorAttribution,
  AuditEvent,
  AuthenticatedClient,
  AuthenticatedDevice,
  CommitCursor,
  CredentialReference,
  HostedThread,
  HostedWorkspace,
  JsonObject,
  LocalWorkspaceBinding,
  type ExecutorInstanceId,
  type OrganizationId,
  Presence,
  Project,
  ProjectGrant,
  ResumableCursor,
  Sequence,
  TerminalWriterLease,
  ThreadCommand,
  ThreadEvent,
  ThreadGrant,
  type ThreadId,
} from "@rika/product/hosted-model"
import {
  HostedStore,
  StoreError,
  type AcquireTerminalWriterInput,
  type AdmitCommandInput,
  type AppendEventInput,
  type AuthenticateClientInput,
  type BindLocalWorkspaceInput,
  type CreateProjectInput,
  type CreateThreadInput,
  type CreateWorkspaceInput,
  type StoreService,
  type PutCredentialReferenceInput,
  type PutProjectGrantInput,
  type PutThreadGrantInput,
  type RecordAuditEventInput,
  type RegisterDeviceInput,
  type RenewTerminalWriterInput,
  type UpsertPresenceInput,
} from "@rika/product/hosted-store"

const databaseError = (cause: unknown) =>
  StoreError.make({ reason: "database", message: `Hosted PostgreSQL operation failed: ${String(cause)}` })
const failure = (reason: StoreError["reason"], message: string) => StoreError.make({ reason, message })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))
const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(databaseError))
const limit = (value: number) => Math.min(Math.max(Math.trunc(value), 1), 1_000)
const transaction = <A>(sql: SqlClient, effect: Effect.Effect<A, StoreError>) =>
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
    assignmentId: ThreadEvent.fields.assignmentId,
    executorInstanceId: ThreadEvent.fields.executorInstanceId,
    assignmentGeneration: ThreadEvent.fields.assignmentGeneration,
    leaseEpoch: ThreadEvent.fields.leaseEpoch,
    commandSequence: ThreadEvent.fields.commandSequence,
    event: JsonObject,
  }),
)

const allocateCommitCursor = Effect.fn("PostgresStore.allocateCommitCursor")(function* (
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

const roleRank = { viewer: 1, controller: 2, operator: 3, owner: 4 } as const

const requireMembership = Effect.fn("PostgresStore.requireMembership")(function* (
  sql: SqlClient,
  input: { readonly organizationId: string; readonly memberId: string },
) {
  const rows = yield* query(sql`SELECT 1 FROM "member"
    WHERE id = ${input.memberId} AND organization_id = ${input.organizationId}
    FOR KEY SHARE`)
  if (rows[0] === undefined) return yield* failure("invalid-authority", "Resource is unavailable")
})

const requireProjectAccess = Effect.fn("PostgresStore.requireProjectAccess")(function* (
  sql: SqlClient,
  input: { readonly organizationId: string; readonly projectId: string; readonly memberId: string },
  minimum: number,
) {
  yield* requireMembership(sql, input)
  const rows = yield* query(sql<{ readonly role: keyof typeof roleRank }>`SELECT grant_record.role
    FROM rika_hosted_projects project
    JOIN rika_hosted_project_grants grant_record
      ON grant_record.organization_id = project.organization_id AND grant_record.project_id = project.id
    WHERE project.organization_id = ${input.organizationId}
      AND project.id = ${input.projectId}
      AND grant_record.member_id = ${input.memberId}
    FOR KEY SHARE OF project, grant_record`)
  if (rows[0] === undefined || roleRank[rows[0].role] < minimum)
    return yield* failure("invalid-authority", "Resource is unavailable")
})

const requireThreadAccess = Effect.fn("PostgresStore.requireThreadAccess")(function* (
  sql: SqlClient,
  input: { readonly organizationId: string; readonly threadId: string; readonly memberId: string },
  minimum: number,
) {
  yield* requireMembership(sql, input)
  const threads = yield* query(sql<{
    readonly createdByMemberId: string
    readonly projectId: string
    readonly executorKind: "local_device" | "e2b"
    readonly inheritProjectGrants: boolean
  }>`SELECT created_by_member_id AS "createdByMemberId", project_id AS "projectId",
      executor_kind AS "executorKind", inherit_project_grants AS "inheritProjectGrants"
    FROM rika_hosted_threads
    WHERE organization_id = ${input.organizationId} AND id = ${input.threadId}
    FOR KEY SHARE`)
  const thread = threads[0]
  if (thread === undefined) return yield* failure("invalid-authority", "Resource is unavailable")
  if (thread.createdByMemberId === input.memberId) return
  const direct = yield* query(sql<{ readonly role: keyof typeof roleRank }>`SELECT role
    FROM rika_hosted_thread_grants
    WHERE organization_id = ${input.organizationId}
      AND thread_id = ${input.threadId}
      AND member_id = ${input.memberId}
    FOR KEY SHARE`)
  const inherited =
    thread.executorKind === "e2b" && thread.inheritProjectGrants
      ? yield* query(sql<{ readonly role: keyof typeof roleRank }>`SELECT role
          FROM rika_hosted_project_grants
          WHERE organization_id = ${input.organizationId}
            AND project_id = ${thread.projectId}
            AND member_id = ${input.memberId}
          FOR KEY SHARE`)
      : []
  const available = Math.max(
    direct[0] === undefined ? 0 : roleRank[direct[0].role],
    inherited[0] === undefined ? 0 : roleRank[inherited[0].role],
  )
  if (available < minimum) return yield* failure("invalid-authority", "Resource is unavailable")
})

const requireActiveClient = Effect.fn("PostgresStore.requireActiveClient")(function* (
  sql: SqlClient,
  input: {
    readonly organizationId: string
    readonly memberId: string
    readonly clientId: string
  },
) {
  yield* requireMembership(sql, input)
  const rows = yield* query(sql<{ readonly deviceId: string }>`SELECT device_id AS "deviceId"
    FROM rika_hosted_clients client_record
    JOIN rika_hosted_devices device
      ON device.id = client_record.device_id
      AND device.organization_id = client_record.organization_id
      AND device.member_id = client_record.member_id
    WHERE client_record.id = ${input.clientId}
      AND client_record.organization_id = ${input.organizationId}
      AND client_record.member_id = ${input.memberId}
      AND client_record.revoked_at IS NULL
      AND device.revoked_at IS NULL
      AND client_record.expires_at > transaction_timestamp()
    FOR KEY SHARE OF client_record, device`)
  if (rows[0] === undefined)
    return yield* failure("invalid-authority", "The authenticated client is inactive or foreign")
  return rows[0]
})

const make = Effect.gen(function* (): Effect.fn.Return<StoreService, never, PgClient.PgClient> {
  const sql = yield* PgClient.PgClient

  const createProject = Effect.fn("PostgresStore.createProject")(function* (input: CreateProjectInput) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        yield* requireMembership(sql, {
          organizationId: input.organizationId,
          memberId: input.createdByMemberId,
        })
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

  const putProjectGrant = Effect.fn("PostgresStore.putProjectGrant")(function* (
    input: PutProjectGrantInput,
  ) {
    return yield* transaction(sql, Effect.gen(function* () {
      yield* requireProjectAccess(sql, {
        organizationId: input.organizationId,
        projectId: input.projectId,
        memberId: input.grantedByMemberId,
      }, roleRank.owner)
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
    }))
  })

  const createWorkspace = Effect.fn("PostgresStore.createWorkspace")(function* (
    input: CreateWorkspaceInput,
  ) {
    const inheritProjectGrants = input.executorKind === "e2b" ? (input.inheritProjectGrants ?? true) : false
    if (input.executorKind === "local_device" && input.inheritProjectGrants === true) {
      return yield* failure("invalid-authority", "Local workspaces cannot inherit project grants")
    }
    yield* requireProjectAccess(sql, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      memberId: input.createdByMemberId,
    }, roleRank.operator)
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

  const createThread = Effect.fn("PostgresStore.createThread")(function* (input: CreateThreadInput) {
    const inheritProjectGrants = input.executorKind === "e2b" ? (input.inheritProjectGrants ?? true) : false
    if (input.executorKind === "local_device" && input.inheritProjectGrants === true) {
      return yield* failure("invalid-authority", "Local threads cannot inherit project grants")
    }
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        yield* requireProjectAccess(sql, {
          organizationId: input.organizationId,
          projectId: input.projectId,
          memberId: input.createdByMemberId,
        }, roleRank.operator)
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

  const putThreadGrant = Effect.fn("PostgresStore.putThreadGrant")(function* (input: PutThreadGrantInput) {
    return yield* transaction(sql, Effect.gen(function* () {
      yield* requireThreadAccess(sql, {
        organizationId: input.organizationId,
        threadId: input.threadId,
        memberId: input.grantedByMemberId,
      }, roleRank.owner)
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
    }))
  })

  const registerDevice = Effect.fn("PostgresStore.registerDevice")(function* (input: RegisterDeviceInput) {
    yield* requireMembership(sql, input)
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

  const authenticateClient = Effect.fn("PostgresStore.authenticateClient")(function* (
    input: AuthenticateClientInput,
  ) {
    yield* requireMembership(sql, input)
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

  const admitCommand = Effect.fn("PostgresStore.admitCommand")(function* (input: AdmitCommandInput) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const locked = yield* query(sql`SELECT id FROM rika_hosted_threads
          WHERE id = ${input.threadId} AND organization_id = ${input.organizationId} FOR UPDATE`)
        if (locked[0] === undefined) return yield* failure("not-found", "Thread does not exist in the organization")
        const client = yield* requireActiveClient(sql, input)
        yield* requireThreadAccess(sql, input, roleRank.controller)
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

  const readCommands: StoreService["readCommands"] = Effect.fn("PostgresStore.readCommands")(
    function* (input) {
      yield* requireActiveClient(sql, input)
      yield* requireThreadAccess(sql, input, roleRank.viewer)
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

  const appendEvent = Effect.fn("PostgresStore.appendEvent")(function* (input: AppendEventInput) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const assignments = yield* query(sql<{
          readonly organizationId: OrganizationId
          readonly threadId: ThreadId
          readonly executorInstanceId: ExecutorInstanceId
        }>`SELECT organization_id AS "organizationId", thread_id AS "threadId",
            executor_instance_id AS "executorInstanceId"
          FROM rika_hosted_executor_assignments
          WHERE id = ${input.assignmentId}
            AND generation = ${input.assignmentGeneration}::bigint
            AND lease_epoch = ${input.leaseEpoch}::bigint
            AND lifecycle = 'active'
            AND lease_expires_at > transaction_timestamp()
          FOR SHARE`)
        const assignment = assignments[0]
        if (assignment === undefined)
          return yield* failure("stale-fence", "Executor assignment is expired or fenced")
        const locked = yield* query(sql`SELECT id FROM rika_hosted_threads
          WHERE id = ${assignment.threadId} AND organization_id = ${assignment.organizationId} FOR UPDATE`)
        if (locked[0] === undefined) return yield* failure("not-found", "Thread does not exist in the organization")
        const existingRows = yield* query(sql`SELECT organization_id AS "organizationId", thread_id AS "threadId",
          event_id AS "eventId", idempotency_key AS "idempotencyKey",
          assignment_id AS "assignmentId", executor_instance_id AS "executorInstanceId",
          assignment_generation::text AS "assignmentGeneration", lease_epoch::text AS "leaseEpoch",
          sequence::text AS sequence, commit_cursor::text AS "commitCursor",
          command_sequence::text AS "commandSequence", event,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
          FROM rika_hosted_thread_events
          WHERE thread_id = ${assignment.threadId}
            AND (event_id = ${input.eventId} OR idempotency_key = ${input.idempotencyKey})`)
        const comparable = {
          ...input,
          organizationId: assignment.organizationId,
          threadId: assignment.threadId,
          executorInstanceId: assignment.executorInstanceId,
        }
        if (existingRows[0] !== undefined) {
          const existing = yield* decode(ThreadEvent, existingRows[0])
          if (!eventEquivalent(existing, comparable)) {
            return yield* failure("conflict", "Event identity or idempotency key was reused with different content")
          }
          return existing
        }
        const sequences = yield* query(sql<{ readonly sequence: string }>`UPDATE rika_hosted_threads
          SET next_event_sequence = next_event_sequence + 1
          WHERE id = ${assignment.threadId} AND organization_id = ${assignment.organizationId}
          RETURNING (next_event_sequence - 1)::text AS sequence`)
        const sequence = Sequence.make(sequences[0]!.sequence)
        const commitCursor = yield* allocateCommitCursor(sql, assignment.organizationId)
        const rows = yield* query(sql`INSERT INTO rika_hosted_thread_events
          (organization_id, thread_id, event_id, idempotency_key, assignment_id, executor_instance_id,
            assignment_generation, lease_epoch, sequence, commit_cursor, command_sequence, event)
          VALUES (${assignment.organizationId}, ${assignment.threadId}, ${input.eventId}, ${input.idempotencyKey},
            ${input.assignmentId}, ${assignment.executorInstanceId}, ${input.assignmentGeneration}::bigint,
            ${input.leaseEpoch}::bigint, ${sequence}::bigint, ${commitCursor}::bigint,
            ${input.commandSequence}::bigint, ${sql.json(input.event)})
          RETURNING organization_id AS "organizationId", thread_id AS "threadId", event_id AS "eventId",
            idempotency_key AS "idempotencyKey", assignment_id AS "assignmentId",
            executor_instance_id AS "executorInstanceId", assignment_generation::text AS "assignmentGeneration",
            lease_epoch::text AS "leaseEpoch", sequence::text AS sequence,
            commit_cursor::text AS "commitCursor",
            command_sequence::text AS "commandSequence", event,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`)
        return yield* decode(ThreadEvent, rows[0])
      }),
    )
  })

  const readEvents: StoreService["readEvents"] = Effect.fn("PostgresStore.readEvents")(
    function* (input) {
      yield* requireActiveClient(sql, input)
      yield* requireThreadAccess(sql, input, roleRank.viewer)
      const rows = yield* query(sql`SELECT organization_id AS "organizationId", thread_id AS "threadId",
        event_id AS "eventId", idempotency_key AS "idempotencyKey",
        assignment_id AS "assignmentId", executor_instance_id AS "executorInstanceId",
        assignment_generation::text AS "assignmentGeneration", lease_epoch::text AS "leaseEpoch",
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

  const acknowledgeCursor: StoreService["acknowledgeCursor"] = Effect.fn(
    "PostgresStore.acknowledgeCursor",
  )(function* (input) {
    yield* requireActiveClient(sql, input)
    yield* requireThreadAccess(sql, input, roleRank.viewer)
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

  const acquireTerminalWriter = Effect.fn("PostgresStore.acquireTerminalWriter")(function* (
    input: AcquireTerminalWriterInput,
  ) {
    yield* requireActiveClient(sql, input)
    yield* requireThreadAccess(sql, input, roleRank.controller)
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

  const renewTerminalWriter = Effect.fn("PostgresStore.renewTerminalWriter")(function* (
    input: RenewTerminalWriterInput,
  ) {
    yield* requireActiveClient(sql, input)
    yield* requireThreadAccess(sql, input, roleRank.controller)
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

  const upsertPresence = Effect.fn("PostgresStore.upsertPresence")(function* (input: UpsertPresenceInput) {
    yield* requireActiveClient(sql, input)
    yield* requireThreadAccess(sql, input, roleRank.viewer)
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

  const listPresence: StoreService["listPresence"] = Effect.fn("PostgresStore.listPresence")(
    function* (input) {
      yield* requireActiveClient(sql, input)
      yield* requireThreadAccess(sql, input, roleRank.viewer)
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

  const bindLocalWorkspace = Effect.fn("PostgresStore.bindLocalWorkspace")(function* (
    input: BindLocalWorkspaceInput,
  ) {
    yield* requireMembership(sql, input)
    yield* requireThreadAccess(sql, input, roleRank.controller)
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

  const recordAuditEvent = Effect.fn("PostgresStore.recordAuditEvent")(function* (
    input: RecordAuditEventInput,
  ) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        yield* requireActiveClient(sql, {
          organizationId: input.organizationId,
          memberId: input.actorMemberId,
          clientId: input.actorClientId,
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

  const putCredentialReference = Effect.fn("PostgresStore.putCredentialReference")(function* (
    input: PutCredentialReferenceInput,
  ) {
    yield* requireMembership(sql, { organizationId: input.organizationId, memberId: input.createdByMemberId })
    if (input.projectId !== null)
      yield* requireProjectAccess(sql, {
        organizationId: input.organizationId,
        projectId: input.projectId,
        memberId: input.createdByMemberId,
      }, roleRank.operator)
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

  return HostedStore.of({
    createProject,
    putProjectGrant,
    createWorkspace,
    createThread,
    putThreadGrant,
    registerDevice,
    authenticateClient,
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
    recordAuditEvent,
    putCredentialReference,
  })
})

export const layer = Layer.effect(HostedStore, make)
