import { rikaHostedExecutorKind, rikaHostedAssignmentLifecycle, rikaHostedRunnerOperationState } from "./hosted-enums"
import {
  pgTable,
  text,
  bigint,
  timestamp,
  boolean,
  jsonb,
  uniqueIndex,
  index,
  foreignKey,
  primaryKey,
  unique,
  check,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { SchemaReference } from "../reference"

export const rikaHostedCheckpoints = pgTable(
  "rika_hosted_checkpoints",
  {
    id: text().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    assignmentId: text("assignment_id").notNull(),
    executorInstanceId: text("executor_instance_id").notNull(),
    assignmentGeneration: bigint("assignment_generation", { mode: "number" }).notNull(),
    leaseEpoch: bigint("lease_epoch", { mode: "number" }).notNull(),
    objectKey: text("object_key").notNull(),
    contentDigest: text("content_digest").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    format: text().notNull(),
    cursorSequence: bigint("cursor_sequence", { mode: "number" }).notNull(),
    cursorValue: text("cursor_value").notNull(),
    metadata: jsonb().notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.assignmentId, table.ownerId],
      foreignColumns: [rikaHostedExecutorAssignments.id, rikaHostedExecutorAssignments.ownerId],
      name: "rika_hosted_checkpoints_assignment_id_owner_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [
        SchemaReference.column("rikaHostedThreads", "id"),
        SchemaReference.column("rikaHostedThreads", "ownerId"),
      ],
      name: "rika_hosted_checkpoints_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_checkpoints_latest").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.threadId.asc().nullsLast(),
      table.cursorSequence.desc().nullsFirst(),
      table.verifiedAt.desc().nullsFirst(),
    ),
    check("rika_hosted_checkpoints_assignment_generation_check", sql`(assignment_generation >= 1)`),
    check("rika_hosted_checkpoints_content_digest_check", sql`(content_digest ~ '^sha256:[a-f0-9]{64}$'::text)`),
    check("rika_hosted_checkpoints_cursor_sequence_check", sql`(cursor_sequence >= 0)`),
    check("rika_hosted_checkpoints_format_check", sql`(format = 'tar.zst'::text)`),
    check("rika_hosted_checkpoints_lease_epoch_check", sql`(lease_epoch >= 1)`),
    check(
      "rika_hosted_checkpoints_metadata_check",
      sql`((jsonb_typeof(metadata) = 'object'::text) AND ((metadata)::text !~* '"(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|private[_-]?key|authorization|cookie)"[[:space:]]*:'::text))`,
    ),
    check("rika_hosted_checkpoints_object_key_check", sql`(length(object_key) > 0)`),
    check("rika_hosted_checkpoints_size_bytes_check", sql`(size_bytes > 0)`),
  ],
)
export const rikaHostedExecutorAssignments = pgTable(
  "rika_hosted_executor_assignments",
  {
    id: text().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    executorKind: rikaHostedExecutorKind("executor_kind").notNull(),
    placement: jsonb().notNull(),
    checkout: jsonb(),
    workspaceSeed: jsonb("workspace_seed"),
    generation: bigint({ mode: "number" }).notNull(),
    revision: bigint({ mode: "number" }).default(0).notNull(),
    lastLeaseEpoch: bigint("last_lease_epoch", { mode: "number" }).default(0).notNull(),
    lifecycle: rikaHostedAssignmentLifecycle().notNull(),
    providerInstanceId: text("provider_instance_id"),
    bootstrapDigest: text("bootstrap_digest"),
    bootstrapExpiresAt: timestamp("bootstrap_expires_at", { withTimezone: true }),
    executorInstanceId: text("executor_instance_id"),
    processIncarnation: text("process_incarnation"),
    sessionDigest: text("session_digest"),
    leaseEpoch: bigint("lease_epoch", { mode: "number" }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    cursorSequence: bigint("cursor_sequence", { mode: "number" }).default(0).notNull(),
    cursorValue: text("cursor_value").default("").notNull(),
    latestCheckpointId: text("latest_checkpoint_id"),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    workspaceId: text("workspace_id").notNull(),
    capabilityGeneration: bigint("capability_generation", { mode: "number" }),
    capabilitySnapshot: jsonb("capability_snapshot"),
  },
  (table) => [
    foreignKey({
      columns: [table.threadId, table.ownerId, table.executorKind],
      foreignColumns: [
        SchemaReference.column("rikaHostedThreads", "id"),
        SchemaReference.column("rikaHostedThreads", "ownerId"),
        SchemaReference.column("rikaHostedThreads", "executorKind"),
      ],
      name: "rika_hosted_executor_assignme_thread_id_owner_id_executor__fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.threadId, table.ownerId, table.workspaceId],
      foreignColumns: [
        SchemaReference.column("rikaHostedThreads", "id"),
        SchemaReference.column("rikaHostedThreads", "ownerId"),
        SchemaReference.column("rikaHostedThreads", "workspaceId"),
      ],
      name: "rika_hosted_executor_assignments_workspace_authority",
    }).onDelete("cascade"),
    index("rika_hosted_executor_assignments_expiry")
      .using(
        "btree",
        table.leaseExpiresAt.asc().nullsLast(),
        table.ownerId.asc().nullsLast(),
        table.threadId.asc().nullsLast(),
      )
      .where(sql`(lifecycle = 'active'::rika_hosted_assignment_lifecycle)`),
    index("rika_hosted_executor_assignments_provider").using(
      "btree",
      table.executorKind.asc().nullsLast(),
      table.lifecycle.asc().nullsLast(),
      table.providerInstanceId.asc().nullsLast(),
    ),
    unique("rika_hosted_executor_assignments_id_owner_id_key").on(table.id, table.ownerId),
    unique("rika_hosted_executor_assignments_thread_id_key").on(table.threadId),
    check(
      "rika_hosted_executor_assignments_capability_fence",
      sql`(((capability_generation IS NULL) AND (capability_snapshot IS NULL)) OR ((capability_generation = generation) AND (capability_snapshot IS NOT NULL)))`,
    ),
    check(
      "rika_hosted_executor_assignments_check",
      sql`(((executor_kind = 'runner'::rika_hosted_executor_kind) AND ((placement ->> '_tag'::text) = 'RunnerPlacement'::text)) OR ((executor_kind = 'orb'::rika_hosted_executor_kind) AND ((placement ->> '_tag'::text) = 'OrbPlacement'::text)))`,
    ),
    check("rika_hosted_executor_assignments_check1", sql`((lease_epoch IS NULL) OR (last_lease_epoch >= lease_epoch))`),
    check(
      "rika_hosted_executor_assignments_check2",
      sql`(((lifecycle = 'pending'::rika_hosted_assignment_lifecycle) AND (provider_instance_id IS NULL) AND (bootstrap_digest IS NULL) AND (bootstrap_expires_at IS NULL) AND (executor_instance_id IS NULL) AND (process_incarnation IS NULL) AND (session_digest IS NULL) AND (lease_epoch IS NULL) AND (lease_expires_at IS NULL)) OR ((lifecycle = 'provisioning'::rika_hosted_assignment_lifecycle) AND (bootstrap_digest IS NOT NULL) AND (bootstrap_expires_at IS NOT NULL) AND (executor_instance_id IS NULL) AND (process_incarnation IS NULL) AND (session_digest IS NULL) AND (lease_epoch IS NULL) AND (lease_expires_at IS NULL)) OR ((lifecycle = 'awaiting_bootstrap'::rika_hosted_assignment_lifecycle) AND (provider_instance_id IS NOT NULL) AND (bootstrap_digest IS NOT NULL) AND (bootstrap_expires_at IS NOT NULL) AND (executor_instance_id IS NULL) AND (process_incarnation IS NULL) AND (session_digest IS NULL) AND (lease_epoch IS NULL) AND (lease_expires_at IS NULL)) OR ((lifecycle = 'active'::rika_hosted_assignment_lifecycle) AND (provider_instance_id IS NOT NULL) AND (bootstrap_digest IS NULL) AND (bootstrap_expires_at IS NULL) AND (executor_instance_id IS NOT NULL) AND (process_incarnation IS NOT NULL) AND (session_digest IS NOT NULL) AND (lease_epoch IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((lifecycle = 'paused'::rika_hosted_assignment_lifecycle) AND (provider_instance_id IS NOT NULL) AND (bootstrap_digest IS NULL) AND (bootstrap_expires_at IS NULL) AND (executor_instance_id IS NULL) AND (process_incarnation IS NULL) AND (session_digest IS NULL) AND (lease_epoch IS NULL) AND (lease_expires_at IS NULL)) OR ((lifecycle = 'terminated'::rika_hosted_assignment_lifecycle) AND (bootstrap_digest IS NULL) AND (bootstrap_expires_at IS NULL) AND (executor_instance_id IS NULL) AND (process_incarnation IS NULL) AND (session_digest IS NULL) AND (lease_epoch IS NULL) AND (lease_expires_at IS NULL)))`,
    ),
    check(
      "rika_hosted_executor_assignments_checkout_check",
      sql`((checkout IS NULL) OR ((executor_kind = 'orb'::rika_hosted_executor_kind) AND (checkout ?& ARRAY['ownerId'::text, 'projectId'::text, 'repositoryId'::text, 'installationId'::text, 'owner'::text, 'name'::text, 'ref'::text, 'commitSha'::text, 'private'::text, 'gitIdentity'::text]) AND (jsonb_typeof(checkout) = 'object'::text) AND ((checkout ->> 'ownerId'::text) = owner_id) AND (length((checkout ->> 'projectId'::text)) > 0) AND (length((checkout ->> 'repositoryId'::text)) > 0) AND (length((checkout ->> 'installationId'::text)) > 0) AND (length((checkout ->> 'owner'::text)) > 0) AND (length((checkout ->> 'name'::text)) > 0) AND (length((checkout ->> 'ref'::text)) > 0) AND ((checkout ->> 'commitSha'::text) ~ '^[a-f0-9]{40}$'::text) AND (jsonb_typeof((checkout -> 'private'::text)) = 'boolean'::text) AND (jsonb_typeof((checkout -> 'gitIdentity'::text)) = 'object'::text) AND ((checkout -> 'gitIdentity'::text) ?& ARRAY['name'::text, 'email'::text]) AND ((length(((checkout -> 'gitIdentity'::text) ->> 'name'::text)) >= 1) AND (length(((checkout -> 'gitIdentity'::text) ->> 'name'::text)) <= 256)) AND (((checkout -> 'gitIdentity'::text) ->> 'email'::text) ~ '^[^[:space:]@]+@[^[:space:]@]+$'::text)))`,
    ),
    check("rika_hosted_executor_assignments_cursor_sequence_check", sql`(cursor_sequence >= 0)`),
    check("rika_hosted_executor_assignments_generation_check", sql`(generation >= 1)`),
    check("rika_hosted_executor_assignments_last_lease_epoch_check", sql`(last_lease_epoch >= 0)`),
    check("rika_hosted_executor_assignments_lease_epoch_check", sql`(lease_epoch >= 1)`),
    check(
      "rika_hosted_executor_assignments_placement_check",
      sql`((jsonb_typeof(placement) = 'object'::text) AND ((placement ->> '_tag'::text) = ANY (ARRAY['RunnerPlacement'::text, 'OrbPlacement'::text])))`,
    ),
    check("rika_hosted_executor_assignments_revision_check", sql`(revision >= 0)`),
    check(
      "rika_hosted_executor_credentials_short_lived",
      sql`(((bootstrap_expires_at IS NULL) OR (bootstrap_expires_at <= (updated_at + '00:05:00'::interval))) AND ((lease_expires_at IS NULL) OR (lease_expires_at <= (updated_at + '00:05:00'::interval))))`,
    ),
  ],
)
export const rikaHostedWorkspaceSeeds = pgTable(
  "rika_hosted_workspace_seeds",
  {
    id: text().primaryKey(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdByDeviceId: text("created_by_device_id").notNull(),
    createdByClientId: text("created_by_client_id").notNull(),
    manifest: jsonb().notNull(),
    claimedAssignmentId: text("claimed_assignment_id").references(() => rikaHostedExecutorAssignments.id, {
      onDelete: "cascade",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    unique("rika_hosted_workspace_seeds_claimed_assignment_id_key").on(table.claimedAssignmentId),
    index("rika_hosted_workspace_seeds_expiry").using("btree", table.expiresAt.asc().nullsLast()),
    check("rika_hosted_workspace_seeds_expiry_check", sql`(expires_at > created_at)`),
    check(
      "rika_hosted_workspace_seeds_manifest_check",
      sql`((jsonb_typeof(manifest) = 'object'::text) AND ((manifest ->> 'id'::text) = id))`,
    ),
  ],
)
export const rikaHostedExecutorOperationFrames = pgTable(
  "rika_hosted_executor_operation_frames",
  {
    assignmentId: text("assignment_id").notNull(),
    operationKey: text("operation_key").notNull(),
    attempt: bigint({ mode: "number" }).notNull(),
    cursor: bigint({ mode: "number" }).notNull(),
    kind: text().notNull(),
    frame: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.assignmentId, table.operationKey, table.attempt, table.cursor],
      name: "rika_hosted_executor_operation_frames_pkey",
    }),
    foreignKey({
      columns: [table.assignmentId, table.operationKey, table.attempt],
      foreignColumns: [
        rikaHostedExecutorOperations.assignmentId,
        rikaHostedExecutorOperations.operationKey,
        rikaHostedExecutorOperations.attempt,
      ],
      name: "rika_hosted_executor_operatio_assignment_id_operation_key__fkey",
    }).onDelete("cascade"),
    uniqueIndex("rika_hosted_executor_operation_terminal_receipt")
      .using(
        "btree",
        table.assignmentId.asc().nullsLast(),
        table.operationKey.asc().nullsLast(),
        table.attempt.asc().nullsLast(),
      )
      .where(sql`(kind = 'Terminal'::text)`),
    check("rika_hosted_executor_operation_frames_attempt_check", sql`(attempt >= 0)`),
    check("rika_hosted_executor_operation_frames_cursor_check", sql`(cursor >= 1)`),
    check(
      "rika_hosted_executor_operation_frames_kind_check",
      sql`(kind = ANY (ARRAY['Accepted'::text, 'Started'::text, 'Output'::text, 'Terminal'::text]))`,
    ),
  ],
)
export const rikaHostedExecutorOperations = pgTable(
  "rika_hosted_executor_operations",
  {
    assignmentId: text("assignment_id").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
    operationKey: text("operation_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    code: text().notNull(),
    attempt: bigint({ mode: "number" }).default(0).notNull(),
    state: rikaHostedRunnerOperationState().default("accepted").notNull(),
    dispatchedGeneration: bigint("dispatched_generation", { mode: "number" }),
    dispatchedLeaseEpoch: bigint("dispatched_lease_epoch", { mode: "number" }),
    dispatchedExecutorInstanceId: text("dispatched_executor_instance_id"),
    dispatchedProcessIncarnation: text("dispatched_process_incarnation"),
    response: jsonb(),
    terminalOutcome: text("terminal_outcome"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    workspaceId: text("workspace_id").notNull(),
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedThreads", "id"), { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    runId: text("run_id").notNull(),
    rootRunId: text("root_run_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    admittedAt: text("admitted_at"),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    replayPolicy: text("replay_policy").$type<"pure" | "provider-idempotent" | "never">().default("never").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      columns: [table.assignmentId, table.operationKey, table.attempt],
      name: "rika_hosted_executor_operations_pkey",
    }),
    foreignKey({
      columns: [table.assignmentId, table.ownerId],
      foreignColumns: [rikaHostedExecutorAssignments.id, rikaHostedExecutorAssignments.ownerId],
      name: "rika_hosted_executor_operations_assignment_id_owner_id_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_executor_operations_recovery")
      .using("btree", table.state.asc().nullsLast(), table.deadlineAt.asc().nullsLast())
      .where(sql`(state = 'dispatched'::rika_hosted_runner_operation_state)`),
    unique("rika_hosted_executor_operations_attempt").on(table.assignmentId, table.operationKey, table.attempt),
    check("rika_hosted_executor_operations_attempt_check", sql`(attempt >= 0)`),
    check(
      "rika_hosted_executor_operations_check",
      sql`(((state = ANY (ARRAY['accepted'::rika_hosted_runner_operation_state, 'dispatched'::rika_hosted_runner_operation_state])) AND (response IS NULL) AND (terminal_outcome IS NULL)) OR ((state = 'completed'::rika_hosted_runner_operation_state) AND (response IS NOT NULL) AND (terminal_outcome = ANY (ARRAY['completed'::text, 'failed'::text, 'cancelled'::text]))) OR ((state = 'unknown'::rika_hosted_runner_operation_state) AND (response IS NOT NULL) AND (terminal_outcome = 'unknown'::text)))`,
    ),
    check(
      "rika_hosted_executor_operations_check1",
      sql`(((state = 'dispatched'::rika_hosted_runner_operation_state) AND (dispatched_generation IS NOT NULL) AND (dispatched_lease_epoch IS NOT NULL)) OR (state <> 'dispatched'::rika_hosted_runner_operation_state))`,
    ),
    check(
      "rika_hosted_executor_operations_check2",
      sql`((state <> ALL (ARRAY['dispatched'::rika_hosted_runner_operation_state, 'unknown'::rika_hosted_runner_operation_state])) OR ((dispatched_generation IS NOT NULL) AND (dispatched_lease_epoch IS NOT NULL) AND (dispatched_executor_instance_id IS NOT NULL) AND (dispatched_process_incarnation IS NOT NULL)))`,
    ),
    check(
      "rika_hosted_executor_operations_replay_policy_check",
      sql`(replay_policy = ANY (ARRAY['pure'::text, 'provider-idempotent'::text, 'never'::text]))`,
    ),
    check("rika_hosted_executor_operations_root_run_id_check", sql`(length(root_run_id) > 0)`),
    check("rika_hosted_executor_operations_run_id_check", sql`(length(run_id) > 0)`),
    check("rika_hosted_executor_operations_session_id_check", sql`(length(session_id) > 0)`),
    check(
      "rika_hosted_executor_operations_terminal_outcome_check",
      sql`(terminal_outcome = ANY (ARRAY['completed'::text, 'failed'::text, 'cancelled'::text, 'unknown'::text]))`,
    ),
    check("rika_hosted_executor_operations_thread_id_check", sql`(length(thread_id) > 0)`),
    check("rika_hosted_executor_operations_tool_call_id_check", sql`(length(tool_call_id) > 0)`),
    check("rika_hosted_executor_operations_turn_id_check", sql`(length(turn_id) > 0)`),
    check("rika_hosted_executor_operations_workspace_id_check", sql`(length(workspace_id) > 0)`),
  ],
)
export const rikaHostedRunnerAdmissions = pgTable(
  "rika_hosted_runner_admissions",
  {
    id: text().primaryKey(),
    assignmentId: text("assignment_id").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    clientId: text("client_id").notNull(),
    userId: text("user_id").notNull(),
    processIncarnation: text("process_incarnation"),
    generation: bigint({ mode: "number" }).notNull(),
    workspaceFingerprint: text("workspace_fingerprint").notNull(),
    ticketDigest: text("ticket_digest").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.assignmentId, table.ownerId],
      foreignColumns: [rikaHostedExecutorAssignments.id, rikaHostedExecutorAssignments.ownerId],
      name: "rika_hosted_runner_admissions_assignment_id_owner_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.clientId, table.userId],
      foreignColumns: [
        SchemaReference.column("rikaHostedClients", "id"),
        SchemaReference.column("rikaHostedClients", "userId"),
      ],
      name: "rika_hosted_runner_admissions_client_id_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.deviceId, table.userId],
      foreignColumns: [
        SchemaReference.column("rikaHostedDevices", "id"),
        SchemaReference.column("rikaHostedDevices", "userId"),
      ],
      name: "rika_hosted_runner_admissions_device_id_user_id_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_runner_admissions_binding")
      .using(
        "btree",
        table.assignmentId.asc().nullsLast(),
        table.deviceId.asc().nullsLast(),
        table.clientId.asc().nullsLast(),
        table.generation.asc().nullsLast(),
      )
      .where(sql`(consumed_at IS NOT NULL)`),
    check("rika_hosted_runner_admissions_check", sql`(expires_at > created_at)`),
    check("rika_hosted_runner_admissions_generation_check", sql`(generation >= 1)`),
    check("rika_hosted_runner_admissions_short_lived", sql`(expires_at <= (created_at + '00:05:00'::interval))`),
    check(
      "rika_hosted_runner_admissions_workspace_fingerprint_check",
      sql`((length(workspace_fingerprint) >= 1) AND (length(workspace_fingerprint) <= 512))`,
    ),
  ],
)
export const rikaHostedRunnerRegistrations = pgTable(
  "rika_hosted_runner_registrations",
  {
    deviceId: text("device_id").notNull(),
    userId: text("user_id").notNull(),
    checkoutFingerprint: text("checkout_fingerprint").notNull(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id"),
    repository: jsonb().notNull(),
    nativeToolRuntime: jsonb("native_tool_runtime").notNull(),
    capabilities: jsonb().notNull(),
    remoteThreadCreationAllowed: boolean("remote_thread_creation_allowed").default(false).notNull(),
    supervisorId: text("supervisor_id"),
    supervisorExpiresAt: timestamp("supervisor_expires_at", { withTimezone: true }),
    registeredAt: timestamp("registered_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.checkoutFingerprint], name: "rika_hosted_runner_registrations_pkey" }),
    foreignKey({
      columns: [table.deviceId, table.userId],
      foreignColumns: [
        SchemaReference.column("rikaHostedDevices", "id"),
        SchemaReference.column("rikaHostedDevices", "userId"),
      ],
      name: "rika_hosted_runner_registrations_device_id_user_id_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_runner_registration_user").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.deviceId.asc().nullsLast(),
      table.checkoutFingerprint.asc().nullsLast(),
    ),
    check("rika_hosted_runner_registrations_capabilities_check", sql`(jsonb_typeof(capabilities) = 'object'::text)`),
    check(
      "rika_hosted_runner_registrations_checkout_fingerprint_check",
      sql`((length(checkout_fingerprint) >= 1) AND (length(checkout_fingerprint) <= 512))`,
    ),
    check(
      "rika_hosted_runner_registrations_native_tool_runtime_check",
      sql`(jsonb_typeof(native_tool_runtime) = 'object'::text)`,
    ),
    check("rika_hosted_runner_registrations_repository_check", sql`(jsonb_typeof(repository) = 'object'::text)`),
    check("rika_hosted_runner_supervisor_pair", sql`((supervisor_id IS NULL) = (supervisor_expires_at IS NULL))`),
  ],
)
export const rikaHostedTerminalWriterLeases = pgTable(
  "rika_hosted_terminal_writer_leases",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
    threadId: text("thread_id").primaryKey(),
    actor: jsonb().notNull(),
    leaseId: text("lease_id").notNull(),
    generation: bigint({ mode: "number" }).notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
    renewedAt: timestamp("renewed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [
        SchemaReference.column("rikaHostedThreads", "id"),
        SchemaReference.column("rikaHostedThreads", "ownerId"),
      ],
      name: "rika_hosted_terminal_writer_leases_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_terminal_writer_leases_expiry").using(
      "btree",
      table.expiresAt.asc().nullsLast(),
      table.ownerId.asc().nullsLast(),
      table.threadId.asc().nullsLast(),
    ),
    check("rika_hosted_terminal_writer_leases_actor_check", sql`(jsonb_typeof(actor) = 'object'::text)`),
    check("rika_hosted_terminal_writer_leases_check", sql`(expires_at > renewed_at)`),
    check("rika_hosted_terminal_writer_leases_check1", sql`rika_hosted_actor_matches_owner(actor, owner_id)`),
    check("rika_hosted_terminal_writer_leases_generation_check", sql`(generation >= 1)`),
  ],
)

SchemaReference.register("rikaHostedExecutorAssignments", {
  id: rikaHostedExecutorAssignments.id,
  ownerId: rikaHostedExecutorAssignments.ownerId,
})
