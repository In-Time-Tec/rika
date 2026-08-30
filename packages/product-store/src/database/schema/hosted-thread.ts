import { rikaHostedExecutorKind } from "./hosted-enums"
import {
  pgTable,
  text,
  bigint,
  timestamp,
  boolean,
  jsonb,
  index,
  foreignKey,
  primaryKey,
  unique,
  check,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { SchemaReference } from "../reference"

export const rikaHostedThreadProtocolCommands = pgTable(
  "rika_hosted_thread_protocol_commands",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    commandId: text("command_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    expectedVersion: bigint("expected_version", { mode: "number" }).notNull(),
    threadVersion: bigint("thread_version", { mode: "number" }).notNull(),
    commitCursor: bigint("commit_cursor", { mode: "number" }).notNull(),
    actor: jsonb().notNull(),
    command: jsonb().notNull(),
    state: text().notNull(),
    workState: text("work_state"),
    preparedTurnJson: text("prepared_turn_json"),
    result: jsonb(),
    eventCursor: bigint("event_cursor", { mode: "number" }),
    admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    claimToken: text("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    turnId: text("turn_id"),
    admissionStatus: text("admission_status"),
    cancelledByCommandId: text("cancelled_by_command_id"),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.commandId], name: "rika_hosted_thread_protocol_commands_pkey" }),
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [rikaHostedThreadProtocolState.threadId, rikaHostedThreadProtocolState.ownerId],
      name: "rika_hosted_thread_protocol_commands_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    unique("rika_hosted_thread_protocol_commands_owner_id_commit_cursor_key").on(table.ownerId, table.commitCursor),
    unique("rika_hosted_thread_protocol_comma_thread_id_idempotency_key_key").on(table.threadId, table.idempotencyKey),
    unique("rika_hosted_thread_protocol_comman_thread_id_thread_version_key").on(table.threadId, table.threadVersion),
    unique("rika_hosted_thread_protocol_commands_thread_owner_version_key").on(
      table.threadId,
      table.ownerId,
      table.threadVersion,
    ),
    index("rika_hosted_thread_protocol_commands_cursor").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.threadId.asc().nullsLast(),
      table.commitCursor.asc().nullsLast(),
    ),
    index("rika_hosted_thread_protocol_commands_turn")
      .using("btree", table.ownerId.asc().nullsLast(), table.threadId.asc().nullsLast(), table.turnId.asc().nullsLast())
      .where(sql`(turn_id IS NOT NULL)`),
    unique("rika_hosted_thread_protocol_commands_turn_id_key").on(table.turnId),
    check("rika_hosted_thread_protocol_commands_actor_check", sql`(jsonb_typeof(actor) = 'object'::text)`),
    check(
      "rika_hosted_thread_protocol_commands_admission_status_check",
      sql`(admission_status = ANY (ARRAY['accepted'::text, 'queued'::text]))`,
    ),
    check(
      "rika_hosted_thread_protocol_commands_actor_owner_check",
      sql`rika_hosted_actor_matches_owner(actor, owner_id)`,
    ),
    check("rika_hosted_thread_protocol_commands_command_check", sql`(jsonb_typeof(command) = 'object'::text)`),
    check("rika_hosted_thread_protocol_commands_commit_cursor_check", sql`(commit_cursor >= 1)`),
    check("rika_hosted_thread_protocol_commands_event_cursor_check", sql`(event_cursor >= 0)`),
    check("rika_hosted_thread_protocol_commands_expected_version_check", sql`(expected_version >= 0)`),
    check("rika_hosted_thread_protocol_commands_thread_version_check", sql`(thread_version > 0)`),
    check(
      "rika_hosted_thread_protocol_commands_state_check",
      sql`(state = ANY (ARRAY['admitted'::text, 'completed'::text]))`,
    ),
    check(
      "rika_hosted_thread_protocol_commands_result_check",
      sql`(((state = 'admitted') AND result IS NULL AND event_cursor IS NULL AND completed_at IS NULL AND work_state IS NULL AND admission_status IS NULL AND cancelled_by_command_id IS NULL) OR (state = 'completed' AND result IS NOT NULL AND event_cursor IS NOT NULL AND completed_at IS NOT NULL))`,
    ),
    check("rika_hosted_thread_protocol_commands_claim_pair", sql`((claim_token IS NULL) = (claim_expires_at IS NULL))`),
    check(
      "rika_hosted_thread_protocol_commands_claim_state",
      sql`((state = 'admitted') OR (work_state IS NOT NULL) OR (claim_token IS NULL))`,
    ),
    check(
      "rika_hosted_thread_protocol_commands_work_state_check",
      sql`(work_state IS NULL OR work_state = ANY (ARRAY['turn-activation-pending'::text, 'turn-activation-requested'::text]))`,
    ),
    check(
      "rika_hosted_thread_protocol_commands_work_turn_check",
      sql`(work_state IS NULL OR (state = 'completed' AND turn_id IS NOT NULL AND admission_status IS NOT NULL AND prepared_turn_json IS NOT NULL))`,
    ),
    check(
      "rika_hosted_thread_protocol_commands_cancel_check",
      sql`(cancelled_by_command_id IS NULL OR (state = 'completed' AND cancelled_by_command_id <> command_id))`,
    ),
    index("rika_hosted_thread_protocol_commands_claims")
      .on(table.claimExpiresAt)
      .where(sql`(claim_token IS NOT NULL)`),
    index("rika_hosted_thread_protocol_commands_work")
      .on(table.workState, table.completedAt, table.threadId)
      .where(sql`(work_state IS NOT NULL)`),
  ],
)
export const rikaHostedThreadEvents = pgTable(
  "rika_hosted_thread_events",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    eventId: text("event_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    executorInstanceId: text("executor_instance_id").notNull(),
    assignmentId: text("assignment_id").notNull(),
    assignmentGeneration: bigint("assignment_generation", { mode: "number" }).notNull(),
    leaseEpoch: bigint("lease_epoch", { mode: "number" }).notNull(),
    sequence: bigint({ mode: "number" }).notNull(),
    commitCursor: bigint("commit_cursor", { mode: "number" }).notNull(),
    commandSequence: bigint("command_sequence", { mode: "number" }),
    event: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.eventId], name: "rika_hosted_thread_events_pkey" }),
    foreignKey({
      columns: [table.assignmentId, table.ownerId],
      foreignColumns: [
        SchemaReference.column("rikaHostedExecutorAssignments", "id"),
        SchemaReference.column("rikaHostedExecutorAssignments", "ownerId"),
      ],
      name: "rika_hosted_thread_events_assignment_id_owner_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.threadId, table.ownerId, table.commandSequence],
      foreignColumns: [
        rikaHostedThreadProtocolCommands.threadId,
        rikaHostedThreadProtocolCommands.ownerId,
        rikaHostedThreadProtocolCommands.threadVersion,
      ],
      name: "rika_hosted_thread_events_thread_id_owner_id_command_seque_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [rikaHostedThreads.id, rikaHostedThreads.ownerId],
      name: "rika_hosted_thread_events_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_thread_events_cursor").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.threadId.asc().nullsLast(),
      table.commitCursor.asc().nullsLast(),
    ),
    index("rika_hosted_thread_events_sequence").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.threadId.asc().nullsLast(),
      table.sequence.asc().nullsLast(),
    ),
    unique("rika_hosted_thread_events_owner_id_commit_cursor_key").on(table.ownerId, table.commitCursor),
    unique("rika_hosted_thread_events_thread_id_idempotency_key_key").on(table.threadId, table.idempotencyKey),
    unique("rika_hosted_thread_events_thread_id_owner_id_sequence_key").on(
      table.threadId,
      table.ownerId,
      table.sequence,
    ),
    check("rika_hosted_thread_events_assignment_generation_check", sql`(assignment_generation >= 1)`),
    check("rika_hosted_thread_events_commit_cursor_check", sql`(commit_cursor >= 1)`),
    check("rika_hosted_thread_events_event_check", sql`(jsonb_typeof(event) = 'object'::text)`),
    check("rika_hosted_thread_events_lease_epoch_check", sql`(lease_epoch >= 1)`),
    check("rika_hosted_thread_events_sequence_check", sql`(sequence >= 1)`),
  ],
)
export const rikaHostedThreadProtocolCursors = pgTable(
  "rika_hosted_thread_protocol_cursors",
  {
    ownerId: text("owner_id").notNull(),
    threadId: text("thread_id").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedClients", "id"), { onDelete: "cascade" }),
    cursor: bigint({ mode: "number" }).notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.clientId], name: "rika_hosted_thread_protocol_cursors_pkey" }),
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [rikaHostedThreadProtocolState.threadId, rikaHostedThreadProtocolState.ownerId],
      name: "rika_hosted_thread_protocol_cursors_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    check("rika_hosted_thread_protocol_cursors_cursor_check", sql`(cursor >= 0)`),
  ],
)
export const rikaHostedThreadProtocolEvents = pgTable(
  "rika_hosted_thread_protocol_events",
  {
    ownerId: text("owner_id").notNull(),
    threadId: text("thread_id").notNull(),
    sequence: bigint({ mode: "number" }).notNull(),
    cursor: bigint({ mode: "number" }).notNull(),
    threadVersion: bigint("thread_version", { mode: "number" }).notNull(),
    event: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.sequence], name: "rika_hosted_thread_protocol_events_pkey" }),
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [rikaHostedThreadProtocolState.threadId, rikaHostedThreadProtocolState.ownerId],
      name: "rika_hosted_thread_protocol_events_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    unique("rika_hosted_thread_protocol_events_thread_id_cursor_key").on(table.threadId, table.cursor),
    check("rika_hosted_thread_protocol_events_cursor_check", sql`(cursor > 0)`),
    check("rika_hosted_thread_protocol_events_sequence_check", sql`(sequence > 0)`),
    check("rika_hosted_thread_protocol_events_thread_version_check", sql`(thread_version >= 0)`),
  ],
)
export const rikaHostedThreadProtocolSnapshots = pgTable(
  "rika_hosted_thread_protocol_snapshots",
  {
    ownerId: text("owner_id").notNull(),
    threadId: text("thread_id").notNull(),
    threadVersion: bigint("thread_version", { mode: "number" }).notNull(),
    cursor: bigint({ mode: "number" }).notNull(),
    snapshot: jsonb().notNull(),
    replayRequired: boolean("replay_required").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.threadVersion], name: "rika_hosted_thread_protocol_snapshots_pkey" }),
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [rikaHostedThreadProtocolState.threadId, rikaHostedThreadProtocolState.ownerId],
      name: "rika_hosted_thread_protocol_snapshots_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    check("rika_hosted_thread_protocol_snapshots_cursor_check", sql`(cursor >= 0)`),
    check("rika_hosted_thread_protocol_snapshots_thread_version_check", sql`(thread_version >= 0)`),
  ],
)
export const rikaHostedThreadProtocolState = pgTable(
  "rika_hosted_thread_protocol_state",
  {
    ownerId: text("owner_id").notNull(),
    threadId: text("thread_id").primaryKey(),
    version: bigint({ mode: "number" }).default(0).notNull(),
    eventCursor: bigint("event_cursor", { mode: "number" }).default(0).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [rikaHostedThreads.id, rikaHostedThreads.ownerId],
      name: "rika_hosted_thread_protocol_state_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    unique("rika_hosted_thread_protocol_state_thread_id_owner_id_key").on(table.threadId, table.ownerId),
    check("rika_hosted_thread_protocol_state_event_cursor_check", sql`(event_cursor >= 0)`),
    check("rika_hosted_thread_protocol_state_version_check", sql`(version >= 0)`),
  ],
)
export const rikaHostedThreads = pgTable(
  "rika_hosted_threads",
  {
    id: text().primaryKey(),
    archiveSourceThreadId: text("archive_source_thread_id"),
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
    projectId: text("project_id"),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    executorKind: rikaHostedExecutorKind("executor_kind").notNull(),
    inheritProjectGrants: boolean("inherit_project_grants").notNull(),
    nextEventSequence: bigint("next_event_sequence", { mode: "number" }).default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.ownerId, table.projectId, table.executorKind],
      foreignColumns: [
        rikaHostedWorkspaces.id,
        rikaHostedWorkspaces.ownerId,
        rikaHostedWorkspaces.projectId,
        rikaHostedWorkspaces.executorKind,
      ],
      name: "rika_hosted_threads_workspace_id_owner_id_project_id_execu_fkey",
    }).onDelete("restrict"),
    index("rika_hosted_threads_project").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
      table.createdAt.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    unique("rika_hosted_threads_id_owner_id_executor_kind_key").on(table.id, table.ownerId, table.executorKind),
    unique("rika_hosted_threads_id_owner_id_key").on(table.id, table.ownerId),
    unique("rika_hosted_threads_workspace_authority").on(table.id, table.ownerId, table.workspaceId),
    check(
      "rika_hosted_threads_archive_source_check",
      sql`(archive_source_thread_id IS NULL OR archive_source_thread_id <> id)`,
    ),
    check(
      "rika_hosted_threads_check",
      sql`((executor_kind = 'orb'::rika_hosted_executor_kind) OR (inherit_project_grants = false))`,
    ),
    check("rika_hosted_threads_next_event_sequence_check", sql`(next_event_sequence >= 1)`),
  ],
)
export const rikaHostedWorkspaces = pgTable(
  "rika_hosted_workspaces",
  {
    id: text().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
    projectId: text("project_id"),
    createdByUserId: text("created_by_user_id").notNull(),
    executorKind: rikaHostedExecutorKind("executor_kind").notNull(),
    inheritProjectGrants: boolean("inherit_project_grants").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.ownerId],
      foreignColumns: [
        SchemaReference.column("rikaHostedProjects", "id"),
        SchemaReference.column("rikaHostedProjects", "ownerId"),
      ],
      name: "rika_hosted_workspaces_project_id_owner_id_fkey",
    }).onDelete("restrict"),
    index("rika_hosted_workspaces_project").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
      table.createdAt.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    unique("rika_hosted_workspaces_id_owner_id_key").on(table.id, table.ownerId),
    unique("rika_hosted_workspaces_id_owner_id_project_id_executor_kind_key").on(
      table.id,
      table.ownerId,
      table.projectId,
      table.executorKind,
    ),
    check(
      "rika_hosted_workspaces_check",
      sql`((executor_kind = 'orb'::rika_hosted_executor_kind) OR (inherit_project_grants = false))`,
    ),
  ],
)

SchemaReference.register("rikaHostedThreads", {
  executorKind: rikaHostedThreads.executorKind,
  id: rikaHostedThreads.id,
  ownerId: rikaHostedThreads.ownerId,
  workspaceId: rikaHostedThreads.workspaceId,
})
SchemaReference.register("rikaHostedWorkspaces", { id: rikaHostedWorkspaces.id, ownerId: rikaHostedWorkspaces.ownerId })
