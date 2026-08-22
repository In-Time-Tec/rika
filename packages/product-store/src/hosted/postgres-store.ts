import * as PgClient from "@effect/sql-pg/PgClient"
import { Effect, Layer, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { PromptPart } from "@rika/product/execution-request"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import * as HostedObservability from "@rika/product/hosted-observability"
import {
  ActorAttribution,
  AuditEvent,
  AuthenticatedClient,
  AuthenticatedDevice,
  CommitCursor,
  CredentialReference,
  HostedThread,
  HostedOwnerRecord,
  HostedWorkspace,
  JsonObject,
  LocalWorkspaceBinding,
  ExecutorInstanceId,
  type OwnerId,
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
import { TurnId } from "@rika/product/turn-record"
import {
  HostedStore,
  StoreError,
  type AcquireTerminalWriterInput,
  type AdmitCommandInput,
  type AdmitPromptInput,
  type AppendEventInput,
  type AppendRecoveredEventInput,
  type AuthenticateClientInput,
  type BindLocalWorkspaceInput,
  type CreateProjectInput,
  type CreateThreadInput,
  type CreateWorkspaceInput,
  type StoreService,
  type PutCredentialReferenceInput,
  type PutOwnerInput,
  type PutProjectGrantInput,
  type PutThreadGrantInput,
  type RecordAuditEventInput,
  type RegisterDeviceInput,
  type RenewTerminalWriterInput,
  type UpsertPresenceInput,
} from "@rika/product/hosted-store"
import { requireActiveClient, requireThreadAccess } from "./postgres-authority"

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
const ExecutionRouteJson = Schema.fromJsonString(ExecutionRouteSnapshot)
const PromptPartsJson = Schema.fromJsonString(Schema.Array(PromptPart))
const commandEquivalent = Schema.toEquivalence(
  Schema.Struct({
    ownerId: ThreadCommand.fields.ownerId,
    threadId: ThreadCommand.fields.threadId,
    commandId: ThreadCommand.fields.commandId,
    idempotencyKey: ThreadCommand.fields.idempotencyKey,
    actor: ActorAttribution,
    command: JsonObject,
  }),
)
const eventEquivalent = Schema.toEquivalence(
  Schema.Struct({
    ownerId: ThreadEvent.fields.ownerId,
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
  ownerId: string,
) {
  const rows = yield* query(sql<{ readonly cursor: string }>`UPDATE rika_hosted_owner_counters
    SET next_commit_cursor = next_commit_cursor + 1
    WHERE owner_id = ${ownerId}
    RETURNING (next_commit_cursor - 1)::text AS cursor`)
  if (rows[0] === undefined) return yield* failure("invalid-authority", "Owner authority is not initialized")
  return CommitCursor.make(rows[0].cursor)
})

const requireOwnerCreator = Effect.fn("PostgresStore.requireOwnerCreator")(function* (
  sql: SqlClient,
  input: { readonly ownerId: string; readonly userId: string },
) {
  const rows = yield* query(sql`SELECT 1 FROM rika_hosted_owners owner_record
    LEFT JOIN "member" membership ON owner_record.kind = 'organization'
      AND membership.organization_id = owner_record.organization_id AND membership.user_id = ${input.userId}
    WHERE owner_record.id = ${input.ownerId}
      AND ((owner_record.kind = 'personal' AND owner_record.user_id = ${input.userId})
        OR (owner_record.kind = 'organization' AND membership.id IS NOT NULL))
    FOR KEY SHARE OF owner_record`)
  if (rows[0] === undefined) return yield* failure("invalid-authority", "Owner is unavailable to the user")
})

const requireOrganizationGrantAuthority = Effect.fn("PostgresStore.requireOrganizationGrantAuthority")(function* (
  sql: SqlClient,
  input: { readonly ownerId: string; readonly userId: string; readonly membershipId: string },
) {
  const rows = yield* query(sql`SELECT 1 FROM rika_hosted_owners owner_record
    JOIN "member" actor_membership ON actor_membership.organization_id = owner_record.organization_id
      AND actor_membership.user_id = ${input.userId}
    JOIN "member" target_membership ON target_membership.organization_id = owner_record.organization_id
      AND target_membership.id = ${input.membershipId}
    WHERE owner_record.id = ${input.ownerId} AND owner_record.kind = 'organization'
    FOR KEY SHARE OF owner_record`)
  if (rows[0] === undefined)
    return yield* failure("invalid-authority", "Grants require active organization memberships")
})

const make = Effect.gen(function* (): Effect.fn.Return<StoreService, never, PgClient.PgClient> {
  const sql = yield* PgClient.PgClient

  const putOwner = Effect.fn("PostgresStore.putOwner")(function* (input: PutOwnerInput) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const existing = yield* query(sql<{
          readonly id: string
          readonly kind: string
          readonly userId: string | null
          readonly organizationId: string | null
          readonly createdAt: string
        }>`SELECT id, kind, user_id AS "userId", organization_id AS "organizationId",
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
          FROM rika_hosted_owners
          WHERE id = ${input.id}
            OR user_id = ${input.identity._tag === "PersonalOwner" ? input.identity.userId : null}
            OR organization_id = ${input.identity._tag === "OrganizationOwner" ? input.identity.organizationId : null}
          FOR UPDATE`)
        const matching = existing.find((row) => row.id === input.id)
        if (existing.length > 0) {
          if (
            matching === undefined ||
            matching.kind !== (input.identity._tag === "PersonalOwner" ? "personal" : "organization") ||
            matching.userId !== (input.identity._tag === "PersonalOwner" ? input.identity.userId : null) ||
            matching.organizationId !==
              (input.identity._tag === "OrganizationOwner" ? input.identity.organizationId : null)
          ) {
            return yield* failure("conflict", "Owner identity cannot be reassigned")
          }
          const identity =
            matching.kind === "personal"
              ? { _tag: "PersonalOwner", userId: matching.userId }
              : { _tag: "OrganizationOwner", organizationId: matching.organizationId }
          return yield* decode(HostedOwnerRecord, { id: matching.id, identity, createdAt: matching.createdAt })
        }
        const rows = yield* query(sql`INSERT INTO rika_hosted_owners (id, kind, user_id, organization_id, created_at)
        VALUES (${input.id}, ${input.identity._tag === "PersonalOwner" ? "personal" : "organization"},
          ${input.identity._tag === "PersonalOwner" ? input.identity.userId : null},
          ${input.identity._tag === "OrganizationOwner" ? input.identity.organizationId : null}, ${input.now})
        ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
        WHERE rika_hosted_owners.kind = EXCLUDED.kind
          AND rika_hosted_owners.user_id IS NOT DISTINCT FROM EXCLUDED.user_id
          AND rika_hosted_owners.organization_id IS NOT DISTINCT FROM EXCLUDED.organization_id
        RETURNING id, kind, user_id AS "userId", organization_id AS "organizationId",
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`)
        if (rows[0] === undefined) return yield* failure("conflict", "Owner identity cannot be reassigned")
        yield* query(sql`INSERT INTO rika_hosted_owner_counters (owner_id) VALUES (${input.id}) ON CONFLICT DO NOTHING`)
        const row = rows[0] as {
          id: string
          kind: string
          userId: string | null
          organizationId: string | null
          createdAt: string
        }
        const identity =
          row.kind === "personal"
            ? { _tag: "PersonalOwner", userId: row.userId }
            : { _tag: "OrganizationOwner", organizationId: row.organizationId }
        return yield* decode(HostedOwnerRecord, { id: row.id, identity, createdAt: row.createdAt })
      }).pipe(Effect.catchTag("HostedStoreError", Effect.fail)),
    )
  })

  const createProject = Effect.fn("PostgresStore.createProject")(function* (input: CreateProjectInput) {
    yield* requireOwnerCreator(sql, { ownerId: input.ownerId, userId: input.createdByUserId })
    const rows = yield* query(sql`INSERT INTO rika_hosted_projects
      (id, owner_id, name, created_by_user_id, created_at, updated_at)
      VALUES (${input.id}, ${input.ownerId}, ${input.name}, ${input.createdByUserId}, ${input.now}, ${input.now})
      RETURNING id, owner_id AS "ownerId", name, created_by_user_id AS "createdByUserId",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`)
    return yield* decode(Project, rows[0])
  })

  const putProjectGrant = Effect.fn("PostgresStore.putProjectGrant")(function* (input: PutProjectGrantInput) {
    yield* requireOrganizationGrantAuthority(sql, {
      ownerId: input.ownerId,
      userId: input.grantedByUserId,
      membershipId: input.membershipId,
    })
    const rows = yield* query(sql`INSERT INTO rika_hosted_project_grants
      (owner_id, project_id, membership_id, role, granted_by_user_id, created_at, updated_at)
      SELECT ${input.ownerId}, project.id, ${input.membershipId}, ${input.role}, ${input.grantedByUserId}, ${input.now}, ${input.now}
      FROM rika_hosted_projects project WHERE project.id = ${input.projectId} AND project.owner_id = ${input.ownerId}
      ON CONFLICT (project_id, membership_id) DO UPDATE SET role = EXCLUDED.role,
        granted_by_user_id = EXCLUDED.granted_by_user_id, updated_at = EXCLUDED.updated_at
      WHERE rika_hosted_project_grants.owner_id = EXCLUDED.owner_id
      RETURNING owner_id AS "ownerId", project_id AS "projectId", membership_id AS "membershipId", role,
        granted_by_user_id AS "grantedByUserId",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`)
    if (rows[0] === undefined) return yield* failure("not-found", "Project does not exist for the owner")
    return yield* decode(ProjectGrant, rows[0])
  })

  const createWorkspace = Effect.fn("PostgresStore.createWorkspace")(function* (input: CreateWorkspaceInput) {
    if (input.executorKind === "local_device" && input.inheritProjectGrants === true)
      return yield* failure("invalid-authority", "Local workspaces cannot inherit project grants")
    yield* requireOwnerCreator(sql, { ownerId: input.ownerId, userId: input.createdByUserId })
    if (input.projectId !== undefined) {
      const project = yield* query(
        sql`SELECT 1 FROM rika_hosted_projects WHERE id = ${input.projectId} AND owner_id = ${input.ownerId}`,
      )
      if (project[0] === undefined) return yield* failure("not-found", "Project does not exist for the owner")
    }
    const inherit = input.executorKind === "e2b" ? (input.inheritProjectGrants ?? true) : false
    const rows = yield* query(sql`INSERT INTO rika_hosted_workspaces
      (id, owner_id, project_id, created_by_user_id, executor_kind, inherit_project_grants, created_at)
      VALUES (${input.id}, ${input.ownerId}, ${input.projectId ?? null}, ${input.createdByUserId}, ${input.executorKind}, ${inherit}, ${input.now})
      RETURNING id, owner_id AS "ownerId", project_id AS "projectId", created_by_user_id AS "createdByUserId",
        executor_kind AS "executorKind", inherit_project_grants AS "inheritProjectGrants",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`)
    const row = rows[0] as Record<string, unknown>
    if (row.projectId === null) delete row.projectId
    return yield* decode(HostedWorkspace, row)
  })

  const createThread = Effect.fn("PostgresStore.createThread")(function* (input: CreateThreadInput) {
    if (input.executorKind === "local_device" && input.inheritProjectGrants === true)
      return yield* failure("invalid-authority", "Local threads cannot inherit project grants")
    yield* requireOwnerCreator(sql, { ownerId: input.ownerId, userId: input.createdByUserId })
    const rows = yield* query(sql`INSERT INTO rika_hosted_threads
      (id, owner_id, project_id, workspace_id, created_by_user_id, executor_kind, inherit_project_grants, created_at)
      SELECT ${input.id}, ${input.ownerId}, ${input.projectId ?? null}, workspace.id, ${input.createdByUserId}, ${input.executorKind},
        CASE WHEN ${input.executorKind} = 'e2b' THEN COALESCE(${input.inheritProjectGrants ?? null}, workspace.inherit_project_grants) ELSE false END, ${input.now}
      FROM rika_hosted_workspaces workspace WHERE workspace.id = ${input.workspaceId} AND workspace.owner_id = ${input.ownerId}
        AND workspace.project_id IS NOT DISTINCT FROM ${input.projectId ?? null} AND workspace.executor_kind = ${input.executorKind}
      RETURNING id, owner_id AS "ownerId", project_id AS "projectId", workspace_id AS "workspaceId",
        created_by_user_id AS "createdByUserId", executor_kind AS "executorKind", inherit_project_grants AS "inheritProjectGrants",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`)
    if (rows[0] === undefined) return yield* failure("not-found", "Workspace does not belong to the owner and project")
    const row = rows[0] as Record<string, unknown>
    if (row.projectId === null) delete row.projectId
    return yield* decode(HostedThread, row)
  })

  const putThreadGrant = Effect.fn("PostgresStore.putThreadGrant")(function* (input: PutThreadGrantInput) {
    yield* requireOrganizationGrantAuthority(sql, {
      ownerId: input.ownerId,
      userId: input.grantedByUserId,
      membershipId: input.membershipId,
    })
    const rows = yield* query(sql`INSERT INTO rika_hosted_thread_grants
      (owner_id, thread_id, membership_id, role, granted_by_user_id, created_at, updated_at)
      SELECT ${input.ownerId}, thread.id, ${input.membershipId}, ${input.role}, ${input.grantedByUserId}, ${input.now}, ${input.now}
      FROM rika_hosted_threads thread WHERE thread.id = ${input.threadId} AND thread.owner_id = ${input.ownerId}
      ON CONFLICT (thread_id, membership_id) DO UPDATE SET role = EXCLUDED.role,
        granted_by_user_id = EXCLUDED.granted_by_user_id, updated_at = EXCLUDED.updated_at
      WHERE rika_hosted_thread_grants.owner_id = EXCLUDED.owner_id
      RETURNING owner_id AS "ownerId", thread_id AS "threadId", membership_id AS "membershipId", role,
        granted_by_user_id AS "grantedByUserId",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`)
    if (rows[0] === undefined) return yield* failure("not-found", "Thread does not exist for the owner")
    return yield* decode(ThreadGrant, rows[0])
  })

  const registerDevice = Effect.fn("PostgresStore.registerDevice")(function* (input: RegisterDeviceInput) {
    const rows = yield* query(sql`INSERT INTO rika_hosted_devices
      (id, user_id, display_name, public_key_fingerprint, created_at, last_seen_at)
      VALUES (${input.id}, ${input.userId}, ${input.displayName}, ${input.publicKeyFingerprint}, ${input.now}, ${input.now})
      ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name,
        public_key_fingerprint = EXCLUDED.public_key_fingerprint, last_seen_at = EXCLUDED.last_seen_at
      WHERE rika_hosted_devices.user_id = EXCLUDED.user_id AND rika_hosted_devices.revoked_at IS NULL
      RETURNING id, user_id AS "userId", display_name AS "displayName", public_key_fingerprint AS "publicKeyFingerprint",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
        to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenAt", NULL AS "revokedAt"`)
    if (rows[0] === undefined) return yield* failure("invalid-authority", "Device identity cannot be reassigned")
    return yield* decode(AuthenticatedDevice, rows[0])
  })

  const authenticateClient = Effect.fn("PostgresStore.authenticateClient")(function* (input: AuthenticateClientInput) {
    const rows = yield* query(sql`INSERT INTO rika_hosted_clients
          (id, user_id, device_id, authenticated_at, last_seen_at, expires_at)
          SELECT ${input.id}, ${input.userId}, device.id, ${input.now}, ${input.now}, ${input.expiresAt}
          FROM rika_hosted_devices device
          WHERE device.id = ${input.deviceId} AND device.user_id = ${input.userId}
            AND device.revoked_at IS NULL
            AND ${input.expiresAt}::timestamptz > ${input.now}::timestamptz
            AND ${input.expiresAt}::timestamptz <= ${input.now}::timestamptz + interval '5 minutes'
          ON CONFLICT (id) DO UPDATE SET authenticated_at = EXCLUDED.authenticated_at,
            last_seen_at = EXCLUDED.last_seen_at, expires_at = EXCLUDED.expires_at
          WHERE rika_hosted_clients.user_id = EXCLUDED.user_id
            AND rika_hosted_clients.device_id = EXCLUDED.device_id
            AND rika_hosted_clients.revoked_at IS NULL
          RETURNING id, user_id AS "userId", device_id AS "deviceId",
            to_char(authenticated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "authenticatedAt",
            to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenAt",
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt", NULL AS "revokedAt"`)
    if (rows[0] === undefined)
      return yield* failure("invalid-authority", "Client device is inactive, foreign, or exceeds five minutes")
    return yield* decode(AuthenticatedClient, rows[0])
  })

  const validateClient: StoreService["validateClient"] = Effect.fn("PostgresStore.validateClient")(function* (input) {
    const rows = yield* query(sql`SELECT 1
      FROM rika_hosted_clients client_record
      JOIN rika_hosted_devices device
        ON device.id = client_record.device_id AND device.user_id = client_record.user_id
      WHERE client_record.id = ${input.clientId} AND client_record.user_id = ${input.userId}
        AND client_record.device_id = ${input.deviceId}
        AND client_record.revoked_at IS NULL AND device.revoked_at IS NULL
        AND client_record.expires_at > ${input.at}::timestamptz
      FOR KEY SHARE OF client_record, device`)
    if (rows[0] === undefined) return yield* failure("invalid-authority", "Client authority is inactive or foreign")
  })

  const grantClientAuthority: StoreService["grantClientAuthority"] = Effect.fn("PostgresStore.grantClientAuthority")(
    function* (input) {
      const authority = yield* query(sql`INSERT INTO rika_hosted_client_authorities
          (client_id, owner_id, issued_at, expires_at)
          SELECT client_record.id, owner_record.id, ${input.now},
            LEAST(${input.expiresAt}::timestamptz, client_record.expires_at)
          FROM rika_hosted_owners owner_record
          JOIN rika_hosted_clients client_record ON client_record.id = ${input.actor.clientId}
            AND client_record.user_id = ${input.actor.userId}
            AND client_record.device_id = ${input.actor.deviceId}
            AND client_record.revoked_at IS NULL
            AND client_record.expires_at > ${input.now}::timestamptz
          JOIN rika_hosted_devices device ON device.id = client_record.device_id
            AND device.user_id = client_record.user_id AND device.revoked_at IS NULL
          LEFT JOIN "member" membership ON owner_record.kind = 'organization'
            AND membership.organization_id = owner_record.organization_id
            AND membership.id = ${input.actor._tag === "OrganizationActor" ? input.actor.membershipId : null}
            AND membership.user_id = client_record.user_id
          WHERE owner_record.id = ${input.ownerId}
            AND ${input.expiresAt}::timestamptz > ${input.now}::timestamptz
            AND ${input.expiresAt}::timestamptz <= ${input.now}::timestamptz + interval '5 minutes'
            AND ((owner_record.kind = 'personal'
                AND ${input.actor._tag} = 'PersonalActor'
                AND owner_record.user_id = client_record.user_id)
              OR (owner_record.kind = 'organization'
                AND ${input.actor._tag} = 'OrganizationActor'
                AND membership.id IS NOT NULL))
          ON CONFLICT (client_id, owner_id) DO UPDATE SET
            issued_at = EXCLUDED.issued_at,
            expires_at = EXCLUDED.expires_at,
            revoked_at = NULL
          RETURNING client_id`)
      if (authority[0] === undefined)
        return yield* failure("invalid-authority", "Client owner authority is inactive or foreign")
    },
  )

  const authorizeThread: StoreService["authorizeThread"] = Effect.fn("PostgresStore.authorizeThread")((input) =>
    transaction(sql, requireThreadAccess(sql, input, input.action, input.at)),
  )

  const admitCommand = Effect.fn("PostgresStore.admitCommand")(function* (input: AdmitCommandInput) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const locked = yield* query(sql`SELECT id FROM rika_hosted_threads
          WHERE id = ${input.threadId} AND owner_id = ${input.ownerId} FOR UPDATE`)
        if (locked[0] === undefined) return yield* failure("not-found", "Thread does not exist for the owner")
        yield* requireThreadAccess(sql, input, "thread:control", input.admittedAt)
        const existingRows =
          yield* query(sql`SELECT owner_id AS "ownerId", thread_id AS "threadId", command_id AS "commandId",
          idempotency_key AS "idempotencyKey", actor, sequence::text AS sequence,
          commit_cursor::text AS "commitCursor", command,
          to_char(admitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "admittedAt"
          FROM rika_hosted_thread_commands
          WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}
            AND (command_id = ${input.commandId} OR idempotency_key = ${input.idempotencyKey})`)
        if (existingRows.length > 1)
          return yield* failure("conflict", "Command identity or idempotency key collides with multiple commands")
        if (existingRows[0] !== undefined) {
          const existing = yield* decode(ThreadCommand, existingRows[0])
          if (!commandEquivalent(existing, input)) {
            return yield* failure("conflict", "Command identity or idempotency key was reused with different content")
          }
          return existing
        }
        if (input.command._tag === "TerminalInput") {
          const writer = yield* query(sql`SELECT 1 FROM rika_hosted_terminal_writer_leases
            WHERE owner_id = ${input.ownerId}
              AND thread_id = ${input.threadId}
              AND actor = ${sql.json(input.actor)}
              AND lease_id = ${input.command.writerLeaseId}
              AND generation = ${input.command.writerGeneration}::bigint
              AND expires_at > ${input.admittedAt}::timestamptz`)
          if (writer[0] === undefined)
            return yield* failure("stale-fence", "Terminal writer lease is expired or fenced")
        }
        const sequences = yield* query(sql<{ readonly sequence: string }>`UPDATE rika_hosted_threads
          SET next_command_sequence = next_command_sequence + 1
          WHERE id = ${input.threadId} AND owner_id = ${input.ownerId}
          RETURNING (next_command_sequence - 1)::text AS sequence`)
        const sequence = Sequence.make(sequences[0]!.sequence)
        const commitCursor = yield* allocateCommitCursor(sql, input.ownerId)
        const rows = yield* query(sql`INSERT INTO rika_hosted_thread_commands
          (owner_id, thread_id, command_id, idempotency_key, actor, sequence, commit_cursor, command, admitted_at)
          VALUES (${input.ownerId}, ${input.threadId}, ${input.commandId}, ${input.idempotencyKey}, ${sql.json(input.actor)}, ${sequence}::bigint,
            ${commitCursor}::bigint, ${sql.json(input.command)}, ${input.admittedAt})
          RETURNING owner_id AS "ownerId", thread_id AS "threadId", command_id AS "commandId", idempotency_key AS "idempotencyKey",
            actor, sequence::text AS sequence, commit_cursor::text AS "commitCursor", command,
            to_char(admitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "admittedAt"`)
        return yield* decode(ThreadCommand, rows[0])
      }),
    )
  })

  const admitPrompt = Effect.fn("PostgresStore.admitPrompt")(function* (input: AdmitPromptInput) {
    if (input.prompt.length === 0) return yield* failure("conflict", "Prompt cannot be empty")
    const queueCapacity = Math.trunc(input.queueCapacity)
    if (queueCapacity < 1) return yield* failure("conflict", "Prompt queue capacity must be positive")
    const admittedAtMillis = Date.parse(input.admittedAt)
    if (!Number.isFinite(admittedAtMillis)) return yield* failure("conflict", "Prompt admission timestamp is invalid")
    const executionRoute = yield* Schema.encodeEffect(ExecutionRouteJson)(input.executionRoute).pipe(
      Effect.mapError(databaseError),
    )
    const promptParts =
      input.promptParts === undefined
        ? undefined
        : yield* Schema.encodeEffect(PromptPartsJson)(input.promptParts).pipe(Effect.mapError(databaseError))
    const commandInput: AdmitCommandInput = {
      ownerId: input.ownerId,
      threadId: input.threadId,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      command: {
        _tag: "SubmitPrompt",
        prompt: input.prompt,
        ...(input.promptParts === undefined ? {} : { promptParts: input.promptParts }),
        mode: input.executionRoute.mode,
      },
      admittedAt: input.admittedAt,
    }
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const locked = yield* query(sql`SELECT id FROM rika_hosted_threads
          WHERE id = ${input.threadId} AND owner_id = ${input.ownerId} FOR UPDATE`)
        if (locked[0] === undefined) return yield* failure("not-found", "Thread does not exist for the owner")
        yield* requireThreadAccess(sql, input, "thread:control", input.admittedAt)
        const existingRows = yield* query(sql`SELECT owner_id AS "ownerId", thread_id AS "threadId",
          command_id AS "commandId", idempotency_key AS "idempotencyKey", turn_id AS "turnId",
          actor, sequence::text AS sequence, commit_cursor::text AS "commitCursor", command,
          to_char(admitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "admittedAt"
          FROM rika_hosted_thread_commands
          WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}
            AND (command_id = ${input.commandId} OR idempotency_key = ${input.idempotencyKey})`)
        if (existingRows.length > 1)
          return yield* failure("conflict", "Command identity or idempotency key collides with multiple commands")
        if (existingRows[0] !== undefined) {
          const existing = yield* decode(ThreadCommand, existingRows[0])
          if (!commandEquivalent(existing, commandInput))
            return yield* failure("conflict", "Command identity or idempotency key was reused with different content")
          const turnId = (existingRows[0] as { readonly turnId?: unknown }).turnId
          if (typeof turnId !== "string")
            return yield* failure("conflict", "Command identity was admitted without a queued Turn")
          return { command: existing, turnId: TurnId.make(turnId) }
        }
        const productThread = yield* query(sql`SELECT 1 FROM rika_threads
          WHERE id = ${input.threadId} AND owner_id = ${input.ownerId} FOR KEY SHARE`)
        if (productThread[0] === undefined)
          return yield* failure("invalid-authority", "Thread has no product state for the owner")
        const collidingTurn = yield* query(sql`SELECT 1 FROM rika_turns WHERE id = ${input.turnId}`)
        if (collidingTurn[0] !== undefined) return yield* failure("conflict", "Turn identity is already in use")
        yield* query(sql`INSERT INTO rika_turns
          (id, thread_id, turn_kind, prompt, prompt_parts_json, execution_route_json, author_json, lineage_json,
            status, created_at, updated_at)
          VALUES (${input.turnId}, ${input.threadId}, 'AgentExecution', ${input.prompt}, ${promptParts}, ${executionRoute},
            '{"_tag":"Human"}', '{"_tag":"Original"}', 'queued', ${admittedAtMillis}, ${admittedAtMillis})`)
        yield* query(sql`INSERT INTO rika_thread_queue_state (thread_id)
          VALUES (${input.threadId}) ON CONFLICT (thread_id) DO NOTHING`)
        const queueRows = yield* query(sql`UPDATE rika_thread_queue_state
          SET revision = revision + 1, queued_count = queued_count + 1
          WHERE thread_id = ${input.threadId} AND queued_count < ${queueCapacity}
          RETURNING queued_count`)
        if (queueRows[0] === undefined) return yield* failure("conflict", "Thread prompt queue is full")
        const sequences = yield* query(sql<{ readonly sequence: string }>`UPDATE rika_hosted_threads
          SET next_command_sequence = next_command_sequence + 1
          WHERE id = ${input.threadId} AND owner_id = ${input.ownerId}
          RETURNING (next_command_sequence - 1)::text AS sequence`)
        const sequence = Sequence.make(sequences[0]!.sequence)
        const commitCursor = yield* allocateCommitCursor(sql, input.ownerId)
        const rows = yield* query(sql`INSERT INTO rika_hosted_thread_commands
          (owner_id, thread_id, command_id, idempotency_key, turn_id, actor, sequence, commit_cursor, command, admitted_at)
          VALUES (${input.ownerId}, ${input.threadId}, ${input.commandId}, ${input.idempotencyKey}, ${input.turnId},
            ${sql.json(input.actor)}, ${sequence}::bigint, ${commitCursor}::bigint,
            ${sql.json(commandInput.command)}, ${input.admittedAt})
          RETURNING owner_id AS "ownerId", thread_id AS "threadId", command_id AS "commandId",
            idempotency_key AS "idempotencyKey", actor, sequence::text AS sequence,
            commit_cursor::text AS "commitCursor", command,
            to_char(admitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "admittedAt"`)
        return { command: yield* decode(ThreadCommand, rows[0]), turnId: input.turnId }
      }),
    ).pipe((effect) =>
      HostedObservability.observe(
        "queue_admission",
        { ownerId: input.ownerId, threadId: input.threadId, turnId: input.turnId, commandId: input.commandId },
        effect,
      ),
    )
  })

  const readCommands: StoreService["readCommands"] = Effect.fn("PostgresStore.readCommands")(function* (input) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        yield* requireThreadAccess(sql, input, "thread:view")
        const rows = yield* query(sql`SELECT owner_id AS "ownerId", thread_id AS "threadId",
          command_id AS "commandId", idempotency_key AS "idempotencyKey", actor, sequence::text AS sequence,
          commit_cursor::text AS "commitCursor", command,
          to_char(admitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "admittedAt"
          FROM rika_hosted_thread_commands
          WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}
            AND commit_cursor > ${input.afterCommitCursor}::bigint
          ORDER BY commit_cursor ASC LIMIT ${limit(input.limit)}`)
        return yield* Effect.forEach(rows, (row) => decode(ThreadCommand, row))
      }),
    )
  })

  const appendEvent = Effect.fn("PostgresStore.appendEvent")(function* (input: AppendEventInput) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const assignments = yield* query(sql<{
          readonly ownerId: OwnerId
          readonly threadId: ThreadId
          readonly executorInstanceId: ExecutorInstanceId
        }>`SELECT owner_id AS "ownerId", thread_id AS "threadId",
            executor_instance_id AS "executorInstanceId"
          FROM rika_hosted_executor_assignments
          WHERE id = ${input.assignmentId}
            AND generation = ${input.assignmentGeneration}::bigint
            AND lease_epoch = ${input.leaseEpoch}::bigint
            AND lifecycle = 'active'
            AND lease_expires_at > transaction_timestamp()
          FOR SHARE`)
        const assignment = assignments[0]
        if (assignment === undefined) return yield* failure("stale-fence", "Executor assignment is expired or fenced")
        const locked = yield* query(sql`SELECT id FROM rika_hosted_threads
          WHERE id = ${assignment.threadId} AND owner_id = ${assignment.ownerId} FOR UPDATE`)
        if (locked[0] === undefined) return yield* failure("not-found", "Thread does not exist in the organization")
        const existingRows = yield* query(sql`SELECT owner_id AS "ownerId", thread_id AS "threadId",
          event_id AS "eventId", idempotency_key AS "idempotencyKey",
          assignment_id AS "assignmentId", executor_instance_id AS "executorInstanceId",
          assignment_generation::text AS "assignmentGeneration", lease_epoch::text AS "leaseEpoch",
          sequence::text AS sequence, commit_cursor::text AS "commitCursor",
          command_sequence::text AS "commandSequence", event,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
          FROM rika_hosted_thread_events
          WHERE thread_id = ${assignment.threadId}
            AND (event_id = ${input.eventId} OR idempotency_key = ${input.idempotencyKey})`)
        if (existingRows.length > 1)
          return yield* failure("conflict", "Event identity or idempotency key collides with multiple events")
        const comparable = {
          ...input,
          ownerId: assignment.ownerId,
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
          WHERE id = ${assignment.threadId} AND owner_id = ${assignment.ownerId}
          RETURNING (next_event_sequence - 1)::text AS sequence`)
        const sequence = Sequence.make(sequences[0]!.sequence)
        const commitCursor = yield* allocateCommitCursor(sql, assignment.ownerId)
        const rows = yield* query(sql`INSERT INTO rika_hosted_thread_events
          (owner_id, thread_id, event_id, idempotency_key, assignment_id, executor_instance_id,
            assignment_generation, lease_epoch, sequence, commit_cursor, command_sequence, event)
          VALUES (${assignment.ownerId}, ${assignment.threadId}, ${input.eventId}, ${input.idempotencyKey},
            ${input.assignmentId}, ${assignment.executorInstanceId}, ${input.assignmentGeneration}::bigint,
            ${input.leaseEpoch}::bigint, ${sequence}::bigint, ${commitCursor}::bigint,
            ${input.commandSequence === null ? null : input.commandSequence}::bigint, ${sql.json(input.event)})
          RETURNING owner_id AS "ownerId", thread_id AS "threadId", event_id AS "eventId",
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

  const appendRecoveredEvent = Effect.fn("PostgresStore.appendRecoveredEvent")(function* (
    input: AppendRecoveredEventInput,
  ) {
    if (String(input.eventId) !== String(input.idempotencyKey))
      return yield* failure("conflict", "Recovered event identity must equal its operation key")
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const assignments = yield* query(sql<{
          readonly ownerId: OwnerId
          readonly threadId: ThreadId
        }>`SELECT owner_id AS "ownerId", thread_id AS "threadId"
          FROM rika_hosted_executor_assignments
          WHERE id = ${input.assignmentId}
          FOR SHARE`)
        const assignment = assignments[0]
        if (assignment === undefined) return yield* failure("not-found", "Executor assignment does not exist")
        const operations = yield* query(sql`SELECT operation.operation_key AS "operationKey"
          FROM rika_hosted_executor_operations operation
          WHERE operation.assignment_id = ${input.assignmentId}
            AND operation.operation_key = ${input.idempotencyKey}
            AND operation.state = 'unknown'
            AND operation.dispatched_generation = ${input.assignmentGeneration}::bigint
            AND operation.dispatched_lease_epoch = ${input.leaseEpoch}::bigint
            AND operation.dispatched_executor_instance_id = ${input.executorInstanceId}
            AND operation.dispatched_process_incarnation = ${input.processIncarnation}
          FOR UPDATE`)
        if (operations[0] === undefined)
          return yield* failure("stale-fence", "Recovered event does not match the dispatched operation fence")
        const locked = yield* query(sql`SELECT id FROM rika_hosted_threads
          WHERE id = ${assignment.threadId} AND owner_id = ${assignment.ownerId} FOR UPDATE`)
        if (locked[0] === undefined) return yield* failure("not-found", "Thread does not exist in the organization")
        const existingRows = yield* query(sql`SELECT owner_id AS "ownerId", thread_id AS "threadId",
          event_id AS "eventId", idempotency_key AS "idempotencyKey",
          assignment_id AS "assignmentId", executor_instance_id AS "executorInstanceId",
          assignment_generation::text AS "assignmentGeneration", lease_epoch::text AS "leaseEpoch",
          sequence::text AS sequence, commit_cursor::text AS "commitCursor",
          command_sequence::text AS "commandSequence", event,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
          FROM rika_hosted_thread_events
          WHERE thread_id = ${assignment.threadId}
            AND (event_id = ${input.eventId} OR idempotency_key = ${input.idempotencyKey})`)
        if (existingRows.length > 1)
          return yield* failure("conflict", "Recovered event identity collides with multiple events")
        const comparable = {
          ...input,
          ownerId: assignment.ownerId,
          threadId: assignment.threadId,
          executorInstanceId: ExecutorInstanceId.make(input.executorInstanceId),
        }
        const existingRow = existingRows[0]
        if (existingRow !== undefined) {
          const existing = yield* decode(ThreadEvent, existingRow)
          if (!eventEquivalent(existing, comparable))
            return yield* failure("conflict", "Event identity or idempotency key was reused with different content")
          return existing
        }
        const sequences = yield* query(sql<{ readonly sequence: string }>`UPDATE rika_hosted_threads
          SET next_event_sequence = next_event_sequence + 1
          WHERE id = ${assignment.threadId} AND owner_id = ${assignment.ownerId}
          RETURNING (next_event_sequence - 1)::text AS sequence`)
        const sequence = Sequence.make(sequences[0]!.sequence)
        const commitCursor = yield* allocateCommitCursor(sql, assignment.ownerId)
        const rows = yield* query(sql`INSERT INTO rika_hosted_thread_events
          (owner_id, thread_id, event_id, idempotency_key, assignment_id, executor_instance_id,
            assignment_generation, lease_epoch, sequence, commit_cursor, command_sequence, event)
          VALUES (${assignment.ownerId}, ${assignment.threadId}, ${input.eventId}, ${input.idempotencyKey},
            ${input.assignmentId}, ${input.executorInstanceId}, ${input.assignmentGeneration}::bigint,
            ${input.leaseEpoch}::bigint, ${sequence}::bigint, ${commitCursor}::bigint,
            ${input.commandSequence === null ? null : input.commandSequence}::bigint, ${sql.json(input.event)})
          RETURNING owner_id AS "ownerId", thread_id AS "threadId", event_id AS "eventId",
            idempotency_key AS "idempotencyKey", assignment_id AS "assignmentId",
            executor_instance_id AS "executorInstanceId", assignment_generation::text AS "assignmentGeneration",
            lease_epoch::text AS "leaseEpoch", sequence::text AS sequence,
            commit_cursor::text AS "commitCursor", command_sequence::text AS "commandSequence", event,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`)
        return yield* decode(ThreadEvent, rows[0])
      }),
    )
  })

  const readEvents: StoreService["readEvents"] = Effect.fn("PostgresStore.readEvents")(function* (input) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        yield* requireThreadAccess(sql, input, "thread:view")
        const rows = yield* query(sql`SELECT owner_id AS "ownerId", thread_id AS "threadId",
            event_id AS "eventId", idempotency_key AS "idempotencyKey",
            assignment_id AS "assignmentId", executor_instance_id AS "executorInstanceId",
            assignment_generation::text AS "assignmentGeneration", lease_epoch::text AS "leaseEpoch",
            sequence::text AS sequence, commit_cursor::text AS "commitCursor",
            command_sequence::text AS "commandSequence", event,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
            FROM rika_hosted_thread_events
            WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}
              AND commit_cursor > ${input.afterCommitCursor}::bigint
            ORDER BY commit_cursor ASC LIMIT ${limit(input.limit)}`)
        return yield* Effect.forEach(rows, (row) => decode(ThreadEvent, row))
      }),
    )
  })

  const acknowledgeCursor: StoreService["acknowledgeCursor"] = Effect.fn("PostgresStore.acknowledgeCursor")(
    function* (input) {
      return yield* transaction(
        sql,
        Effect.gen(function* () {
          yield* requireThreadAccess(sql, input, "thread:view", input.now)
          const events = yield* query(sql`SELECT 1 FROM rika_hosted_thread_events
            WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}
              AND commit_cursor = ${input.commitCursor}::bigint`)
          if (events[0] === undefined)
            return yield* failure("conflict", "Cursor must reference a persisted thread event")
          const rows = yield* query(sql`INSERT INTO rika_hosted_client_cursors
            (owner_id, thread_id, actor, commit_cursor, updated_at)
            VALUES (${input.ownerId}, ${input.threadId}, ${sql.json(input.actor)},
              ${input.commitCursor}::bigint, ${input.now})
            ON CONFLICT (thread_id, actor) DO UPDATE SET
              commit_cursor = GREATEST(rika_hosted_client_cursors.commit_cursor, EXCLUDED.commit_cursor),
              updated_at = EXCLUDED.updated_at
            RETURNING owner_id AS "ownerId", thread_id AS "threadId", actor,
              commit_cursor::text AS "commitCursor",
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`)
          return yield* decode(ResumableCursor, rows[0])
        }),
      )
    },
  )

  const acquireTerminalWriter = Effect.fn("PostgresStore.acquireTerminalWriter")(function* (
    input: AcquireTerminalWriterInput,
  ) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        yield* requireThreadAccess(sql, input, "terminal:input", input.now)
        const rows = yield* query(sql`INSERT INTO rika_hosted_terminal_writer_leases
          (owner_id, thread_id, actor, lease_id, generation, acquired_at, renewed_at, expires_at)
          VALUES (${input.ownerId}, ${input.threadId}, ${sql.json(input.actor)}, ${input.leaseId}, 1,
            ${input.now}, ${input.now}, ${input.expiresAt})
          ON CONFLICT (thread_id) DO UPDATE SET
            owner_id = EXCLUDED.owner_id,
            actor = EXCLUDED.actor,
            lease_id = EXCLUDED.lease_id,
            generation = rika_hosted_terminal_writer_leases.generation + 1,
            acquired_at = EXCLUDED.acquired_at,
            renewed_at = EXCLUDED.renewed_at,
            expires_at = EXCLUDED.expires_at
          WHERE rika_hosted_terminal_writer_leases.owner_id = EXCLUDED.owner_id
            AND rika_hosted_terminal_writer_leases.expires_at <= ${input.now}::timestamptz
          RETURNING owner_id AS "ownerId", thread_id AS "threadId", actor,
            lease_id AS "leaseId", generation::text AS generation,
            to_char(acquired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "acquiredAt",
            to_char(renewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "renewedAt",
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"`)
        if (rows[0] === undefined)
          return yield* failure("lease-unavailable", "Thread already has an active terminal writer")
        return yield* decode(TerminalWriterLease, rows[0])
      }),
    )
  })

  const renewTerminalWriter = Effect.fn("PostgresStore.renewTerminalWriter")(function* (
    input: RenewTerminalWriterInput,
  ) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        yield* requireThreadAccess(sql, input, "terminal:input", input.now)
        const rows = yield* query(sql`UPDATE rika_hosted_terminal_writer_leases SET
          renewed_at = ${input.now}, expires_at = ${input.expiresAt}
          WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}
            AND actor = ${sql.json(input.actor)}
            AND lease_id = ${input.leaseId}
            AND generation = ${input.generation}::bigint
            AND expires_at > ${input.now}::timestamptz
          RETURNING owner_id AS "ownerId", thread_id AS "threadId", actor,
            lease_id AS "leaseId", generation::text AS generation,
            to_char(acquired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "acquiredAt",
            to_char(renewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "renewedAt",
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"`)
        if (rows[0] === undefined) return yield* failure("stale-fence", "Terminal writer lease is expired or fenced")
        return yield* decode(TerminalWriterLease, rows[0])
      }),
    )
  })

  const upsertPresence = Effect.fn("PostgresStore.upsertPresence")(function* (input: UpsertPresenceInput) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        yield* requireThreadAccess(sql, input, "presence:update", input.now)
        const rows = yield* query(sql`INSERT INTO rika_hosted_presence
          (owner_id, thread_id, actor, status, last_seen_at, expires_at)
          VALUES (${input.ownerId}, ${input.threadId}, ${sql.json(input.actor)},
            ${input.status}, ${input.now}, ${input.expiresAt})
          ON CONFLICT (thread_id, actor) DO UPDATE SET
            status = EXCLUDED.status,
            last_seen_at = EXCLUDED.last_seen_at,
            expires_at = EXCLUDED.expires_at
          RETURNING owner_id AS "ownerId", thread_id AS "threadId", actor, status,
            to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenAt",
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"`)
        return yield* decode(Presence, rows[0])
      }),
    )
  })

  const listPresence: StoreService["listPresence"] = Effect.fn("PostgresStore.listPresence")(function* (input) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        yield* requireThreadAccess(sql, input, "presence:view", input.now)
        const rows = yield* query(sql`SELECT owner_id AS "ownerId", thread_id AS "threadId", actor, status,
          to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenAt",
          to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"
          FROM rika_hosted_presence
          WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}
            AND expires_at > ${input.now}::timestamptz
          ORDER BY actor`)
        return yield* Effect.forEach(rows, (row) => decode(Presence, row))
      }),
    )
  })

  const bindLocalWorkspace = Effect.fn("PostgresStore.bindLocalWorkspace")(function* (input: BindLocalWorkspaceInput) {
    const authority = yield* query(sql`SELECT 1 FROM rika_hosted_owners owner_record
      JOIN rika_hosted_threads thread ON thread.owner_id = owner_record.id
        AND thread.id = ${input.threadId} AND thread.executor_kind = 'local_device'
      JOIN rika_hosted_devices device ON device.id = ${input.deviceId}
        AND device.user_id = ${input.userId} AND device.revoked_at IS NULL
      LEFT JOIN "member" membership ON owner_record.kind = 'organization'
        AND membership.organization_id = owner_record.organization_id AND membership.user_id = ${input.userId}
      WHERE owner_record.id = ${input.ownerId}
        AND ((owner_record.kind = 'personal' AND owner_record.user_id = ${input.userId})
          OR (owner_record.kind = 'organization' AND membership.id IS NOT NULL))
      FOR KEY SHARE OF owner_record, thread, device`)
    if (authority[0] === undefined)
      return yield* failure("invalid-authority", "Workspace binding requires the user's local thread and device")
    const rows = yield* query(sql`INSERT INTO rika_hosted_local_workspace_bindings
      (id, owner_id, thread_id, user_id, device_id, root_path, workspace_fingerprint,
        created_at, last_seen_at)
      VALUES (${input.id}, ${input.ownerId}, ${input.threadId}, ${input.userId}, ${input.deviceId},
        ${input.rootPath}, ${input.workspaceFingerprint}, ${input.now}, ${input.now})
      ON CONFLICT (thread_id, device_id) DO UPDATE SET
        root_path = EXCLUDED.root_path,
        workspace_fingerprint = EXCLUDED.workspace_fingerprint,
        last_seen_at = EXCLUDED.last_seen_at
      WHERE rika_hosted_local_workspace_bindings.owner_id = EXCLUDED.owner_id
        AND rika_hosted_local_workspace_bindings.user_id = EXCLUDED.user_id
      RETURNING id, owner_id AS "ownerId", thread_id AS "threadId", user_id AS "userId",
        device_id AS "deviceId", root_path AS "rootPath", workspace_fingerprint AS "workspaceFingerprint",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
        to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenAt"`)
    if (rows[0] === undefined)
      return yield* failure("invalid-authority", "Workspace binding identity cannot be reassigned")
    return yield* decode(LocalWorkspaceBinding, rows[0])
  })

  const recordAuditEvent = Effect.fn("PostgresStore.recordAuditEvent")(function* (input: RecordAuditEventInput) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        yield* requireActiveClient(sql, input, input.occurredAt)
        const commitCursor = yield* allocateCommitCursor(sql, input.ownerId)
        const rows = yield* query(sql`INSERT INTO rika_hosted_audit_events
          (id, owner_id, actor, action, resource_kind, resource_id,
            commit_cursor, attributes, occurred_at)
          VALUES (${input.id}, ${input.ownerId}, ${sql.json(input.actor)}, ${input.action}, ${input.resourceKind},
            ${input.resourceId}, ${commitCursor}::bigint,
            ${sql.json(input.attributes)}, ${input.occurredAt})
          RETURNING id, owner_id AS "ownerId", actor, action, resource_kind AS "resourceKind",
            resource_id AS "resourceId", commit_cursor::text AS "commitCursor", attributes,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt"`)
        return yield* decode(AuditEvent, rows[0])
      }),
    )
  })

  const putCredentialReference = Effect.fn("PostgresStore.putCredentialReference")(function* (
    input: PutCredentialReferenceInput,
  ) {
    yield* requireOwnerCreator(sql, { ownerId: input.ownerId, userId: input.createdByUserId })
    if (input.projectId !== undefined) {
      const project = yield* query(
        sql`SELECT 1 FROM rika_hosted_projects WHERE owner_id = ${input.ownerId} AND id = ${input.projectId}`,
      )
      if (project[0] === undefined)
        return yield* failure("not-found", "Credential project does not exist for the owner")
    }
    const rows = yield* query(sql`INSERT INTO rika_hosted_credential_references
      (id, owner_id, project_id, provider, purpose, external_reference, metadata,
        created_by_user_id, created_at, updated_at)
      VALUES (${input.id}, ${input.ownerId}, ${input.projectId ?? null}, ${input.provider}, ${input.purpose},
        ${input.externalReference}, ${sql.json(input.metadata)}, ${input.createdByUserId}, ${input.now}, ${input.now})
      ON CONFLICT (id) DO UPDATE SET
        purpose = EXCLUDED.purpose,
        external_reference = EXCLUDED.external_reference,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at
      WHERE rika_hosted_credential_references.owner_id = EXCLUDED.owner_id
        AND rika_hosted_credential_references.project_id IS NOT DISTINCT FROM EXCLUDED.project_id
        AND rika_hosted_credential_references.provider = EXCLUDED.provider
        AND rika_hosted_credential_references.created_by_user_id = EXCLUDED.created_by_user_id
      RETURNING id, owner_id AS "ownerId", project_id AS "projectId", provider, purpose,
        external_reference AS "externalReference", metadata, created_by_user_id AS "createdByUserId",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`)
    if (rows[0] === undefined)
      return yield* failure("invalid-authority", "Credential reference identity cannot be reassigned")
    const row = rows[0] as Record<string, unknown>
    if (row.projectId === null) delete row.projectId
    return yield* decode(CredentialReference, row)
  })

  return HostedStore.of({
    putOwner,
    createProject,
    putProjectGrant,
    createWorkspace,
    createThread,
    putThreadGrant,
    registerDevice,
    authenticateClient,
    validateClient,
    grantClientAuthority,
    authorizeThread,
    admitCommand,
    admitPrompt,
    readCommands,
    appendEvent,
    appendRecoveredEvent,
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
