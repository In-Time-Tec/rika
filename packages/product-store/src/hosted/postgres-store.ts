import * as PgClient from "@effect/sql-pg/PgClient"
import { Effect, Layer, Schema } from "effect"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import {
  aliasedTable,
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql as expression,
  type SQLWrapper,
} from "drizzle-orm"
import { pgTable, text } from "drizzle-orm/pg-core"
import type { Row as SqlRow } from "effect/unstable/sql/SqlConnection"
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
  type HostedOwner,
  HostedThread,
  HostedOwnerRecord,
  HostedWorkspace,
  JsonObject,
  ExecutorInstanceId,
  OrganizationOwner,
  OwnerId,
  PersonalOwner,
  Presence,
  Project,
  ProjectGrant,
  ResumableCursor,
  Sequence,
  TerminalWriterLease,
  ThreadCommand,
  ThreadEvent,
  ThreadGrant,
  ThreadId,
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
  type CreateProjectInput,
  type CreateThreadInput,
  type CreateWorkspaceInput,
  type ReadThreadInput,
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
import {
  rikaHostedClientAuthorities,
  rikaHostedClientCursors,
  rikaHostedClients,
  rikaHostedCredentialReferences,
  rikaHostedDevices,
  rikaHostedAuditEvents,
  rikaHostedExecutorAssignments,
  rikaHostedExecutorOperations,
  rikaHostedOwnerCounters,
  rikaHostedOwners,
  rikaHostedPresence,
  rikaHostedProjectGrants,
  rikaHostedProjects,
  rikaHostedTerminalWriterLeases,
  rikaHostedThreadCommands,
  rikaHostedThreadEvents,
  rikaHostedThreadGrants,
  rikaHostedThreads,
  rikaHostedWorkspaces,
  rikaThreadQueueState,
  rikaThreads,
  rikaTurns,
} from "../database/schema/product"

const identityMembers = pgTable("member", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
})
const timestamp = (value: string) => expression<Date>`${value}::timestamptz`
const timestampText = (column: SQLWrapper) =>
  expression<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
type DatabaseExecutor = Pick<PgDrizzle.EffectPgDatabase, "insert" | "select" | "update">

const databaseError = (cause: unknown) =>
  StoreError.make({ reason: "database", message: `Hosted PostgreSQL operation failed: ${String(cause)}` })
const failure = (reason: StoreError["reason"], message: string) => StoreError.make({ reason, message })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))
const decode = <S extends Schema.Top>(schema: S, value: SqlRow | undefined) =>
  Schema.decodeEffect(schema)(value).pipe(Effect.mapError(databaseError))
const limit = (value: number) => Math.min(Math.max(Math.trunc(value), 1), 1_000)
const ExecutionRouteJson = Schema.fromJsonString(ExecutionRouteSnapshot)
const PromptPartsJson = Schema.fromJsonString(Schema.Array(PromptPart))
const AdmissionStatus = Schema.Literals(["accepted", "queued"])
const OwnerRow = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  userId: Schema.NullOr(Schema.String),
  organizationId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
})
const WorkspaceRow = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  createdByUserId: Schema.String,
  executorKind: Schema.Literals(["orb", "runner"]),
  inheritProjectGrants: Schema.Boolean,
  createdAt: Schema.String,
})
const ThreadRow = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  workspaceId: Schema.String,
  createdByUserId: Schema.String,
  executorKind: Schema.Literals(["orb", "runner"]),
  inheritProjectGrants: Schema.Boolean,
  createdAt: Schema.String,
})
const CredentialReferenceRow = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  provider: Schema.String,
  purpose: Schema.String,
  externalReference: Schema.String,
  metadata: JsonObject,
  createdByUserId: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
const ExistingAdmissionRow = Schema.Struct({ turnId: Schema.String, admissionStatus: AdmissionStatus })
const commandFields = {
  ownerId: rikaHostedThreadCommands.ownerId,
  threadId: rikaHostedThreadCommands.threadId,
  commandId: rikaHostedThreadCommands.commandId,
  idempotencyKey: rikaHostedThreadCommands.idempotencyKey,
  actor: rikaHostedThreadCommands.actor,
  sequence: expression<string>`${rikaHostedThreadCommands.sequence}::text`,
  commitCursor: expression<string>`${rikaHostedThreadCommands.commitCursor}::text`,
  command: rikaHostedThreadCommands.command,
  admittedAt: timestampText(rikaHostedThreadCommands.admittedAt),
}
const eventFields = {
  ownerId: rikaHostedThreadEvents.ownerId,
  threadId: rikaHostedThreadEvents.threadId,
  eventId: rikaHostedThreadEvents.eventId,
  idempotencyKey: rikaHostedThreadEvents.idempotencyKey,
  assignmentId: rikaHostedThreadEvents.assignmentId,
  executorInstanceId: rikaHostedThreadEvents.executorInstanceId,
  assignmentGeneration: expression<string>`${rikaHostedThreadEvents.assignmentGeneration}::text`,
  leaseEpoch: expression<string>`${rikaHostedThreadEvents.leaseEpoch}::text`,
  sequence: expression<string>`${rikaHostedThreadEvents.sequence}::text`,
  commitCursor: expression<string>`${rikaHostedThreadEvents.commitCursor}::text`,
  commandSequence: expression<string | null>`${rikaHostedThreadEvents.commandSequence}::text`,
  event: rikaHostedThreadEvents.event,
  createdAt: timestampText(rikaHostedThreadEvents.createdAt),
}
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
  db: DatabaseExecutor,
  ownerId: string,
) {
  const rows = yield* query(
    db
      .update(rikaHostedOwnerCounters)
      .set({
        nextCommitCursor: expression`${rikaHostedOwnerCounters.nextCommitCursor} + 1`,
      })
      .where(eq(rikaHostedOwnerCounters.ownerId, ownerId))
      .returning({
        cursor: expression<string>`(${rikaHostedOwnerCounters.nextCommitCursor} - 1)::text`,
      }),
  )
  if (rows[0] === undefined) return yield* failure("invalid-authority", "Owner authority is not initialized")
  return CommitCursor.make(rows[0].cursor)
})

const requireOwnerCreator = Effect.fn("PostgresStore.requireOwnerCreator")(function* (
  db: DatabaseExecutor,
  input: { readonly ownerId: string; readonly userId: string },
) {
  const rows = yield* query(
    db
      .select({ present: expression<number>`1` })
      .from(rikaHostedOwners)
      .leftJoin(
        identityMembers,
        and(
          eq(rikaHostedOwners.kind, "organization"),
          eq(identityMembers.organizationId, rikaHostedOwners.organizationId),
          eq(identityMembers.userId, input.userId),
        ),
      )
      .where(
        and(
          eq(rikaHostedOwners.id, input.ownerId),
          or(
            and(eq(rikaHostedOwners.kind, "personal"), eq(rikaHostedOwners.userId, input.userId)),
            and(eq(rikaHostedOwners.kind, "organization"), isNotNull(identityMembers.id)),
          ),
        ),
      )
      .for("key share", { of: rikaHostedOwners }),
  )
  if (rows[0] === undefined) return yield* failure("invalid-authority", "Owner is unavailable to the user")
})

const requireOrganizationGrantAuthority = Effect.fn("PostgresStore.requireOrganizationGrantAuthority")(function* (
  db: DatabaseExecutor,
  input: { readonly ownerId: string; readonly userId: string; readonly membershipId: string },
) {
  const actorMembership = aliasedTable(identityMembers, "actor_membership")
  const targetMembership = aliasedTable(identityMembers, "target_membership")
  const rows = yield* query(
    db
      .select({ present: expression<number>`1` })
      .from(rikaHostedOwners)
      .innerJoin(
        actorMembership,
        and(
          eq(actorMembership.organizationId, rikaHostedOwners.organizationId),
          eq(actorMembership.userId, input.userId),
        ),
      )
      .innerJoin(
        targetMembership,
        and(
          eq(targetMembership.organizationId, rikaHostedOwners.organizationId),
          eq(targetMembership.id, input.membershipId),
        ),
      )
      .where(and(eq(rikaHostedOwners.id, input.ownerId), eq(rikaHostedOwners.kind, "organization")))
      .for("key share", { of: rikaHostedOwners }),
  )
  if (rows[0] === undefined)
    return yield* failure("invalid-authority", "Grants require active organization memberships")
})

const make = Effect.gen(function* (): Effect.fn.Return<StoreService, never, PgClient.PgClient> {
  yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()

  const putOwner = Effect.fn("PostgresStore.putOwner")(function* (input: PutOwnerInput) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const userId = input.identity._tag === "PersonalOwner" ? input.identity.userId : null
          const organizationId = input.identity._tag === "OrganizationOwner" ? input.identity.organizationId : null
          const kind = input.identity._tag === "PersonalOwner" ? "personal" : "organization"
          const existing = yield* query(
            tx
              .select({
                id: rikaHostedOwners.id,
                kind: rikaHostedOwners.kind,
                userId: rikaHostedOwners.userId,
                organizationId: rikaHostedOwners.organizationId,
                createdAt: timestampText(rikaHostedOwners.createdAt),
              })
              .from(rikaHostedOwners)
              .where(
                or(
                  eq(rikaHostedOwners.id, input.id),
                  userId === null ? undefined : eq(rikaHostedOwners.userId, userId),
                  organizationId === null ? undefined : eq(rikaHostedOwners.organizationId, organizationId),
                ),
              )
              .for("update"),
          )
          const matching = existing.find((row) => row.id === input.id)
          if (existing.length > 0) {
            if (
              matching === undefined ||
              matching.kind !== kind ||
              matching.userId !== userId ||
              matching.organizationId !== organizationId
            ) {
              return yield* failure("conflict", "Owner identity cannot be reassigned")
            }
            let identity: HostedOwner
            if (matching.kind === "personal") {
              if (matching.userId === null) return yield* failure("database", "Personal owner has no user identity")
              identity = yield* decode(PersonalOwner, { _tag: "PersonalOwner", userId: matching.userId })
            } else {
              if (matching.organizationId === null)
                return yield* failure("database", "Organization owner has no organization identity")
              identity = yield* decode(OrganizationOwner, {
                _tag: "OrganizationOwner",
                organizationId: matching.organizationId,
              })
            }
            return yield* decode(HostedOwnerRecord, { id: matching.id, identity, createdAt: matching.createdAt })
          }
          const rows = yield* query(
            tx
              .insert(rikaHostedOwners)
              .values({ id: input.id, kind, userId, organizationId, createdAt: timestamp(input.now) })
              .onConflictDoUpdate({
                target: rikaHostedOwners.id,
                set: { id: expression`excluded.id` },
                setWhere: and(
                  eq(rikaHostedOwners.kind, expression<string>`excluded.kind`),
                  expression`${rikaHostedOwners.userId} is not distinct from excluded.user_id`,
                  expression`${rikaHostedOwners.organizationId} is not distinct from excluded.organization_id`,
                )!,
              })
              .returning({
                id: rikaHostedOwners.id,
                kind: rikaHostedOwners.kind,
                userId: rikaHostedOwners.userId,
                organizationId: rikaHostedOwners.organizationId,
                createdAt: timestampText(rikaHostedOwners.createdAt),
              }),
          )
          if (rows[0] === undefined) return yield* failure("conflict", "Owner identity cannot be reassigned")
          yield* query(tx.insert(rikaHostedOwnerCounters).values({ ownerId: input.id }).onConflictDoNothing())
          const row = yield* decode(OwnerRow, rows[0])
          let identity: HostedOwner
          if (row.kind === "personal") {
            if (row.userId === null) return yield* failure("database", "Personal owner has no user identity")
            identity = yield* decode(PersonalOwner, { _tag: "PersonalOwner", userId: row.userId })
          } else {
            if (row.organizationId === null)
              return yield* failure("database", "Organization owner has no organization identity")
            identity = yield* decode(OrganizationOwner, {
              _tag: "OrganizationOwner",
              organizationId: row.organizationId,
            })
          }
          return yield* decode(HostedOwnerRecord, { id: row.id, identity, createdAt: row.createdAt })
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const createProject = Effect.fn("PostgresStore.createProject")(function* (input: CreateProjectInput) {
    yield* requireOwnerCreator(db, { ownerId: input.ownerId, userId: input.createdByUserId })
    const rows = yield* query(
      db
        .insert(rikaHostedProjects)
        .values({
          id: input.id,
          ownerId: input.ownerId,
          name: input.name,
          createdByUserId: input.createdByUserId,
          createdAt: timestamp(input.now),
          updatedAt: timestamp(input.now),
        })
        .returning({
          id: rikaHostedProjects.id,
          ownerId: rikaHostedProjects.ownerId,
          name: rikaHostedProjects.name,
          createdByUserId: rikaHostedProjects.createdByUserId,
          createdAt: timestampText(rikaHostedProjects.createdAt),
          updatedAt: timestampText(rikaHostedProjects.updatedAt),
        }),
    )
    return yield* decode(Project, rows[0])
  })

  const putProjectGrant = Effect.fn("PostgresStore.putProjectGrant")(function* (input: PutProjectGrantInput) {
    yield* requireOrganizationGrantAuthority(db, {
      ownerId: input.ownerId,
      userId: input.grantedByUserId,
      membershipId: input.membershipId,
    })
    const rows = yield* query(
      db
        .insert(rikaHostedProjectGrants)
        .select(
          db
            .select({
              ownerId: expression<string>`${input.ownerId}`.as("owner_id"),
              projectId: rikaHostedProjects.id,
              membershipId: expression<string>`${input.membershipId}`.as("membership_id"),
              role: expression<typeof input.role>`${input.role}`.as("role"),
              grantedByUserId: expression<string>`${input.grantedByUserId}`.as("granted_by_user_id"),
              createdAt: timestamp(input.now).as("created_at"),
              updatedAt: timestamp(input.now).as("updated_at"),
            })
            .from(rikaHostedProjects)
            .where(and(eq(rikaHostedProjects.id, input.projectId), eq(rikaHostedProjects.ownerId, input.ownerId))),
        )
        .onConflictDoUpdate({
          target: [rikaHostedProjectGrants.projectId, rikaHostedProjectGrants.membershipId],
          set: {
            role: expression`excluded.role`,
            grantedByUserId: expression`excluded.granted_by_user_id`,
            updatedAt: expression`excluded.updated_at`,
          },
          setWhere: eq(rikaHostedProjectGrants.ownerId, expression<string>`excluded.owner_id`),
        })
        .returning({
          ownerId: rikaHostedProjectGrants.ownerId,
          projectId: rikaHostedProjectGrants.projectId,
          membershipId: rikaHostedProjectGrants.membershipId,
          role: rikaHostedProjectGrants.role,
          grantedByUserId: rikaHostedProjectGrants.grantedByUserId,
          createdAt: timestampText(rikaHostedProjectGrants.createdAt),
          updatedAt: timestampText(rikaHostedProjectGrants.updatedAt),
        }),
    )
    if (rows[0] === undefined) return yield* failure("not-found", "Project does not exist for the owner")
    return yield* decode(ProjectGrant, rows[0])
  })

  const createWorkspace = Effect.fn("PostgresStore.createWorkspace")(function* (input: CreateWorkspaceInput) {
    if (input.executorKind === "runner" && input.inheritProjectGrants === true)
      return yield* failure("invalid-authority", "Local workspaces cannot inherit project grants")
    yield* requireOwnerCreator(db, { ownerId: input.ownerId, userId: input.createdByUserId })
    if (input.projectId !== undefined) {
      const project = yield* query(
        db
          .select({ present: expression<number>`1` })
          .from(rikaHostedProjects)
          .where(and(eq(rikaHostedProjects.id, input.projectId), eq(rikaHostedProjects.ownerId, input.ownerId))),
      )
      if (project[0] === undefined) return yield* failure("not-found", "Project does not exist for the owner")
    }
    const inherit = input.executorKind === "orb" ? (input.inheritProjectGrants ?? true) : false
    const rows = yield* query(
      db
        .insert(rikaHostedWorkspaces)
        .values({
          id: input.id,
          ownerId: input.ownerId,
          projectId: input.projectId ?? null,
          createdByUserId: input.createdByUserId,
          executorKind: input.executorKind,
          inheritProjectGrants: inherit,
          createdAt: timestamp(input.now),
        })
        .returning({
          id: rikaHostedWorkspaces.id,
          ownerId: rikaHostedWorkspaces.ownerId,
          projectId: rikaHostedWorkspaces.projectId,
          createdByUserId: rikaHostedWorkspaces.createdByUserId,
          executorKind: rikaHostedWorkspaces.executorKind,
          inheritProjectGrants: rikaHostedWorkspaces.inheritProjectGrants,
          createdAt: timestampText(rikaHostedWorkspaces.createdAt),
        }),
    )
    const row = yield* decode(WorkspaceRow, rows[0])
    const workspace = {
      id: row.id,
      ownerId: row.ownerId,
      createdByUserId: row.createdByUserId,
      executorKind: row.executorKind,
      inheritProjectGrants: row.inheritProjectGrants,
      createdAt: row.createdAt,
    }
    return yield* decode(
      HostedWorkspace,
      row.projectId === null ? workspace : { ...workspace, projectId: row.projectId },
    )
  })

  const createThread = Effect.fn("PostgresStore.createThread")(function* (input: CreateThreadInput) {
    if (input.executorKind === "runner" && input.inheritProjectGrants === true)
      return yield* failure("invalid-authority", "Local threads cannot inherit project grants")
    yield* requireOwnerCreator(db, { ownerId: input.ownerId, userId: input.createdByUserId })
    const rows = yield* query(
      db
        .insert(rikaHostedThreads)
        .select(
          db
            .select({
              id: expression<string>`${input.id}`.as("id"),
              ownerId: expression<string>`${input.ownerId}`.as("owner_id"),
              projectId: expression<string | null>`${input.projectId ?? null}`.as("project_id"),
              workspaceId: rikaHostedWorkspaces.id,
              createdByUserId: expression<string>`${input.createdByUserId}`.as("created_by_user_id"),
              executorKind: expression<typeof input.executorKind>`${input.executorKind}`.as("executor_kind"),
              inheritProjectGrants: (input.executorKind === "orb"
                ? expression<boolean>`coalesce(${input.inheritProjectGrants ?? null}, ${rikaHostedWorkspaces.inheritProjectGrants})`
                : expression<boolean>`false`
              ).as("inherit_project_grants"),
              createdAt: timestamp(input.now).as("created_at"),
            })
            .from(rikaHostedWorkspaces)
            .where(
              and(
                eq(rikaHostedWorkspaces.id, input.workspaceId),
                eq(rikaHostedWorkspaces.ownerId, input.ownerId),
                expression`${rikaHostedWorkspaces.projectId} is not distinct from ${input.projectId ?? null}`,
                eq(rikaHostedWorkspaces.executorKind, input.executorKind),
              ),
            ),
        )
        .returning({
          id: rikaHostedThreads.id,
          ownerId: rikaHostedThreads.ownerId,
          projectId: rikaHostedThreads.projectId,
          workspaceId: rikaHostedThreads.workspaceId,
          createdByUserId: rikaHostedThreads.createdByUserId,
          executorKind: rikaHostedThreads.executorKind,
          inheritProjectGrants: rikaHostedThreads.inheritProjectGrants,
          createdAt: timestampText(rikaHostedThreads.createdAt),
        }),
    )
    if (rows[0] === undefined) return yield* failure("not-found", "Workspace does not belong to the owner and project")
    const row = yield* decode(ThreadRow, rows[0])
    const thread = {
      id: row.id,
      ownerId: row.ownerId,
      workspaceId: row.workspaceId,
      createdByUserId: row.createdByUserId,
      executorKind: row.executorKind,
      inheritProjectGrants: row.inheritProjectGrants,
      createdAt: row.createdAt,
    }
    return yield* decode(HostedThread, row.projectId === null ? thread : { ...thread, projectId: row.projectId })
  })

  const readThread = Effect.fn("PostgresStore.readThread")(function* (input: ReadThreadInput) {
    const rows = yield* query(
      db
        .select({
          id: rikaHostedThreads.id,
          ownerId: rikaHostedThreads.ownerId,
          projectId: rikaHostedThreads.projectId,
          workspaceId: rikaHostedThreads.workspaceId,
          createdByUserId: rikaHostedThreads.createdByUserId,
          executorKind: rikaHostedThreads.executorKind,
          inheritProjectGrants: rikaHostedThreads.inheritProjectGrants,
          createdAt: timestampText(rikaHostedThreads.createdAt),
        })
        .from(rikaHostedThreads)
        .where(and(eq(rikaHostedThreads.id, input.threadId), eq(rikaHostedThreads.ownerId, input.ownerId))),
    )
    if (rows[0] === undefined) return undefined
    const row = yield* decode(ThreadRow, rows[0])
    const thread = {
      id: row.id,
      ownerId: row.ownerId,
      workspaceId: row.workspaceId,
      createdByUserId: row.createdByUserId,
      executorKind: row.executorKind,
      inheritProjectGrants: row.inheritProjectGrants,
      createdAt: row.createdAt,
    }
    return yield* decode(HostedThread, row.projectId === null ? thread : { ...thread, projectId: row.projectId })
  })

  const putThreadGrant = Effect.fn("PostgresStore.putThreadGrant")(function* (input: PutThreadGrantInput) {
    yield* requireOrganizationGrantAuthority(db, {
      ownerId: input.ownerId,
      userId: input.grantedByUserId,
      membershipId: input.membershipId,
    })
    const rows = yield* query(
      db
        .insert(rikaHostedThreadGrants)
        .select(
          db
            .select({
              ownerId: expression<string>`${input.ownerId}`.as("owner_id"),
              threadId: rikaHostedThreads.id,
              membershipId: expression<string>`${input.membershipId}`.as("membership_id"),
              role: expression<typeof input.role>`${input.role}`.as("role"),
              grantedByUserId: expression<string>`${input.grantedByUserId}`.as("granted_by_user_id"),
              createdAt: timestamp(input.now).as("created_at"),
              updatedAt: timestamp(input.now).as("updated_at"),
            })
            .from(rikaHostedThreads)
            .where(and(eq(rikaHostedThreads.id, input.threadId), eq(rikaHostedThreads.ownerId, input.ownerId))),
        )
        .onConflictDoUpdate({
          target: [rikaHostedThreadGrants.threadId, rikaHostedThreadGrants.membershipId],
          set: {
            role: expression`excluded.role`,
            grantedByUserId: expression`excluded.granted_by_user_id`,
            updatedAt: expression`excluded.updated_at`,
          },
          setWhere: eq(rikaHostedThreadGrants.ownerId, expression<string>`excluded.owner_id`),
        })
        .returning({
          ownerId: rikaHostedThreadGrants.ownerId,
          threadId: rikaHostedThreadGrants.threadId,
          membershipId: rikaHostedThreadGrants.membershipId,
          role: rikaHostedThreadGrants.role,
          grantedByUserId: rikaHostedThreadGrants.grantedByUserId,
          createdAt: timestampText(rikaHostedThreadGrants.createdAt),
          updatedAt: timestampText(rikaHostedThreadGrants.updatedAt),
        }),
    )
    if (rows[0] === undefined) return yield* failure("not-found", "Thread does not exist for the owner")
    return yield* decode(ThreadGrant, rows[0])
  })

  const registerDevice = Effect.fn("PostgresStore.registerDevice")(function* (input: RegisterDeviceInput) {
    const rows = yield* query(
      db
        .insert(rikaHostedDevices)
        .values({
          id: input.id,
          userId: input.userId,
          displayName: input.displayName,
          publicKeyFingerprint: input.publicKeyFingerprint,
          createdAt: timestamp(input.now),
          lastSeenAt: timestamp(input.now),
        })
        .onConflictDoUpdate({
          target: rikaHostedDevices.id,
          set: {
            displayName: expression`excluded.display_name`,
            publicKeyFingerprint: expression`excluded.public_key_fingerprint`,
            lastSeenAt: expression`excluded.last_seen_at`,
          },
          setWhere: and(
            eq(rikaHostedDevices.userId, expression<string>`excluded.user_id`),
            isNull(rikaHostedDevices.revokedAt),
          )!,
        })
        .returning({
          id: rikaHostedDevices.id,
          userId: rikaHostedDevices.userId,
          displayName: rikaHostedDevices.displayName,
          publicKeyFingerprint: rikaHostedDevices.publicKeyFingerprint,
          createdAt: timestampText(rikaHostedDevices.createdAt),
          lastSeenAt: timestampText(rikaHostedDevices.lastSeenAt),
          revokedAt: expression<null>`NULL`,
        }),
    )
    if (rows[0] === undefined) return yield* failure("invalid-authority", "Device identity cannot be reassigned")
    return yield* decode(AuthenticatedDevice, rows[0])
  })

  const authenticateClient = Effect.fn("PostgresStore.authenticateClient")(function* (input: AuthenticateClientInput) {
    const now = timestamp(input.now)
    const expiresAt = timestamp(input.expiresAt)
    const deviceRecord = aliasedTable(rikaHostedDevices, "device_record")
    const rows = yield* query(
      db
        .insert(rikaHostedClients)
        .select(
          db
            .select({
              id: expression<string>`${input.id}`.as("id"),
              userId: expression<string>`${input.userId}`.as("user_id"),
              deviceId: expression<string>`"device_record"."id"`.as("device_id"),
              authenticatedAt: expression<Date>`${now}`.as("authenticated_at"),
              lastSeenAt: expression<Date>`${now}`.as("last_seen_at"),
              expiresAt: expression<Date>`${expiresAt}`.as("expires_at"),
              revokedAt: expression<null>`null`.as("revoked_at"),
            })
            .from(deviceRecord)
            .where(
              and(
                eq(deviceRecord.id, input.deviceId),
                eq(deviceRecord.userId, input.userId),
                isNull(deviceRecord.revokedAt),
                expression`${expiresAt} > ${now}`,
                expression`${expiresAt}::timestamptz <= ${now}::timestamptz + interval '5 minutes'`,
              ),
            ),
        )
        .onConflictDoUpdate({
          target: rikaHostedClients.id,
          set: {
            authenticatedAt: expression`excluded.authenticated_at`,
            lastSeenAt: expression`excluded.last_seen_at`,
            expiresAt: expression`excluded.expires_at`,
          },
          setWhere: and(
            eq(rikaHostedClients.userId, expression<string>`excluded.user_id`),
            eq(rikaHostedClients.deviceId, expression<string>`excluded.device_id`),
            isNull(rikaHostedClients.revokedAt),
          )!,
        })
        .returning({
          id: rikaHostedClients.id,
          userId: rikaHostedClients.userId,
          deviceId: rikaHostedClients.deviceId,
          authenticatedAt: timestampText(rikaHostedClients.authenticatedAt),
          lastSeenAt: timestampText(rikaHostedClients.lastSeenAt),
          expiresAt: timestampText(rikaHostedClients.expiresAt),
          revokedAt: expression<null>`null`,
        }),
    )
    if (rows[0] === undefined)
      return yield* failure("invalid-authority", "Client device is inactive, foreign, or exceeds five minutes")
    return yield* decode(AuthenticatedClient, rows[0])
  })

  const validateClient: StoreService["validateClient"] = Effect.fn("PostgresStore.validateClient")(function* (input) {
    const rows = yield* query(
      db
        .select({ present: expression<number>`1` })
        .from(rikaHostedClients)
        .innerJoin(
          rikaHostedDevices,
          and(
            eq(rikaHostedDevices.id, rikaHostedClients.deviceId),
            eq(rikaHostedDevices.userId, rikaHostedClients.userId),
          ),
        )
        .where(
          and(
            eq(rikaHostedClients.id, input.clientId),
            eq(rikaHostedClients.userId, input.userId),
            eq(rikaHostedClients.deviceId, input.deviceId),
            isNull(rikaHostedClients.revokedAt),
            isNull(rikaHostedDevices.revokedAt),
            gt(rikaHostedClients.expiresAt, timestamp(input.at)),
          ),
        )
        .for("key share", { of: [rikaHostedClients, rikaHostedDevices] }),
    )
    if (rows[0] === undefined) return yield* failure("invalid-authority", "Client authority is inactive or foreign")
  })

  const grantClientAuthority: StoreService["grantClientAuthority"] = Effect.fn("PostgresStore.grantClientAuthority")(
    function* (input) {
      const now = timestamp(input.now)
      const expiresAt = timestamp(input.expiresAt)
      const membershipId = input.actor._tag === "OrganizationActor" ? input.actor.membershipId : null
      const authority = yield* query(
        db
          .insert(rikaHostedClientAuthorities)
          .select(
            db
              .select({
                clientId: rikaHostedClients.id,
                ownerId: rikaHostedOwners.id,
                issuedAt: expression<Date>`${now}`.as("issued_at"),
                expiresAt: expression<Date>`least(${expiresAt}, ${rikaHostedClients.expiresAt})`.as("expires_at"),
                revokedAt: expression<null>`null`.as("revoked_at"),
              })
              .from(rikaHostedOwners)
              .innerJoin(
                rikaHostedClients,
                and(
                  eq(rikaHostedClients.id, input.actor.clientId),
                  eq(rikaHostedClients.userId, input.actor.userId),
                  eq(rikaHostedClients.deviceId, input.actor.deviceId),
                  isNull(rikaHostedClients.revokedAt),
                  gt(rikaHostedClients.expiresAt, now),
                ),
              )
              .innerJoin(
                rikaHostedDevices,
                and(
                  eq(rikaHostedDevices.id, rikaHostedClients.deviceId),
                  eq(rikaHostedDevices.userId, rikaHostedClients.userId),
                  isNull(rikaHostedDevices.revokedAt),
                ),
              )
              .leftJoin(
                identityMembers,
                and(
                  eq(rikaHostedOwners.kind, "organization"),
                  eq(identityMembers.organizationId, rikaHostedOwners.organizationId),
                  membershipId === null ? undefined : eq(identityMembers.id, membershipId),
                  eq(identityMembers.userId, rikaHostedClients.userId),
                ),
              )
              .where(
                and(
                  eq(rikaHostedOwners.id, input.ownerId),
                  expression`${expiresAt} > ${now}`,
                  expression`${expiresAt}::timestamptz <= ${now}::timestamptz + interval '5 minutes'`,
                  or(
                    and(
                      eq(rikaHostedOwners.kind, "personal"),
                      eq(expression<string>`${input.actor._tag}`, "PersonalActor"),
                      eq(rikaHostedOwners.userId, rikaHostedClients.userId),
                    ),
                    and(
                      eq(rikaHostedOwners.kind, "organization"),
                      eq(expression<string>`${input.actor._tag}`, "OrganizationActor"),
                      isNotNull(identityMembers.id),
                    ),
                  ),
                ),
              ),
          )
          .onConflictDoUpdate({
            target: [rikaHostedClientAuthorities.clientId, rikaHostedClientAuthorities.ownerId],
            set: {
              issuedAt: expression`excluded.issued_at`,
              expiresAt: expression`excluded.expires_at`,
              revokedAt: null,
            },
          })
          .returning({ clientId: rikaHostedClientAuthorities.clientId }),
      )
      if (authority[0] === undefined)
        return yield* failure("invalid-authority", "Client owner authority is inactive or foreign")
    },
  )

  const authorizeThread: StoreService["authorizeThread"] = Effect.fn("PostgresStore.authorizeThread")((input) =>
    db
      .transaction((tx) => requireThreadAccess(tx, input, input.action, input.at))
      .pipe(Effect.catchTag("SqlError", databaseError)),
  )

  const admitCommand = Effect.fn("PostgresStore.admitCommand")(function* (input: AdmitCommandInput) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const locked = yield* query(
            tx
              .select({ id: rikaHostedThreads.id })
              .from(rikaHostedThreads)
              .where(and(eq(rikaHostedThreads.id, input.threadId), eq(rikaHostedThreads.ownerId, input.ownerId)))
              .for("update"),
          )
          if (locked[0] === undefined) return yield* failure("not-found", "Thread does not exist for the owner")
          yield* requireThreadAccess(tx, input, "thread:control", input.admittedAt)
          const existingRows = yield* query(
            tx
              .select(commandFields)
              .from(rikaHostedThreadCommands)
              .where(
                and(
                  eq(rikaHostedThreadCommands.ownerId, input.ownerId),
                  eq(rikaHostedThreadCommands.threadId, input.threadId),
                  or(
                    eq(rikaHostedThreadCommands.commandId, input.commandId),
                    eq(rikaHostedThreadCommands.idempotencyKey, input.idempotencyKey),
                  ),
                ),
              ),
          )
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
            const writer = yield* query(
              tx
                .select({ present: expression<number>`1` })
                .from(rikaHostedTerminalWriterLeases)
                .where(
                  and(
                    eq(rikaHostedTerminalWriterLeases.ownerId, input.ownerId),
                    eq(rikaHostedTerminalWriterLeases.threadId, input.threadId),
                    eq(rikaHostedTerminalWriterLeases.actor, input.actor),
                    eq(rikaHostedTerminalWriterLeases.leaseId, input.command.writerLeaseId),
                    eq(
                      rikaHostedTerminalWriterLeases.generation,
                      expression<number>`${input.command.writerGeneration}::bigint`,
                    ),
                    gt(rikaHostedTerminalWriterLeases.expiresAt, timestamp(input.admittedAt)),
                  ),
                ),
            )
            if (writer[0] === undefined)
              return yield* failure("stale-fence", "Terminal writer lease is expired or fenced")
          }
          const sequences = yield* query(
            tx
              .update(rikaHostedThreads)
              .set({ nextCommandSequence: expression`${rikaHostedThreads.nextCommandSequence} + 1` })
              .where(and(eq(rikaHostedThreads.id, input.threadId), eq(rikaHostedThreads.ownerId, input.ownerId)))
              .returning({ sequence: expression<string>`(${rikaHostedThreads.nextCommandSequence} - 1)::text` }),
          )
          const sequence = Sequence.make(sequences[0]!.sequence)
          const commitCursor = yield* allocateCommitCursor(tx, input.ownerId)
          const rows = yield* query(
            tx
              .insert(rikaHostedThreadCommands)
              .values({
                ownerId: input.ownerId,
                threadId: input.threadId,
                commandId: input.commandId,
                idempotencyKey: input.idempotencyKey,
                actor: input.actor,
                sequence: expression<number>`${sequence}::bigint`,
                commitCursor: expression<number>`${commitCursor}::bigint`,
                command: input.command,
                admittedAt: timestamp(input.admittedAt),
              })
              .returning(commandFields),
          )
          return yield* decode(ThreadCommand, rows[0])
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
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
    const command: AdmitCommandInput["command"] =
      input.promptParts === undefined
        ? { _tag: "SubmitPrompt", prompt: input.prompt, mode: input.executionRoute.mode }
        : {
            _tag: "SubmitPrompt",
            prompt: input.prompt,
            promptParts: input.promptParts,
            mode: input.executionRoute.mode,
          }
    const commandInput: AdmitCommandInput = {
      ownerId: input.ownerId,
      threadId: input.threadId,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      command,
      admittedAt: input.admittedAt,
    }
    let inserted = false
    const admitted = yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const locked = yield* query(
            tx
              .select({ id: rikaHostedThreads.id })
              .from(rikaHostedThreads)
              .where(and(eq(rikaHostedThreads.id, input.threadId), eq(rikaHostedThreads.ownerId, input.ownerId)))
              .for("update"),
          )
          if (locked[0] === undefined) return yield* failure("not-found", "Thread does not exist for the owner")
          yield* requireThreadAccess(tx, input, "thread:control", input.admittedAt)
          const existingRows = yield* query(
            tx
              .select({
                ...commandFields,
                turnId: rikaHostedThreadCommands.turnId,
                admissionStatus: rikaHostedThreadCommands.admissionStatus,
              })
              .from(rikaHostedThreadCommands)
              .where(
                and(
                  eq(rikaHostedThreadCommands.ownerId, input.ownerId),
                  eq(rikaHostedThreadCommands.threadId, input.threadId),
                  or(
                    eq(rikaHostedThreadCommands.commandId, input.commandId),
                    eq(rikaHostedThreadCommands.idempotencyKey, input.idempotencyKey),
                  ),
                ),
              ),
          )
          if (existingRows.length > 1)
            return yield* failure("conflict", "Command identity or idempotency key collides with multiple commands")
          if (existingRows[0] !== undefined) {
            const existing = yield* decode(ThreadCommand, existingRows[0])
            if (!commandEquivalent(existing, commandInput))
              return yield* failure("conflict", "Command identity or idempotency key was reused with different content")
            const admission = yield* decode(ExistingAdmissionRow, existingRows[0]).pipe(
              Effect.catch(() => failure("conflict", "Command identity was admitted without a Turn")),
            )
            return { command: existing, turnId: TurnId.make(admission.turnId), status: admission.admissionStatus }
          }
          if (!input.readinessProof) return yield* failure("database", "Prompt admission workers are unavailable")
          const productThread = yield* query(
            tx
              .select({ present: expression<number>`1` })
              .from(rikaThreads)
              .where(and(eq(rikaThreads.id, input.threadId), eq(rikaThreads.ownerId, input.ownerId)))
              .for("key share"),
          )
          if (productThread[0] === undefined)
            return yield* failure("invalid-authority", "Thread has no product state for the owner")
          const collidingTurn = yield* query(
            tx
              .select({ present: expression<number>`1` })
              .from(rikaTurns)
              .where(eq(rikaTurns.id, input.turnId)),
          )
          if (collidingTurn[0] !== undefined) return yield* failure("conflict", "Turn identity is already in use")
          const occupied = yield* query(
            tx
              .select({ present: expression<number>`1` })
              .from(rikaTurns)
              .where(
                and(
                  eq(rikaTurns.threadId, input.threadId),
                  eq(rikaTurns.turnKind, "AgentExecution"),
                  inArray(rikaTurns.status, ["queued", "accepted", "running", "waiting", "cancelling"]),
                ),
              )
              .limit(1),
          )
          const status = occupied[0] === undefined ? ("accepted" as const) : ("queued" as const)
          yield* query(
            tx.insert(rikaTurns).values({
              id: input.turnId,
              threadId: input.threadId,
              turnKind: "AgentExecution",
              prompt: input.prompt,
              promptPartsJson: promptParts ?? null,
              executionRouteJson: executionRoute,
              authorJson: '{"_tag":"Human"}',
              lineageJson: '{"_tag":"Original"}',
              status,
              createdAt: admittedAtMillis,
              updatedAt: admittedAtMillis,
            }),
          )
          yield* query(tx.insert(rikaThreadQueueState).values({ threadId: input.threadId }).onConflictDoNothing())
          if (status === "queued") {
            const queueRows = yield* query(
              tx
                .update(rikaThreadQueueState)
                .set({
                  revision: expression`${rikaThreadQueueState.revision} + 1`,
                  queuedCount: expression`${rikaThreadQueueState.queuedCount} + 1`,
                })
                .where(
                  and(
                    eq(rikaThreadQueueState.threadId, input.threadId),
                    expression`${rikaThreadQueueState.queuedCount} < ${queueCapacity}`,
                  ),
                )
                .returning({ queuedCount: rikaThreadQueueState.queuedCount }),
            )
            if (queueRows[0] === undefined) return yield* failure("conflict", "Thread prompt queue is full")
          }
          const sequences = yield* query(
            tx
              .update(rikaHostedThreads)
              .set({ nextCommandSequence: expression`${rikaHostedThreads.nextCommandSequence} + 1` })
              .where(and(eq(rikaHostedThreads.id, input.threadId), eq(rikaHostedThreads.ownerId, input.ownerId)))
              .returning({ sequence: expression<string>`(${rikaHostedThreads.nextCommandSequence} - 1)::text` }),
          )
          const sequence = Sequence.make(sequences[0]!.sequence)
          const commitCursor = yield* allocateCommitCursor(tx, input.ownerId)
          const rows = yield* query(
            tx
              .insert(rikaHostedThreadCommands)
              .values({
                ownerId: input.ownerId,
                threadId: input.threadId,
                commandId: input.commandId,
                idempotencyKey: input.idempotencyKey,
                turnId: input.turnId,
                admissionStatus: status,
                actor: input.actor,
                sequence: expression<number>`${sequence}::bigint`,
                commitCursor: expression<number>`${commitCursor}::bigint`,
                command: commandInput.command,
                admittedAt: timestamp(input.admittedAt),
              })
              .returning(commandFields),
          )
          inserted = true
          return { command: yield* decode(ThreadCommand, rows[0]), turnId: input.turnId, status }
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
    if (inserted)
      yield* HostedObservability.event("admission", "success", {
        threadId: input.threadId,
        turnId: admitted.turnId,
      })
    return admitted
  })

  const readCommands: StoreService["readCommands"] = Effect.fn("PostgresStore.readCommands")(function* (input) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireThreadAccess(tx, input, "thread:view")
          const rows = yield* query(
            tx
              .select(commandFields)
              .from(rikaHostedThreadCommands)
              .where(
                and(
                  eq(rikaHostedThreadCommands.ownerId, input.ownerId),
                  eq(rikaHostedThreadCommands.threadId, input.threadId),
                  gt(rikaHostedThreadCommands.commitCursor, expression<number>`${input.afterCommitCursor}::bigint`),
                ),
              )
              .orderBy(asc(rikaHostedThreadCommands.commitCursor))
              .limit(limit(input.limit)),
          )
          return yield* Effect.forEach(rows, (row) => decode(ThreadCommand, row))
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const appendEvent = Effect.fn("PostgresStore.appendEvent")(function* (input: AppendEventInput) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const assignments = yield* query(
            tx
              .select({
                ownerId: rikaHostedExecutorAssignments.ownerId,
                threadId: rikaHostedExecutorAssignments.threadId,
                executorInstanceId: rikaHostedExecutorAssignments.executorInstanceId,
              })
              .from(rikaHostedExecutorAssignments)
              .where(
                and(
                  eq(rikaHostedExecutorAssignments.id, input.assignmentId),
                  eq(
                    rikaHostedExecutorAssignments.generation,
                    expression<number>`${input.assignmentGeneration}::bigint`,
                  ),
                  eq(rikaHostedExecutorAssignments.leaseEpoch, expression<number>`${input.leaseEpoch}::bigint`),
                  eq(rikaHostedExecutorAssignments.lifecycle, "active"),
                  gt(rikaHostedExecutorAssignments.leaseExpiresAt, expression<Date>`transaction_timestamp()`),
                ),
              )
              .for("share"),
          )
          const assignment = assignments[0]
          if (assignment === undefined || assignment.executorInstanceId === null)
            return yield* failure("stale-fence", "Executor assignment is expired or fenced")
          const locked = yield* query(
            tx
              .select({ id: rikaHostedThreads.id })
              .from(rikaHostedThreads)
              .where(
                and(eq(rikaHostedThreads.id, assignment.threadId), eq(rikaHostedThreads.ownerId, assignment.ownerId)),
              )
              .for("update"),
          )
          if (locked[0] === undefined) return yield* failure("not-found", "Thread does not exist in the organization")
          const existingRows = yield* query(
            tx
              .select(eventFields)
              .from(rikaHostedThreadEvents)
              .where(
                and(
                  eq(rikaHostedThreadEvents.threadId, assignment.threadId),
                  or(
                    eq(rikaHostedThreadEvents.eventId, input.eventId),
                    eq(rikaHostedThreadEvents.idempotencyKey, input.idempotencyKey),
                  ),
                ),
              ),
          )
          if (existingRows.length > 1)
            return yield* failure("conflict", "Event identity or idempotency key collides with multiple events")
          const comparable = {
            ...input,
            ownerId: OwnerId.make(assignment.ownerId),
            threadId: ThreadId.make(assignment.threadId),
            executorInstanceId: ExecutorInstanceId.make(assignment.executorInstanceId),
          }
          if (existingRows[0] !== undefined) {
            const existing = yield* decode(ThreadEvent, existingRows[0])
            if (!eventEquivalent(existing, comparable)) {
              return yield* failure("conflict", "Event identity or idempotency key was reused with different content")
            }
            return existing
          }
          const sequences = yield* query(
            tx
              .update(rikaHostedThreads)
              .set({ nextEventSequence: expression`${rikaHostedThreads.nextEventSequence} + 1` })
              .where(
                and(eq(rikaHostedThreads.id, assignment.threadId), eq(rikaHostedThreads.ownerId, assignment.ownerId)),
              )
              .returning({ sequence: expression<string>`(${rikaHostedThreads.nextEventSequence} - 1)::text` }),
          )
          const sequence = Sequence.make(sequences[0]!.sequence)
          const commitCursor = yield* allocateCommitCursor(tx, assignment.ownerId)
          const rows = yield* query(
            tx
              .insert(rikaHostedThreadEvents)
              .values({
                ownerId: assignment.ownerId,
                threadId: assignment.threadId,
                eventId: input.eventId,
                idempotencyKey: input.idempotencyKey,
                assignmentId: input.assignmentId,
                executorInstanceId: assignment.executorInstanceId,
                assignmentGeneration: expression<number>`${input.assignmentGeneration}::bigint`,
                leaseEpoch: expression<number>`${input.leaseEpoch}::bigint`,
                sequence: expression<number>`${sequence}::bigint`,
                commitCursor: expression<number>`${commitCursor}::bigint`,
                commandSequence:
                  input.commandSequence === null ? null : expression<number>`${input.commandSequence}::bigint`,
                event: input.event,
              })
              .returning(eventFields),
          )
          return yield* decode(ThreadEvent, rows[0])
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const appendRecoveredEvent = Effect.fn("PostgresStore.appendRecoveredEvent")(function* (
    input: AppendRecoveredEventInput,
  ) {
    if (String(input.eventId) !== String(input.idempotencyKey))
      return yield* failure("conflict", "Recovered event identity must equal its operation key")
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const assignments = yield* query(
            tx
              .select({
                ownerId: rikaHostedExecutorAssignments.ownerId,
                threadId: rikaHostedExecutorAssignments.threadId,
              })
              .from(rikaHostedExecutorAssignments)
              .where(eq(rikaHostedExecutorAssignments.id, input.assignmentId))
              .for("share"),
          )
          const assignment = assignments[0]
          if (assignment === undefined) return yield* failure("not-found", "Executor assignment does not exist")
          const operations = yield* query(
            tx
              .select({ operationKey: rikaHostedExecutorOperations.operationKey })
              .from(rikaHostedExecutorOperations)
              .where(
                and(
                  eq(rikaHostedExecutorOperations.assignmentId, input.assignmentId),
                  eq(rikaHostedExecutorOperations.operationKey, input.idempotencyKey),
                  eq(rikaHostedExecutorOperations.state, "unknown"),
                  eq(
                    rikaHostedExecutorOperations.dispatchedGeneration,
                    expression<number>`${input.assignmentGeneration}::bigint`,
                  ),
                  eq(
                    rikaHostedExecutorOperations.dispatchedLeaseEpoch,
                    expression<number>`${input.leaseEpoch}::bigint`,
                  ),
                  eq(rikaHostedExecutorOperations.dispatchedExecutorInstanceId, input.executorInstanceId),
                  eq(rikaHostedExecutorOperations.dispatchedProcessIncarnation, input.processIncarnation),
                ),
              )
              .for("update"),
          )
          if (operations[0] === undefined)
            return yield* failure("stale-fence", "Recovered event does not match the dispatched operation fence")
          const locked = yield* query(
            tx
              .select({ id: rikaHostedThreads.id })
              .from(rikaHostedThreads)
              .where(
                and(eq(rikaHostedThreads.id, assignment.threadId), eq(rikaHostedThreads.ownerId, assignment.ownerId)),
              )
              .for("update"),
          )
          if (locked[0] === undefined) return yield* failure("not-found", "Thread does not exist in the organization")
          const existingRows = yield* query(
            tx
              .select(eventFields)
              .from(rikaHostedThreadEvents)
              .where(
                and(
                  eq(rikaHostedThreadEvents.threadId, assignment.threadId),
                  or(
                    eq(rikaHostedThreadEvents.eventId, input.eventId),
                    eq(rikaHostedThreadEvents.idempotencyKey, input.idempotencyKey),
                  ),
                ),
              ),
          )
          if (existingRows.length > 1)
            return yield* failure("conflict", "Recovered event identity collides with multiple events")
          const comparable = {
            ...input,
            ownerId: OwnerId.make(assignment.ownerId),
            threadId: ThreadId.make(assignment.threadId),
            executorInstanceId: ExecutorInstanceId.make(input.executorInstanceId),
          }
          const existingRow = existingRows[0]
          if (existingRow !== undefined) {
            const existing = yield* decode(ThreadEvent, existingRow)
            if (!eventEquivalent(existing, comparable))
              return yield* failure("conflict", "Event identity or idempotency key was reused with different content")
            return existing
          }
          const sequences = yield* query(
            tx
              .update(rikaHostedThreads)
              .set({ nextEventSequence: expression`${rikaHostedThreads.nextEventSequence} + 1` })
              .where(
                and(eq(rikaHostedThreads.id, assignment.threadId), eq(rikaHostedThreads.ownerId, assignment.ownerId)),
              )
              .returning({ sequence: expression<string>`(${rikaHostedThreads.nextEventSequence} - 1)::text` }),
          )
          const sequence = Sequence.make(sequences[0]!.sequence)
          const commitCursor = yield* allocateCommitCursor(tx, assignment.ownerId)
          const rows = yield* query(
            tx
              .insert(rikaHostedThreadEvents)
              .values({
                ownerId: assignment.ownerId,
                threadId: assignment.threadId,
                eventId: input.eventId,
                idempotencyKey: input.idempotencyKey,
                assignmentId: input.assignmentId,
                executorInstanceId: input.executorInstanceId,
                assignmentGeneration: expression<number>`${input.assignmentGeneration}::bigint`,
                leaseEpoch: expression<number>`${input.leaseEpoch}::bigint`,
                sequence: expression<number>`${sequence}::bigint`,
                commitCursor: expression<number>`${commitCursor}::bigint`,
                commandSequence:
                  input.commandSequence === null ? null : expression<number>`${input.commandSequence}::bigint`,
                event: input.event,
              })
              .returning(eventFields),
          )
          return yield* decode(ThreadEvent, rows[0])
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const readEvents: StoreService["readEvents"] = Effect.fn("PostgresStore.readEvents")(function* (input) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireThreadAccess(tx, input, "thread:view")
          const rows = yield* query(
            tx
              .select(eventFields)
              .from(rikaHostedThreadEvents)
              .where(
                and(
                  eq(rikaHostedThreadEvents.ownerId, input.ownerId),
                  eq(rikaHostedThreadEvents.threadId, input.threadId),
                  gt(rikaHostedThreadEvents.commitCursor, expression<number>`${input.afterCommitCursor}::bigint`),
                ),
              )
              .orderBy(asc(rikaHostedThreadEvents.commitCursor))
              .limit(limit(input.limit)),
          )
          return yield* Effect.forEach(rows, (row) => decode(ThreadEvent, row))
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const acknowledgeCursor: StoreService["acknowledgeCursor"] = Effect.fn("PostgresStore.acknowledgeCursor")(
    function* (input) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* requireThreadAccess(tx, input, "thread:view", input.now)
            const events = yield* query(
              tx
                .select({ present: expression<number>`1` })
                .from(rikaHostedThreadEvents)
                .where(
                  and(
                    eq(rikaHostedThreadEvents.ownerId, input.ownerId),
                    eq(rikaHostedThreadEvents.threadId, input.threadId),
                    eq(rikaHostedThreadEvents.commitCursor, expression<number>`${input.commitCursor}::bigint`),
                  ),
                ),
            )
            if (events[0] === undefined)
              return yield* failure("conflict", "Cursor must reference a persisted thread event")
            const rows = yield* query(
              tx
                .insert(rikaHostedClientCursors)
                .values({
                  ownerId: input.ownerId,
                  threadId: input.threadId,
                  actor: input.actor,
                  commitCursor: expression`${input.commitCursor}::bigint`,
                  updatedAt: timestamp(input.now),
                })
                .onConflictDoUpdate({
                  target: [rikaHostedClientCursors.threadId, rikaHostedClientCursors.actor],
                  set: {
                    commitCursor: expression`greatest(${rikaHostedClientCursors.commitCursor}, excluded.commit_cursor)`,
                    updatedAt: expression`excluded.updated_at`,
                  },
                  setWhere: eq(rikaHostedClientCursors.ownerId, expression<string>`excluded.owner_id`),
                })
                .returning({
                  ownerId: rikaHostedClientCursors.ownerId,
                  threadId: rikaHostedClientCursors.threadId,
                  actor: rikaHostedClientCursors.actor,
                  commitCursor: expression<string>`${rikaHostedClientCursors.commitCursor}::text`,
                  updatedAt: timestampText(rikaHostedClientCursors.updatedAt),
                }),
            )
            return yield* decode(ResumableCursor, rows[0])
          }),
        )
        .pipe(Effect.catchTag("SqlError", databaseError))
    },
  )

  const acquireTerminalWriter = Effect.fn("PostgresStore.acquireTerminalWriter")(function* (
    input: AcquireTerminalWriterInput,
  ) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireThreadAccess(tx, input, "terminal:input", input.now)
          const rows = yield* query(
            tx
              .insert(rikaHostedTerminalWriterLeases)
              .values({
                ownerId: input.ownerId,
                threadId: input.threadId,
                actor: input.actor,
                leaseId: input.leaseId,
                generation: 1,
                acquiredAt: timestamp(input.now),
                renewedAt: timestamp(input.now),
                expiresAt: timestamp(input.expiresAt),
              })
              .onConflictDoUpdate({
                target: rikaHostedTerminalWriterLeases.threadId,
                set: {
                  ownerId: expression`excluded.owner_id`,
                  actor: expression`excluded.actor`,
                  leaseId: expression`excluded.lease_id`,
                  generation: expression`${rikaHostedTerminalWriterLeases.generation} + 1`,
                  acquiredAt: expression`excluded.acquired_at`,
                  renewedAt: expression`excluded.renewed_at`,
                  expiresAt: expression`excluded.expires_at`,
                },
                setWhere: and(
                  eq(rikaHostedTerminalWriterLeases.ownerId, expression<string>`excluded.owner_id`),
                  lte(rikaHostedTerminalWriterLeases.expiresAt, timestamp(input.now)),
                )!,
              })
              .returning({
                ownerId: rikaHostedTerminalWriterLeases.ownerId,
                threadId: rikaHostedTerminalWriterLeases.threadId,
                actor: rikaHostedTerminalWriterLeases.actor,
                leaseId: rikaHostedTerminalWriterLeases.leaseId,
                generation: expression<string>`${rikaHostedTerminalWriterLeases.generation}::text`,
                acquiredAt: timestampText(rikaHostedTerminalWriterLeases.acquiredAt),
                renewedAt: timestampText(rikaHostedTerminalWriterLeases.renewedAt),
                expiresAt: timestampText(rikaHostedTerminalWriterLeases.expiresAt),
              }),
          )
          if (rows[0] === undefined)
            return yield* failure("lease-unavailable", "Thread already has an active terminal writer")
          return yield* decode(TerminalWriterLease, rows[0])
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const renewTerminalWriter = Effect.fn("PostgresStore.renewTerminalWriter")(function* (
    input: RenewTerminalWriterInput,
  ) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireThreadAccess(tx, input, "terminal:input", input.now)
          const rows = yield* query(
            tx
              .update(rikaHostedTerminalWriterLeases)
              .set({ renewedAt: timestamp(input.now), expiresAt: timestamp(input.expiresAt) })
              .where(
                and(
                  eq(rikaHostedTerminalWriterLeases.ownerId, input.ownerId),
                  eq(rikaHostedTerminalWriterLeases.threadId, input.threadId),
                  eq(rikaHostedTerminalWriterLeases.actor, input.actor),
                  eq(rikaHostedTerminalWriterLeases.leaseId, input.leaseId),
                  eq(rikaHostedTerminalWriterLeases.generation, expression<number>`${input.generation}::bigint`),
                  gt(rikaHostedTerminalWriterLeases.expiresAt, timestamp(input.now)),
                ),
              )
              .returning({
                ownerId: rikaHostedTerminalWriterLeases.ownerId,
                threadId: rikaHostedTerminalWriterLeases.threadId,
                actor: rikaHostedTerminalWriterLeases.actor,
                leaseId: rikaHostedTerminalWriterLeases.leaseId,
                generation: expression<string>`${rikaHostedTerminalWriterLeases.generation}::text`,
                acquiredAt: timestampText(rikaHostedTerminalWriterLeases.acquiredAt),
                renewedAt: timestampText(rikaHostedTerminalWriterLeases.renewedAt),
                expiresAt: timestampText(rikaHostedTerminalWriterLeases.expiresAt),
              }),
          )
          if (rows[0] === undefined) return yield* failure("stale-fence", "Terminal writer lease is expired or fenced")
          return yield* decode(TerminalWriterLease, rows[0])
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const upsertPresence = Effect.fn("PostgresStore.upsertPresence")(function* (input: UpsertPresenceInput) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireThreadAccess(tx, input, "presence:update", input.now)
          const rows = yield* query(
            tx
              .insert(rikaHostedPresence)
              .values({
                ownerId: input.ownerId,
                threadId: input.threadId,
                actor: input.actor,
                status: input.status,
                lastSeenAt: timestamp(input.now),
                expiresAt: timestamp(input.expiresAt),
              })
              .onConflictDoUpdate({
                target: [rikaHostedPresence.threadId, rikaHostedPresence.actor],
                set: {
                  status: expression`excluded.status`,
                  lastSeenAt: expression`excluded.last_seen_at`,
                  expiresAt: expression`excluded.expires_at`,
                },
                setWhere: eq(rikaHostedPresence.ownerId, expression<string>`excluded.owner_id`),
              })
              .returning({
                ownerId: rikaHostedPresence.ownerId,
                threadId: rikaHostedPresence.threadId,
                actor: rikaHostedPresence.actor,
                status: rikaHostedPresence.status,
                lastSeenAt: timestampText(rikaHostedPresence.lastSeenAt),
                expiresAt: timestampText(rikaHostedPresence.expiresAt),
              }),
          )
          return yield* decode(Presence, rows[0])
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const listPresence: StoreService["listPresence"] = Effect.fn("PostgresStore.listPresence")(function* (input) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireThreadAccess(tx, input, "presence:view", input.now)
          const rows = yield* query(
            tx
              .select({
                ownerId: rikaHostedPresence.ownerId,
                threadId: rikaHostedPresence.threadId,
                actor: rikaHostedPresence.actor,
                status: rikaHostedPresence.status,
                lastSeenAt: timestampText(rikaHostedPresence.lastSeenAt),
                expiresAt: timestampText(rikaHostedPresence.expiresAt),
              })
              .from(rikaHostedPresence)
              .where(
                and(
                  eq(rikaHostedPresence.ownerId, input.ownerId),
                  eq(rikaHostedPresence.threadId, input.threadId),
                  gt(rikaHostedPresence.expiresAt, timestamp(input.now)),
                ),
              )
              .orderBy(asc(rikaHostedPresence.actor)),
          )
          return yield* Effect.forEach(rows, (row) => decode(Presence, row))
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const recordAuditEvent = Effect.fn("PostgresStore.recordAuditEvent")(function* (input: RecordAuditEventInput) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireActiveClient(tx, input, input.occurredAt)
          const commitCursor = yield* allocateCommitCursor(tx, input.ownerId)
          const rows = yield* query(
            tx
              .insert(rikaHostedAuditEvents)
              .values({
                id: input.id,
                ownerId: input.ownerId,
                actor: input.actor,
                action: input.action,
                resourceKind: input.resourceKind,
                resourceId: input.resourceId,
                commitCursor: expression`${commitCursor}::bigint`,
                attributes: input.attributes,
                occurredAt: timestamp(input.occurredAt),
              })
              .returning({
                id: rikaHostedAuditEvents.id,
                ownerId: rikaHostedAuditEvents.ownerId,
                actor: rikaHostedAuditEvents.actor,
                action: rikaHostedAuditEvents.action,
                resourceKind: rikaHostedAuditEvents.resourceKind,
                resourceId: rikaHostedAuditEvents.resourceId,
                commitCursor: expression<string>`${rikaHostedAuditEvents.commitCursor}::text`,
                attributes: rikaHostedAuditEvents.attributes,
                occurredAt: timestampText(rikaHostedAuditEvents.occurredAt),
              }),
          )
          return yield* decode(AuditEvent, rows[0])
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const putCredentialReference = Effect.fn("PostgresStore.putCredentialReference")(function* (
    input: PutCredentialReferenceInput,
  ) {
    const rows = yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireOwnerCreator(tx, { ownerId: input.ownerId, userId: input.createdByUserId })
          if (input.projectId !== undefined) {
            const project = yield* query(
              tx
                .select({ present: expression<number>`1` })
                .from(rikaHostedProjects)
                .where(and(eq(rikaHostedProjects.ownerId, input.ownerId), eq(rikaHostedProjects.id, input.projectId))),
            )
            if (project[0] === undefined)
              return yield* failure("not-found", "Credential project does not exist for the owner")
          }
          return yield* query(
            tx
              .insert(rikaHostedCredentialReferences)
              .values({
                id: input.id,
                ownerId: input.ownerId,
                projectId: input.projectId ?? null,
                provider: input.provider,
                purpose: input.purpose,
                externalReference: input.externalReference,
                metadata: input.metadata,
                createdByUserId: input.createdByUserId,
                createdAt: timestamp(input.now),
                updatedAt: timestamp(input.now),
              })
              .onConflictDoUpdate({
                target: rikaHostedCredentialReferences.id,
                set: {
                  purpose: expression`excluded.purpose`,
                  externalReference: expression`excluded.external_reference`,
                  metadata: expression`excluded.metadata`,
                  updatedAt: expression`excluded.updated_at`,
                },
                setWhere: and(
                  eq(rikaHostedCredentialReferences.ownerId, expression<string>`excluded.owner_id`),
                  expression`${rikaHostedCredentialReferences.projectId} is not distinct from excluded.project_id`,
                  eq(rikaHostedCredentialReferences.provider, expression<string>`excluded.provider`),
                  eq(rikaHostedCredentialReferences.createdByUserId, expression<string>`excluded.created_by_user_id`),
                )!,
              })
              .returning({
                id: rikaHostedCredentialReferences.id,
                ownerId: rikaHostedCredentialReferences.ownerId,
                projectId: rikaHostedCredentialReferences.projectId,
                provider: rikaHostedCredentialReferences.provider,
                purpose: rikaHostedCredentialReferences.purpose,
                externalReference: rikaHostedCredentialReferences.externalReference,
                metadata: rikaHostedCredentialReferences.metadata,
                createdByUserId: rikaHostedCredentialReferences.createdByUserId,
                createdAt: timestampText(rikaHostedCredentialReferences.createdAt),
                updatedAt: timestampText(rikaHostedCredentialReferences.updatedAt),
              }),
          )
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
    if (rows[0] === undefined)
      return yield* failure("invalid-authority", "Credential reference identity cannot be reassigned")
    const row = yield* decode(CredentialReferenceRow, rows[0])
    const reference = {
      id: row.id,
      ownerId: row.ownerId,
      provider: row.provider,
      purpose: row.purpose,
      externalReference: row.externalReference,
      metadata: row.metadata,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
    return yield* decode(
      CredentialReference,
      row.projectId === null ? reference : { ...reference, projectId: row.projectId },
    )
  })

  return HostedStore.of({
    putOwner,
    createProject,
    putProjectGrant,
    createWorkspace,
    createThread,
    readThread,
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
    recordAuditEvent,
    putCredentialReference,
  })
})

export const layer = Layer.effect(HostedStore, make)
