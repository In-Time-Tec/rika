import {
  pgEnum,
  pgTable,
  text,
  integer,
  bigint,
  bigserial,
  timestamp,
  doublePrecision,
  boolean,
  jsonb,
  customType,
  uniqueIndex,
  index,
  foreignKey,
  primaryKey,
  unique,
  check,
  pgView,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const rikaHostedExecutorKind = pgEnum("rika_hosted_executor_kind", ["runner", "orb"])
export const rikaHostedGrantRole = pgEnum("rika_hosted_grant_role", ["viewer", "controller", "operator", "owner"])
export const rikaHostedPresenceStatus = pgEnum("rika_hosted_presence_status", ["viewing", "controlling", "away"])
export const rikaHostedAssignmentLifecycle = pgEnum("rika_hosted_assignment_lifecycle", [
  "pending",
  "provisioning",
  "awaiting_bootstrap",
  "active",
  "paused",
  "terminated",
])
export const rikaHostedRunnerOperationState = pgEnum("rika_hosted_runner_operation_state", [
  "accepted",
  "dispatched",
  "completed",
  "unknown",
])
export const rikaHostedPreparationState = pgEnum("rika_hosted_preparation_state", ["preparing", "ready", "failed"])
export const rikaHostedPreparationPhase = pgEnum("rika_hosted_preparation_phase", [
  "checkout",
  "setup",
  "resume",
  "capabilities",
])
export const rikaHostedRepositoryPublicationState = pgEnum("rika_hosted_repository_publication_state", [
  "approved",
  "pushing",
  "pushed",
  "completed",
  "failed",
  "unknown",
])

export const rikaGoals = pgTable(
  "rika_goals",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => rikaThreads.id, { onDelete: "cascade" }),
    objective: text().notNull(),
    status: text().notNull(),
    budgetTokens: integer("budget_tokens"),
    budgetWallClockMillis: doublePrecision("budget_wall_clock_millis"),
    usageTokens: integer("usage_tokens").default(0).notNull(),
    usageElapsedMillis: doublePrecision("usage_elapsed_millis").default(0).notNull(),
    usageTurns: integer("usage_turns").default(0).notNull(),
    startedAt: doublePrecision("started_at").notNull(),
    updatedAt: doublePrecision("updated_at").notNull(),
    completedAt: doublePrecision("completed_at"),
    summary: text(),
  },
  (_table) => [
    check("rika_goals_budget_tokens_check", sql`((budget_tokens IS NULL) OR (budget_tokens > 0))`),
    check(
      "rika_goals_budget_wall_clock_millis_check",
      sql`((budget_wall_clock_millis IS NULL) OR (budget_wall_clock_millis > (0)::double precision))`,
    ),
    check("rika_goals_check", sql`((status = 'complete'::text) = (completed_at IS NOT NULL))`),
    check("rika_goals_objective_check", sql`((length(objective) > 0) AND (length(objective) <= 4096))`),
    check(
      "rika_goals_status_check",
      sql`(status = ANY (ARRAY['active'::text, 'paused'::text, 'complete'::text, 'errored'::text]))`,
    ),
    check("rika_goals_usage_elapsed_millis_check", sql`(usage_elapsed_millis >= (0)::double precision)`),
    check("rika_goals_usage_tokens_check", sql`(usage_tokens >= 0)`),
    check("rika_goals_usage_turns_check", sql`(usage_turns >= 0)`),
  ],
)

export const rikaHostedAuditEvents = pgTable(
  "rika_hosted_audit_events",
  {
    id: text().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    actor: jsonb().notNull(),
    action: text().notNull(),
    resourceKind: text("resource_kind").notNull(),
    resourceId: text("resource_id").notNull(),
    commitCursor: bigint("commit_cursor", { mode: "number" }).notNull(),
    attributes: jsonb().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("rika_hosted_audit_events_timeline").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.occurredAt.desc().nullsFirst(),
      table.id.asc().nullsLast(),
    ),
    unique("rika_hosted_audit_events_owner_id_commit_cursor_key").on(table.ownerId, table.commitCursor),
    check("rika_hosted_audit_events_action_check", sql`(length(action) > 0)`),
    check("rika_hosted_audit_events_actor_check", sql`(jsonb_typeof(actor) = 'object'::text)`),
    check("rika_hosted_audit_events_attributes_check", sql`(jsonb_typeof(attributes) = 'object'::text)`),
    check("rika_hosted_audit_events_check", sql`rika_hosted_actor_matches_owner(actor, owner_id)`),
    check("rika_hosted_audit_events_commit_cursor_check", sql`(commit_cursor >= 1)`),
    check("rika_hosted_audit_events_resource_id_check", sql`(length(resource_id) > 0)`),
    check("rika_hosted_audit_events_resource_kind_check", sql`(length(resource_kind) > 0)`),
  ],
)

export const rikaHostedCheckpoints = pgTable(
  "rika_hosted_checkpoints",
  {
    id: text().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
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
      foreignColumns: [rikaHostedThreads.id, rikaHostedThreads.ownerId],
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

export const rikaHostedClientAuthorities = pgTable(
  "rika_hosted_client_authorities",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => rikaHostedClients.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.ownerId], name: "rika_hosted_client_authorities_pkey" }),
    index("rika_hosted_client_authorities_active")
      .using(
        "btree",
        table.ownerId.asc().nullsLast(),
        table.expiresAt.asc().nullsLast(),
        table.clientId.asc().nullsLast(),
      )
      .where(sql`(revoked_at IS NULL)`),
    check("rika_hosted_client_authorities_check", sql`(expires_at > issued_at)`),
    check("rika_hosted_client_authorities_check1", sql`(expires_at <= (issued_at + '00:05:00'::interval))`),
  ],
)

export const rikaHostedClientCursors = pgTable(
  "rika_hosted_client_cursors",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    actor: jsonb().notNull(),
    commitCursor: bigint("commit_cursor", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.actor], name: "rika_hosted_client_cursors_pkey" }),
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [rikaHostedThreads.id, rikaHostedThreads.ownerId],
      name: "rika_hosted_client_cursors_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    check("rika_hosted_client_cursors_actor_check", sql`(jsonb_typeof(actor) = 'object'::text)`),
    check("rika_hosted_client_cursors_check", sql`rika_hosted_actor_matches_owner(actor, owner_id)`),
    check("rika_hosted_client_cursors_commit_cursor_check", sql`(commit_cursor >= 0)`),
  ],
)

export const rikaHostedClients = pgTable(
  "rika_hosted_clients",
  {
    id: text().primaryKey(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id").notNull(),
    authenticatedAt: timestamp("authenticated_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.deviceId, table.userId],
      foreignColumns: [rikaHostedDevices.id, rikaHostedDevices.userId],
      name: "rika_hosted_clients_device_id_user_id_fkey",
    }).onDelete("restrict"),
    index("rika_hosted_clients_active")
      .using("btree", table.userId.asc().nullsLast(), table.expiresAt.asc().nullsLast())
      .where(sql`(revoked_at IS NULL)`),
    unique("rika_hosted_clients_id_user_id_key").on(table.id, table.userId),
    check("rika_hosted_clients_check", sql`(expires_at > authenticated_at)`),
    check("rika_hosted_clients_short_lived", sql`(expires_at <= (authenticated_at + '00:05:00'::interval))`),
  ],
)

export const rikaHostedCredentialReferences = pgTable(
  "rika_hosted_credential_references",
  {
    id: text().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    projectId: text("project_id"),
    provider: text().notNull(),
    purpose: text().notNull(),
    externalReference: text("external_reference").notNull(),
    metadata: jsonb().notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.ownerId],
      foreignColumns: [rikaHostedProjects.id, rikaHostedProjects.ownerId],
      name: "rika_hosted_credential_references_project_id_owner_id_fkey",
    }).onDelete("cascade"),
    uniqueIndex("rika_hosted_credential_references_model_provider_idx")
      .using("btree", table.ownerId.asc().nullsLast(), table.provider.asc().nullsLast())
      .where(sql`(purpose = 'model-provider'::text)`),
    uniqueIndex("rika_hosted_credential_references_openai_account_idx")
      .using("btree", table.ownerId.asc().nullsLast(), table.provider.asc().nullsLast())
      .where(sql`(purpose = 'model-provider-account'::text)`),
    unique("rika_hosted_credential_refere_owner_id_provider_external_re_key").on(
      table.ownerId,
      table.provider,
      table.externalReference,
    ),
    unique("rika_hosted_credential_references_identity_unique").on(table.id, table.ownerId, table.provider),
    check("rika_hosted_credential_references_external_reference_check", sql`(length(external_reference) > 0)`),
    check(
      "rika_hosted_credential_references_metadata_check",
      sql`((jsonb_typeof(metadata) = 'object'::text) AND ((metadata)::text !~* '"(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|private[_-]?key|authorization|cookie)"[[:space:]]*:'::text))`,
    ),
    check("rika_hosted_credential_references_provider_check", sql`(length(provider) > 0)`),
    check("rika_hosted_credential_references_purpose_check", sql`(length(purpose) > 0)`),
  ],
)

export const rikaHostedDevices = pgTable(
  "rika_hosted_devices",
  {
    id: text().primaryKey(),
    userId: text("user_id").notNull(),
    displayName: text("display_name").notNull(),
    publicKeyFingerprint: text("public_key_fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    unique("rika_hosted_devices_id_user_id_key").on(table.id, table.userId),
    unique("rika_hosted_devices_user_id_public_key_fingerprint_key").on(table.userId, table.publicKeyFingerprint),
    check("rika_hosted_devices_display_name_check", sql`(length(display_name) > 0)`),
    check("rika_hosted_devices_public_key_fingerprint_check", sql`(length(public_key_fingerprint) > 0)`),
  ],
)

export const rikaHostedEnvironmentValues = pgTable(
  "rika_hosted_environment_values",
  {
    id: text().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    projectId: text("project_id"),
    scope: text().notNull(),
    scopeId: text("scope_id").notNull(),
    name: text().notNull(),
    classification: text().notNull(),
    phases: text().array().notNull(),
    revision: bigint({ mode: "number" }).notNull(),
    valueDigest: text("value_digest").notNull(),
    state: text().notNull(),
    keyVersion: integer("key_version"),
    nonce: customType({ dataType: () => "bytea" })(),
    ciphertext: customType({ dataType: () => "bytea" })(),
    authenticationTag: customType({ dataType: () => "bytea" })("authentication_tag"),
    createdByUserId: text("created_by_user_id").notNull(),
    updatedByUserId: text("updated_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.ownerId],
      foreignColumns: [rikaHostedProjects.id, rikaHostedProjects.ownerId],
      name: "rika_hosted_environment_values_project_id_owner_id_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_environment_values_resolution")
      .using(
        "btree",
        table.ownerId.asc().nullsLast(),
        table.scope.asc().nullsLast(),
        table.scopeId.asc().nullsLast(),
        table.name.asc().nullsLast(),
      )
      .where(sql`(state = 'active'::text)`),
    unique("rika_hosted_environment_values_owner_id_scope_scope_id_name_key").on(
      table.ownerId,
      table.scope,
      table.scopeId,
      table.name,
    ),
    check("rika_hosted_environment_values_check", sql`(updated_at >= created_at)`),
    check("rika_hosted_environment_values_check1", sql`((scope = 'project'::text) = (project_id IS NOT NULL))`),
    check(
      "rika_hosted_environment_values_check2",
      sql`(((state = 'active'::text) AND (key_version = 1) AND (octet_length(nonce) = 12) AND (octet_length(ciphertext) > 0) AND (octet_length(authentication_tag) = 16) AND (revoked_at IS NULL)) OR ((state = 'revoked'::text) AND (key_version IS NULL) AND (nonce IS NULL) AND (ciphertext IS NULL) AND (authentication_tag IS NULL) AND (revoked_at IS NOT NULL)))`,
    ),
    check(
      "rika_hosted_environment_values_classification_check",
      sql`(classification = ANY (ARRAY['plain'::text, 'secret'::text]))`,
    ),
    check("rika_hosted_environment_values_name_check", sql`(name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'::text)`),
    check(
      "rika_hosted_environment_values_phases_check",
      sql`((cardinality(phases) > 0) AND (cardinality(phases) <= 2) AND (phases <@ ARRAY['setup'::text, 'runtime'::text]) AND ((cardinality(phases) = 1) OR (phases[1] <> phases[2])))`,
    ),
    check("rika_hosted_environment_values_revision_check", sql`(revision > 0)`),
    check(
      "rika_hosted_environment_values_scope_check",
      sql`(scope = ANY (ARRAY['personal'::text, 'organization'::text, 'project'::text]))`,
    ),
    check("rika_hosted_environment_values_state_check", sql`(state = ANY (ARRAY['active'::text, 'revoked'::text]))`),
    check("rika_hosted_environment_values_value_digest_check", sql`(value_digest ~ '^sha256:[a-f0-9]{64}$'::text)`),
  ],
)

export const rikaHostedExecutorAssignments = pgTable(
  "rika_hosted_executor_assignments",
  {
    id: text().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    executorKind: rikaHostedExecutorKind("executor_kind").notNull(),
    placement: jsonb().notNull(),
    checkout: jsonb(),
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
      foreignColumns: [rikaHostedThreads.id, rikaHostedThreads.ownerId, rikaHostedThreads.executorKind],
      name: "rika_hosted_executor_assignme_thread_id_owner_id_executor__fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.threadId, table.ownerId, table.workspaceId],
      foreignColumns: [rikaHostedThreads.id, rikaHostedThreads.ownerId, rikaHostedThreads.workspaceId],
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
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
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
      .references(() => rikaHostedThreads.id, { onDelete: "cascade" }),
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

export const rikaHostedGitIdentities = pgTable(
  "rika_hosted_git_identities",
  {
    ownerId: text("owner_id")
      .primaryKey()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    name: text().notNull(),
    email: text().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (_table) => [
    check(
      "rika_hosted_git_identities_email_check",
      sql`(((length(email) >= 3) AND (length(email) <= 320)) AND (email ~ '^[^[:space:]@]+@[^[:space:]@]+$'::text))`,
    ),
    check("rika_hosted_git_identities_name_check", sql`((length(name) >= 1) AND (length(name) <= 256))`),
  ],
)

export const rikaHostedOpenaiAccountCredentials = pgTable(
  "rika_hosted_openai_account_credentials",
  {
    credentialReferenceId: text("credential_reference_id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    provider: text().default("openai").notNull(),
    status: text().notNull(),
    revision: bigint({ mode: "number" }).notNull(),
    fingerprint: text().notNull(),
    keyVersion: integer("key_version"),
    nonce: customType({ dataType: () => "bytea" })(),
    ciphertext: customType({ dataType: () => "bytea" })(),
    authenticationTag: customType({ dataType: () => "bytea" })("authentication_tag"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.credentialReferenceId, table.ownerId, table.provider],
      foreignColumns: [
        rikaHostedCredentialReferences.id,
        rikaHostedCredentialReferences.ownerId,
        rikaHostedCredentialReferences.provider,
      ],
      name: "rika_hosted_openai_account_cr_credential_reference_id_owne_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_openai_account_credentials_active_idx")
      .using("btree", table.ownerId.asc().nullsLast())
      .where(sql`(status = 'active'::text)`),
    unique("rika_hosted_openai_account_credentials_owner_id_key").on(table.ownerId),
    check(
      "rika_hosted_openai_account_credentials_check",
      sql`(((status = 'active'::text) AND (key_version IS NOT NULL) AND (octet_length(nonce) = 12) AND (octet_length(ciphertext) > 0) AND (octet_length(authentication_tag) = 16) AND (revoked_at IS NULL)) OR ((status = 'revoked'::text) AND (key_version IS NULL) AND (nonce IS NULL) AND (ciphertext IS NULL) AND (authentication_tag IS NULL) AND (revoked_at IS NOT NULL)))`,
    ),
    check("rika_hosted_openai_account_credentials_fingerprint_check", sql`(length(fingerprint) > 0)`),
    check("rika_hosted_openai_account_credentials_provider_check", sql`(provider = 'openai'::text)`),
    check("rika_hosted_openai_account_credentials_revision_check", sql`(revision > 0)`),
    check(
      "rika_hosted_openai_account_credentials_status_check",
      sql`(status = ANY (ARRAY['active'::text, 'revoked'::text]))`,
    ),
  ],
)

export const rikaHostedOrganizationEnvironmentPolicy = pgTable("rika_hosted_organization_environment_policy", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
  personalOverrides: boolean("personal_overrides").default(true).notNull(),
  updatedByUserId: text("updated_by_user_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`transaction_timestamp()`)
    .notNull(),
})

export const rikaHostedOwnerCounters = pgTable(
  "rika_hosted_owner_counters",
  {
    ownerId: text("owner_id")
      .primaryKey()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    nextCommitCursor: bigint("next_commit_cursor", { mode: "number" }).default(1).notNull(),
  },
  (_table) => [check("rika_hosted_owner_counters_next_commit_cursor_check", sql`(next_commit_cursor >= 1)`)],
)

export const rikaHostedOwners = pgTable(
  "rika_hosted_owners",
  {
    id: text().primaryKey(),
    kind: text().$type<"personal" | "organization">().notNull(),
    userId: text("user_id"),
    organizationId: text("organization_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    unique("rika_hosted_owners_organization_id_key").on(table.organizationId),
    unique("rika_hosted_owners_user_id_key").on(table.userId),
    check(
      "rika_hosted_owners_check",
      sql`(((kind = 'personal'::text) AND (user_id IS NOT NULL) AND (organization_id IS NULL)) OR ((kind = 'organization'::text) AND (user_id IS NULL) AND (organization_id IS NOT NULL)))`,
    ),
    check("rika_hosted_owners_kind_check", sql`(kind = ANY (ARRAY['personal'::text, 'organization'::text]))`),
  ],
)

export const rikaHostedPhaseEgressPolicy = pgTable(
  "rika_hosted_phase_egress_policy",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    projectId: text("project_id"),
    phase: text().notNull(),
    allowlist: text().array().default([]).notNull(),
    updatedByUserId: text("updated_by_user_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.ownerId],
      foreignColumns: [rikaHostedProjects.id, rikaHostedProjects.ownerId],
      name: "rika_hosted_phase_egress_policy_project_id_owner_id_fkey",
    }).onDelete("cascade"),
    uniqueIndex("rika_hosted_owner_phase_egress_policy")
      .using("btree", table.ownerId.asc().nullsLast(), table.phase.asc().nullsLast())
      .where(sql`(project_id IS NULL)`),
    uniqueIndex("rika_hosted_project_phase_egress_policy")
      .using("btree", table.ownerId.asc().nullsLast(), table.projectId.asc().nullsLast(), table.phase.asc().nullsLast())
      .where(sql`(project_id IS NOT NULL)`),
    check("rika_hosted_phase_egress_policy_phase_check", sql`(phase = ANY (ARRAY['setup'::text, 'runtime'::text]))`),
  ],
)

export const rikaHostedPresence = pgTable(
  "rika_hosted_presence",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    actor: jsonb().notNull(),
    status: rikaHostedPresenceStatus().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.actor], name: "rika_hosted_presence_pkey" }),
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [rikaHostedThreads.id, rikaHostedThreads.ownerId],
      name: "rika_hosted_presence_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_presence_expiry").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.threadId.asc().nullsLast(),
      table.expiresAt.asc().nullsLast(),
    ),
    check("rika_hosted_presence_actor_check", sql`(jsonb_typeof(actor) = 'object'::text)`),
    check("rika_hosted_presence_check", sql`(expires_at > last_seen_at)`),
    check("rika_hosted_presence_check1", sql`rika_hosted_actor_matches_owner(actor, owner_id)`),
  ],
)

export const rikaHostedProjectGrants = pgTable(
  "rika_hosted_project_grants",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull(),
    membershipId: text("membership_id").notNull(),
    role: rikaHostedGrantRole().notNull(),
    grantedByUserId: text("granted_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.membershipId], name: "rika_hosted_project_grants_pkey" }),
    foreignKey({
      columns: [table.projectId, table.ownerId],
      foreignColumns: [rikaHostedProjects.id, rikaHostedProjects.ownerId],
      name: "rika_hosted_project_grants_project_id_owner_id_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_project_grants_member").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.membershipId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
    ),
  ],
)

export const rikaHostedProjectRepositories = pgTable(
  "rika_hosted_project_repositories",
  {
    projectId: text("project_id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    installationId: text("installation_id").notNull(),
    installationAccountId: text("installation_account_id").notNull(),
    installationAccountLogin: text("installation_account_login").notNull(),
    installationAccountType: text("installation_account_type").notNull(),
    repositoryOwner: text("repository_owner").notNull(),
    repositoryName: text("repository_name").notNull(),
    defaultRef: text("default_ref").notNull(),
    private: boolean().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.ownerId],
      foreignColumns: [rikaHostedProjects.id, rikaHostedProjects.ownerId],
      name: "rika_hosted_project_repositories_project_id_owner_id_fkey",
    }).onDelete("cascade"),
    unique("rika_hosted_project_repositories_owner_id_repository_id_key").on(table.ownerId, table.repositoryId),
    check(
      "rika_hosted_project_repositori_installation_account_login_check",
      sql`(length(installation_account_login) > 0)`,
    ),
    check(
      "rika_hosted_project_repositorie_installation_account_type_check",
      sql`(installation_account_type = ANY (ARRAY['User'::text, 'Organization'::text, 'Enterprise'::text]))`,
    ),
    check("rika_hosted_project_repositories_default_ref_check", sql`(length(default_ref) > 0)`),
    check("rika_hosted_project_repositories_repository_name_check", sql`(length(repository_name) > 0)`),
    check("rika_hosted_project_repositories_repository_owner_check", sql`(length(repository_owner) > 0)`),
  ],
)

export const rikaHostedProjects = pgTable(
  "rika_hosted_projects",
  {
    id: text().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    name: text().notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("rika_hosted_projects_owner_name").using("btree", table.ownerId.asc().nullsLast(), sql`lower(name)`),
    unique("rika_hosted_projects_id_owner_id_key").on(table.id, table.ownerId),
    check("rika_hosted_projects_name_check", sql`(length(name) > 0)`),
  ],
)

export const rikaHostedProviderCredentials = pgTable(
  "rika_hosted_provider_credentials",
  {
    credentialReferenceId: text("credential_reference_id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    provider: text().notNull(),
    status: text().notNull(),
    revision: bigint({ mode: "number" }).notNull(),
    keyVersion: integer("key_version"),
    nonce: customType({ dataType: () => "bytea" })(),
    ciphertext: customType({ dataType: () => "bytea" })(),
    authenticationTag: customType({ dataType: () => "bytea" })("authentication_tag"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.credentialReferenceId, table.ownerId, table.provider],
      foreignColumns: [
        rikaHostedCredentialReferences.id,
        rikaHostedCredentialReferences.ownerId,
        rikaHostedCredentialReferences.provider,
      ],
      name: "rika_hosted_provider_credenti_credential_reference_id_owne_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_provider_credentials_active_idx")
      .using("btree", table.ownerId.asc().nullsLast(), table.provider.asc().nullsLast())
      .where(sql`(status = 'active'::text)`),
    unique("rika_hosted_provider_credentials_owner_id_provider_key").on(table.ownerId, table.provider),
    check(
      "rika_hosted_provider_credentials_check",
      sql`(((status = 'active'::text) AND (key_version IS NOT NULL) AND (octet_length(nonce) = 12) AND (octet_length(ciphertext) > 0) AND (octet_length(authentication_tag) = 16) AND (revoked_at IS NULL)) OR ((status = 'revoked'::text) AND (key_version IS NULL) AND (nonce IS NULL) AND (ciphertext IS NULL) AND (authentication_tag IS NULL) AND (revoked_at IS NOT NULL)))`,
    ),
    check(
      "rika_hosted_provider_credentials_provider_check",
      sql`(provider = ANY (ARRAY['openai'::text, 'anthropic'::text, 'openrouter'::text]))`,
    ),
    check("rika_hosted_provider_credentials_revision_check", sql`(revision > 0)`),
    check(
      "rika_hosted_provider_credentials_status_check",
      sql`(status = ANY (ARRAY['active'::text, 'revoked'::text]))`,
    ),
  ],
)

export const rikaHostedRepositoryPublicationAudit = pgTable(
  "rika_hosted_repository_publication_audit",
  {
    sequence: bigserial({ mode: "number" }).primaryKey(),
    publicationId: text("publication_id").notNull(),
    ownerId: text("owner_id").notNull(),
    threadId: text("thread_id").notNull(),
    actor: jsonb().notNull(),
    action: text().notNull(),
    authority: jsonb().notNull(),
    fence: jsonb().notNull(),
    result: jsonb().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    index("rika_hosted_repository_publication_audit_lookup").using(
      "btree",
      table.publicationId.asc().nullsLast(),
      table.sequence.asc().nullsLast(),
    ),
    check(
      "rika_hosted_repository_publication_audit_action_check",
      sql`(action = ANY (ARRAY['approved'::text, 'branch-push-credential-authorized'::text, 'branch-push-credential-failed'::text, 'branch-push-succeeded'::text, 'branch-push-failed'::text, 'branch-push-unknown'::text, 'pull-request-succeeded'::text, 'pull-request-failed'::text]))`,
    ),
    check("rika_hosted_repository_publication_audit_actor_check", sql`(jsonb_typeof(actor) = 'object'::text)`),
    check("rika_hosted_repository_publication_audit_authority_check", sql`(jsonb_typeof(authority) = 'object'::text)`),
    check("rika_hosted_repository_publication_audit_check", sql`rika_hosted_actor_matches_owner(actor, owner_id)`),
    check(
      "rika_hosted_repository_publication_audit_check1",
      sql`((((authority || fence) || result))::text !~* '"(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|private[_-]?key|authorization|cookie)"[[:space:]]*:'::text)`,
    ),
    check("rika_hosted_repository_publication_audit_fence_check", sql`(jsonb_typeof(fence) = 'object'::text)`),
    check("rika_hosted_repository_publication_audit_result_check", sql`(jsonb_typeof(result) = 'object'::text)`),
  ],
)

export const rikaHostedRepositoryPublications = pgTable(
  "rika_hosted_repository_publications",
  {
    id: text().primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    ownerId: text("owner_id").notNull(),
    threadId: text("thread_id").notNull(),
    projectId: text("project_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    actor: jsonb().notNull(),
    assignmentId: text("assignment_id").notNull(),
    assignmentGeneration: bigint("assignment_generation", { mode: "number" }).notNull(),
    leaseEpoch: bigint("lease_epoch", { mode: "number" }).notNull(),
    workspaceId: text("workspace_id").notNull(),
    authorizationCheckpointId: text("authorization_checkpoint_id").notNull(),
    authorizationDigest: text("authorization_digest").notNull(),
    sourceBranch: text("source_branch").notNull(),
    sourceRef: text("source_ref").notNull(),
    sourceCommitSha: text("source_commit_sha").notNull(),
    targetRef: text("target_ref").notNull(),
    targetCommitSha: text("target_commit_sha").notNull(),
    targetProtected: boolean("target_protected").notNull(),
    pullRequestTitle: text("pull_request_title").notNull(),
    pullRequestBody: text("pull_request_body").notNull(),
    state: rikaHostedRepositoryPublicationState().notNull(),
    credentialAuthorizedAt: timestamp("credential_authorized_at", { withTimezone: true }),
    pushResult: jsonb("push_result"),
    pullRequestResult: jsonb("pull_request_result"),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.assignmentId, table.ownerId],
      foreignColumns: [rikaHostedExecutorAssignments.id, rikaHostedExecutorAssignments.ownerId],
      name: "rika_hosted_repository_publications_assignment_id_owner_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.projectId, table.ownerId],
      foreignColumns: [rikaHostedProjects.id, rikaHostedProjects.ownerId],
      name: "rika_hosted_repository_publications_project_id_owner_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [rikaHostedThreads.id, rikaHostedThreads.ownerId],
      name: "rika_hosted_repository_publications_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    unique("rika_hosted_repository_public_owner_id_thread_id_idempotenc_key").on(
      table.ownerId,
      table.threadId,
      table.idempotencyKey,
    ),
    check("rika_hosted_repository_publications_actor_check", sql`(jsonb_typeof(actor) = 'object'::text)`),
    check("rika_hosted_repository_publications_assignment_generation_check", sql`(assignment_generation >= 1)`),
    check(
      "rika_hosted_repository_publications_authorization_digest_check",
      sql`(authorization_digest ~ '^sha256:[a-f0-9]{64}$'::text)`,
    ),
    check("rika_hosted_repository_publications_check", sql`(source_ref = ('refs/heads/'::text || source_branch))`),
    check("rika_hosted_repository_publications_check1", sql`rika_hosted_actor_matches_owner(actor, owner_id)`),
    check(
      "rika_hosted_repository_publications_check2",
      sql`(((state = 'approved'::rika_hosted_repository_publication_state) AND (credential_authorized_at IS NULL) AND (push_result IS NULL)) OR ((state = 'pushing'::rika_hosted_repository_publication_state) AND (credential_authorized_at IS NOT NULL) AND (push_result IS NULL)) OR ((state = 'pushed'::rika_hosted_repository_publication_state) AND (credential_authorized_at IS NOT NULL) AND (push_result IS NOT NULL)) OR ((state = 'completed'::rika_hosted_repository_publication_state) AND (credential_authorized_at IS NOT NULL) AND (push_result IS NOT NULL) AND (pull_request_result IS NOT NULL)) OR (state = ANY (ARRAY['failed'::rika_hosted_repository_publication_state, 'unknown'::rika_hosted_repository_publication_state])))`,
    ),
    check("rika_hosted_repository_publications_lease_epoch_check", sql`(lease_epoch >= 1)`),
    check("rika_hosted_repository_publications_pull_request_body_check", sql`(length(pull_request_body) <= 65536)`),
    check(
      "rika_hosted_repository_publications_pull_request_title_check",
      sql`((length(pull_request_title) >= 1) AND (length(pull_request_title) <= 256))`,
    ),
    check(
      "rika_hosted_repository_publications_source_branch_check",
      sql`(source_branch ~ '^rika/[A-Za-z0-9._/-]+$'::text)`,
    ),
    check(
      "rika_hosted_repository_publications_source_commit_sha_check",
      sql`(source_commit_sha ~ '^[a-f0-9]{40}$'::text)`,
    ),
    check(
      "rika_hosted_repository_publications_target_commit_sha_check",
      sql`(target_commit_sha ~ '^[a-f0-9]{40}$'::text)`,
    ),
    check("rika_hosted_repository_publications_target_ref_check", sql`(length(target_ref) > 0)`),
    check("rika_hosted_repository_publications_workspace_id_check", sql`(length(workspace_id) > 0)`),
  ],
)

export const rikaHostedRunnerAdmissions = pgTable(
  "rika_hosted_runner_admissions",
  {
    id: text().primaryKey(),
    assignmentId: text("assignment_id").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
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
      foreignColumns: [rikaHostedClients.id, rikaHostedClients.userId],
      name: "rika_hosted_runner_admissions_client_id_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.deviceId, table.userId],
      foreignColumns: [rikaHostedDevices.id, rikaHostedDevices.userId],
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
    kernelProfile: jsonb("kernel_profile").notNull(),
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
      foreignColumns: [rikaHostedDevices.id, rikaHostedDevices.userId],
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
      "rika_hosted_runner_registrations_kernel_profile_check",
      sql`(jsonb_typeof(kernel_profile) = 'object'::text)`,
    ),
    check("rika_hosted_runner_registrations_repository_check", sql`(jsonb_typeof(repository) = 'object'::text)`),
    check("rika_hosted_runner_supervisor_pair", sql`((supervisor_id IS NULL) = (supervisor_expires_at IS NULL))`),
  ],
)

export const rikaHostedSourceEnvironmentApprovals = pgTable(
  "rika_hosted_source_environment_approvals",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    projectId: text("project_id"),
    sourceOwner: text("source_owner").notNull(),
    sourceCommitSha: text("source_commit_sha").notNull(),
    phase: text().notNull(),
    approvedByUserId: text("approved_by_user_id").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.ownerId],
      foreignColumns: [rikaHostedProjects.id, rikaHostedProjects.ownerId],
      name: "rika_hosted_source_environment_approva_project_id_owner_id_fkey",
    }).onDelete("cascade"),
    uniqueIndex("rika_hosted_owner_source_environment_approvals")
      .using(
        "btree",
        table.ownerId.asc().nullsLast(),
        sql`lower(source_owner)`,
        sql`lower(source_commit_sha)`,
        table.phase.asc().nullsLast(),
      )
      .where(sql`(project_id IS NULL)`),
    uniqueIndex("rika_hosted_project_source_environment_approvals")
      .using(
        "btree",
        table.ownerId.asc().nullsLast(),
        table.projectId.asc().nullsLast(),
        sql`lower(source_owner)`,
        sql`lower(source_commit_sha)`,
        table.phase.asc().nullsLast(),
      )
      .where(sql`(project_id IS NOT NULL)`),
    check(
      "rika_hosted_source_environment_approval_source_commit_sha_check",
      sql`(source_commit_sha ~* '^[a-f0-9]{40}$'::text)`,
    ),
    check(
      "rika_hosted_source_environment_approvals_phase_check",
      sql`(phase = ANY (ARRAY['setup'::text, 'runtime'::text]))`,
    ),
    check("rika_hosted_source_environment_approvals_source_owner_check", sql`(length(source_owner) > 0)`),
  ],
)

export const rikaHostedTerminalWriterLeases = pgTable(
  "rika_hosted_terminal_writer_leases",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
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
      foreignColumns: [rikaHostedThreads.id, rikaHostedThreads.ownerId],
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

export const rikaHostedThreadCommands = pgTable(
  "rika_hosted_thread_commands",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    commandId: text("command_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    actor: jsonb().notNull(),
    sequence: bigint({ mode: "number" }).notNull(),
    commitCursor: bigint("commit_cursor", { mode: "number" }).notNull(),
    command: jsonb().notNull(),
    admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull(),
    turnId: text("turn_id").references(() => rikaTurns.id, { onDelete: "restrict" }),
    admissionStatus: text("admission_status"),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.commandId], name: "rika_hosted_thread_commands_pkey" }),
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [rikaHostedThreads.id, rikaHostedThreads.ownerId],
      name: "rika_hosted_thread_commands_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_thread_commands_cursor").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.threadId.asc().nullsLast(),
      table.commitCursor.asc().nullsLast(),
    ),
    index("rika_hosted_thread_commands_sequence").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.threadId.asc().nullsLast(),
      table.sequence.asc().nullsLast(),
    ),
    index("rika_hosted_thread_commands_turn")
      .using("btree", table.ownerId.asc().nullsLast(), table.threadId.asc().nullsLast(), table.turnId.asc().nullsLast())
      .where(sql`(turn_id IS NOT NULL)`),
    unique("rika_hosted_thread_commands_owner_id_commit_cursor_key").on(table.ownerId, table.commitCursor),
    unique("rika_hosted_thread_commands_thread_id_idempotency_key_key").on(table.threadId, table.idempotencyKey),
    unique("rika_hosted_thread_commands_thread_id_owner_id_sequence_key").on(
      table.threadId,
      table.ownerId,
      table.sequence,
    ),
    unique("rika_hosted_thread_commands_turn_id_key").on(table.turnId),
    check("rika_hosted_thread_commands_actor_check", sql`(jsonb_typeof(actor) = 'object'::text)`),
    check(
      "rika_hosted_thread_commands_admission_status_check",
      sql`(admission_status = ANY (ARRAY['accepted'::text, 'queued'::text]))`,
    ),
    check("rika_hosted_thread_commands_check", sql`rika_hosted_actor_matches_owner(actor, owner_id)`),
    check("rika_hosted_thread_commands_check1", sql`((turn_id IS NULL) = (admission_status IS NULL))`),
    check("rika_hosted_thread_commands_command_check", sql`(jsonb_typeof(command) = 'object'::text)`),
    check("rika_hosted_thread_commands_commit_cursor_check", sql`(commit_cursor >= 1)`),
    check("rika_hosted_thread_commands_sequence_check", sql`(sequence >= 1)`),
  ],
)

export const rikaHostedThreadEvents = pgTable(
  "rika_hosted_thread_events",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
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
      foreignColumns: [rikaHostedExecutorAssignments.id, rikaHostedExecutorAssignments.ownerId],
      name: "rika_hosted_thread_events_assignment_id_owner_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.threadId, table.ownerId, table.commandSequence],
      foreignColumns: [
        rikaHostedThreadCommands.threadId,
        rikaHostedThreadCommands.ownerId,
        rikaHostedThreadCommands.sequence,
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

export const rikaHostedThreadGrants = pgTable(
  "rika_hosted_thread_grants",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    membershipId: text("membership_id").notNull(),
    role: rikaHostedGrantRole().notNull(),
    grantedByUserId: text("granted_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.membershipId], name: "rika_hosted_thread_grants_pkey" }),
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [rikaHostedThreads.id, rikaHostedThreads.ownerId],
      name: "rika_hosted_thread_grants_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_thread_grants_member").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.membershipId.asc().nullsLast(),
      table.threadId.asc().nullsLast(),
    ),
  ],
)

export const rikaHostedThreadProtocolCommands = pgTable(
  "rika_hosted_thread_protocol_commands",
  {
    ownerId: text("owner_id").notNull(),
    threadId: text("thread_id").notNull(),
    commandId: text("command_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    expectedVersion: bigint("expected_version", { mode: "number" }).notNull(),
    threadVersion: bigint("thread_version", { mode: "number" }).notNull(),
    actor: jsonb().notNull(),
    command: jsonb().notNull(),
    state: text().notNull(),
    result: jsonb(),
    eventCursor: bigint("event_cursor", { mode: "number" }),
    admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    claimToken: text("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.commandId], name: "rika_hosted_thread_protocol_commands_pkey" }),
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [rikaHostedThreadProtocolState.threadId, rikaHostedThreadProtocolState.ownerId],
      name: "rika_hosted_thread_protocol_commands_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    unique("rika_hosted_thread_protocol_comma_thread_id_idempotency_key_key").on(table.threadId, table.idempotencyKey),
    unique("rika_hosted_thread_protocol_comman_thread_id_thread_version_key").on(table.threadId, table.threadVersion),
    check(
      "rika_hosted_thread_protocol_commands_check",
      sql`(((state = 'admitted'::text) AND (result IS NULL) AND (completed_at IS NULL)) OR ((state = 'completed'::text) AND (result IS NOT NULL) AND (event_cursor IS NOT NULL) AND (completed_at IS NOT NULL)))`,
    ),
    check("rika_hosted_thread_protocol_commands_event_cursor_check", sql`(event_cursor >= 0)`),
    check("rika_hosted_thread_protocol_commands_expected_version_check", sql`(expected_version >= 0)`),
    check(
      "rika_hosted_thread_protocol_commands_state_check",
      sql`(state = ANY (ARRAY['admitted'::text, 'completed'::text]))`,
    ),
    check("rika_hosted_thread_protocol_commands_thread_version_check", sql`(thread_version > 0)`),
    check("rika_hosted_thread_protocol_commands_claim_pair", sql`((claim_token IS NULL) = (claim_expires_at IS NULL))`),
    check("rika_hosted_thread_protocol_commands_claim_state", sql`((state = 'admitted') OR (claim_token IS NULL))`),
    index("rika_hosted_thread_protocol_commands_claims")
      .on(table.claimExpiresAt)
      .where(sql`(state = 'admitted')`),
  ],
)

export const rikaHostedThreadProtocolCursors = pgTable(
  "rika_hosted_thread_protocol_cursors",
  {
    ownerId: text("owner_id").notNull(),
    threadId: text("thread_id").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => rikaHostedClients.id, { onDelete: "cascade" }),
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

export const rikaHostedPromptCancellations = pgTable(
  "rika_hosted_prompt_cancellations",
  {
    ownerId: text("owner_id").notNull(),
    threadId: text("thread_id").notNull(),
    targetCommandId: text("target_command_id").notNull(),
    cancelCommandId: text("cancel_command_id").notNull(),
    actor: jsonb().notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.targetCommandId], name: "rika_hosted_prompt_cancellations_pkey" }),
    unique("rika_hosted_prompt_cancellations_thread_id_cancel_command_id_key").on(
      table.threadId,
      table.cancelCommandId,
    ),
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [rikaHostedThreads.id, rikaHostedThreads.ownerId],
      name: "rika_hosted_prompt_cancellations_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    check("rika_hosted_prompt_cancellations_actor_check", sql`(jsonb_typeof(actor) = 'object')`),
    check("rika_hosted_prompt_cancellations_owner_check", sql`rika_hosted_actor_matches_owner(actor, owner_id)`),
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

export const rikaHostedThreadSocketTickets = pgTable(
  "rika_hosted_thread_socket_tickets",
  {
    id: text().primaryKey(),
    ticketDigest: text("ticket_digest").notNull(),
    userId: text("user_id").notNull(),
    clientId: text("client_id").notNull(),
    deviceId: text("device_id").notNull(),
    audience: text().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.clientId, table.userId],
      foreignColumns: [rikaHostedClients.id, rikaHostedClients.userId],
      name: "rika_hosted_thread_socket_tickets_client_id_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.deviceId, table.userId],
      foreignColumns: [rikaHostedDevices.id, rikaHostedDevices.userId],
      name: "rika_hosted_thread_socket_tickets_device_id_user_id_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_thread_socket_tickets_active")
      .using(
        "btree",
        table.ticketDigest.asc().nullsLast(),
        table.audience.asc().nullsLast(),
        table.expiresAt.asc().nullsLast(),
      )
      .where(sql`((consumed_at IS NULL) AND (revoked_at IS NULL))`),
    unique("rika_hosted_thread_socket_tickets_ticket_digest_key").on(table.ticketDigest),
    check("rika_hosted_thread_socket_tickets_audience_check", sql`(length(audience) > 0)`),
    check("rika_hosted_thread_socket_tickets_check", sql`(expires_at > issued_at)`),
    check("rika_hosted_thread_socket_tickets_check1", sql`((consumed_at IS NULL) OR (consumed_at >= issued_at))`),
    check("rika_hosted_thread_socket_tickets_check2", sql`((revoked_at IS NULL) OR (revoked_at >= issued_at))`),
  ],
)

export const rikaHostedThreads = pgTable(
  "rika_hosted_threads",
  {
    id: text().primaryKey(),
    archiveSourceThreadId: text("archive_source_thread_id"),
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    projectId: text("project_id"),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    executorKind: rikaHostedExecutorKind("executor_kind").notNull(),
    inheritProjectGrants: boolean("inherit_project_grants").notNull(),
    nextCommandSequence: bigint("next_command_sequence", { mode: "number" }).default(1).notNull(),
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
    check("rika_hosted_threads_next_command_sequence_check", sql`(next_command_sequence >= 1)`),
    check("rika_hosted_threads_next_event_sequence_check", sql`(next_event_sequence >= 1)`),
  ],
)

export const rikaHostedToolAuditRecords = pgTable(
  "rika_hosted_tool_audit_records",
  {
    sequence: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    auditGroupId: text("audit_group_id").notNull(),
    phase: text().notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    turnId: text("turn_id").notNull(),
    actor: jsonb().notNull(),
    decisionActor: jsonb("decision_actor"),
    policyId: text("policy_id").notNull(),
    policyVersion: integer("policy_version").notNull(),
    capability: text().notNull(),
    capabilities: jsonb().notNull(),
    sideEffect: text("side_effect").notNull(),
    approval: text().notNull(),
    replayPolicy: text("replay_policy").notNull(),
    authorizationId: text("authorization_id"),
    authorizationCheckpoint: jsonb("authorization_checkpoint"),
    module: text().notNull(),
    operation: text().notNull(),
    operationKey: text("operation_key").notNull(),
    callId: text("call_id").notNull(),
    argumentsDigest: text("arguments_digest").notNull(),
    workspaceId: text("workspace_id").notNull(),
    repository: jsonb(),
    branch: text(),
    executor: jsonb().notNull(),
    decision: text().notNull(),
    outcome: text().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.threadId, table.ownerId, table.workspaceId],
      foreignColumns: [rikaHostedThreads.id, rikaHostedThreads.ownerId, rikaHostedThreads.workspaceId],
      name: "rika_hosted_tool_audit_record_thread_id_owner_id_workspace_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.ownerId],
      foreignColumns: [rikaHostedWorkspaces.id, rikaHostedWorkspaces.ownerId],
      name: "rika_hosted_tool_audit_records_workspace_id_owner_id_fkey",
    }).onDelete("restrict"),
    index("rika_hosted_tool_audit_authorization")
      .using(
        "btree",
        table.ownerId.asc().nullsLast(),
        table.threadId.asc().nullsLast(),
        table.turnId.asc().nullsLast(),
        table.authorizationId.asc().nullsLast(),
        table.sequence.desc().nullsFirst(),
      )
      .where(sql`(authorization_id IS NOT NULL)`),
    uniqueIndex("rika_hosted_tool_audit_decision_identity")
      .on(table.auditGroupId)
      .where(sql`(phase = 'decision')`),
    index("rika_hosted_tool_audit_owner_timeline").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.sequence.desc().nullsFirst(),
    ),
    index("rika_hosted_tool_audit_thread_timeline").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.threadId.asc().nullsLast(),
      table.sequence.desc().nullsFirst(),
    ),
    check("rika_hosted_tool_audit_records_actor_check", sql`(jsonb_typeof(actor) = 'object'::text)`),
    check("rika_hosted_tool_audit_records_approval_check", sql`(approval = ANY (ARRAY['none'::text, 'exact'::text]))`),
    check("rika_hosted_tool_audit_records_arguments_digest_check", sql`(arguments_digest ~ '^[a-f0-9]{64}$'::text)`),
    check("rika_hosted_tool_audit_records_audit_group_id_check", sql`(audit_group_id ~ '^[a-f0-9]{64}$'::text)`),
    check(
      "rika_hosted_tool_audit_records_authorization_checkpoint_check",
      sql`((authorization_checkpoint IS NULL) OR ((jsonb_typeof(authorization_checkpoint) = 'object'::text) AND (authorization_checkpoint ?& ARRAY['version'::text, 'cursor'::text, 'digest'::text]) AND (authorization_checkpoint = jsonb_build_object('version', (authorization_checkpoint -> 'version'::text), 'cursor', (authorization_checkpoint -> 'cursor'::text), 'digest', (authorization_checkpoint -> 'digest'::text))) AND ((authorization_checkpoint ->> 'digest'::text) ~ '^[a-f0-9]{64}$'::text)))`,
    ),
    check("rika_hosted_tool_audit_records_call_id_check", sql`(length(call_id) > 0)`),
    check("rika_hosted_tool_audit_records_capabilities_check", sql`(jsonb_typeof(capabilities) = 'array'::text)`),
    check("rika_hosted_tool_audit_records_capability_check", sql`(length(capability) > 0)`),
    check("rika_hosted_tool_audit_records_check", sql`rika_hosted_actor_matches_owner(actor, owner_id)`),
    check(
      "rika_hosted_tool_audit_records_check1",
      sql`((decision_actor IS NULL) OR rika_hosted_actor_matches_owner(decision_actor, owner_id))`,
    ),
    check("rika_hosted_tool_audit_records_check2", sql`((phase = 'decision'::text) = (decision_actor IS NOT NULL))`),
    check(
      "rika_hosted_tool_audit_records_check3",
      sql`((decision = ANY (ARRAY['approved'::text, 'denied'::text])) = (decision_actor IS NOT NULL))`,
    ),
    check("rika_hosted_tool_audit_records_check4", sql`((approval = 'exact'::text) OR (authorization_id IS NULL))`),
    check(
      "rika_hosted_tool_audit_records_check5",
      sql`((authorization_checkpoint IS NULL) OR (authorization_id IS NOT NULL))`,
    ),
    check(
      "rika_hosted_tool_audit_records_decision_actor_check",
      sql`((decision_actor IS NULL) OR (jsonb_typeof(decision_actor) = 'object'::text))`,
    ),
    check(
      "rika_hosted_tool_audit_records_decision_check",
      sql`(decision = ANY (ARRAY['not-required'::text, 'pending'::text, 'approved'::text, 'denied'::text]))`,
    ),
    check(
      "rika_hosted_tool_audit_records_executor_check",
      sql`((jsonb_typeof(executor) = 'object'::text) AND (executor ?& ARRAY['kind'::text, 'assignmentId'::text, 'generation'::text, 'leaseEpoch'::text, 'instanceId'::text, 'executorId'::text, 'processIncarnation'::text]) AND (executor = jsonb_build_object('kind', (executor -> 'kind'::text), 'assignmentId', (executor -> 'assignmentId'::text), 'generation', (executor -> 'generation'::text), 'leaseEpoch', (executor -> 'leaseEpoch'::text), 'instanceId', (executor -> 'instanceId'::text), 'executorId', (executor -> 'executorId'::text), 'processIncarnation', (executor -> 'processIncarnation'::text))))`,
    ),
    check("rika_hosted_tool_audit_records_module_check", sql`(length(module) > 0)`),
    check("rika_hosted_tool_audit_records_operation_check", sql`(length(operation) > 0)`),
    check("rika_hosted_tool_audit_records_operation_key_check", sql`(length(operation_key) > 0)`),
    check(
      "rika_hosted_tool_audit_records_outcome_check",
      sql`(outcome = ANY (ARRAY['admitted'::text, 'suspended'::text, 'succeeded'::text, 'failed'::text, 'denied'::text, 'unknown'::text]))`,
    ),
    check(
      "rika_hosted_tool_audit_records_phase_check",
      sql`(phase = ANY (ARRAY['admission'::text, 'decision'::text, 'outcome'::text]))`,
    ),
    check("rika_hosted_tool_audit_records_policy_id_check", sql`(length(policy_id) > 0)`),
    check("rika_hosted_tool_audit_records_policy_version_check", sql`(policy_version > 0)`),
    check(
      "rika_hosted_tool_audit_records_replay_policy_check",
      sql`(replay_policy = ANY (ARRAY['none'::text, 'never'::text, 'provider-idempotent'::text]))`,
    ),
    check(
      "rika_hosted_tool_audit_records_repository_check",
      sql`((repository IS NULL) OR ((jsonb_typeof(repository) = 'object'::text) AND (repository ? 'identity'::text) AND (repository = jsonb_build_object('identity', (repository -> 'identity'::text)))))`,
    ),
    check(
      "rika_hosted_tool_audit_records_side_effect_check",
      sql`(side_effect = ANY (ARRAY['none'::text, 'workspace'::text, 'terminal'::text, 'git'::text, 'secret'::text, 'publishing'::text, 'hosted-state'::text, 'external'::text]))`,
    ),
    check("rika_hosted_tool_audit_records_turn_id_check", sql`(length(turn_id) > 0)`),
    check("rika_hosted_tool_audit_records_workspace_id_check", sql`(length(workspace_id) > 0)`),
  ],
)

export const rikaHostedTurnClaims = pgTable(
  "rika_hosted_turn_claims",
  {
    turnId: text("turn_id")
      .primaryKey()
      .references(() => rikaTurns.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => rikaThreads.id, { onDelete: "cascade" }),
    workerId: text("worker_id").notNull(),
    claimToken: text("claim_token").notNull(),
    claimedAt: doublePrecision("claimed_at").notNull(),
    heartbeatAt: doublePrecision("heartbeat_at").notNull(),
    expiresAt: doublePrecision("expires_at").notNull(),
  },
  (table) => [
    index("rika_hosted_turn_claims_expiry").using(
      "btree",
      table.expiresAt.asc().nullsLast(),
      table.threadId.asc().nullsLast(),
    ),
    unique("rika_hosted_turn_claims_claim_token_key").on(table.claimToken),
    unique("rika_hosted_turn_claims_thread_id_key").on(table.threadId),
    check("rika_hosted_turn_claims_check", sql`(expires_at > heartbeat_at)`),
    check("rika_hosted_turn_claims_claim_token_check", sql`(length(claim_token) > 0)`),
    check("rika_hosted_turn_claims_worker_id_check", sql`(length(worker_id) > 0)`),
  ],
)

export const rikaHostedWorkspaceCapabilityAdmissions = pgTable(
  "rika_hosted_workspace_capability_admissions",
  {
    threadId: text("thread_id").notNull(),
    turnId: text("turn_id").notNull(),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => rikaHostedExecutorAssignments.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    assignmentGeneration: bigint("assignment_generation", { mode: "number" }).notNull(),
    environmentDigest: text("environment_digest").notNull(),
    requiredCapabilities: jsonb("required_capabilities").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.turnId], name: "rika_hosted_workspace_capability_admissions_pkey" }),
    check("rika_hosted_workspace_capability_ad_assignment_generation_check", sql`(assignment_generation >= 1)`),
    check(
      "rika_hosted_workspace_capability_admis_environment_digest_check",
      sql`(environment_digest ~ '^sha256:[a-f0-9]{64}$'::text)`,
    ),
  ],
)

export const rikaHostedWorkspacePreparationOutput = pgTable(
  "rika_hosted_workspace_preparation_output",
  {
    assignmentId: text("assignment_id").notNull(),
    generation: bigint({ mode: "number" }).notNull(),
    sequence: bigserial({ mode: "number" }).notNull(),
    attempt: integer().notNull(),
    phase: rikaHostedPreparationPhase().notNull(),
    stream: text().notNull(),
    text: text().notNull(),
    redacted: boolean().notNull(),
    truncated: boolean().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.assignmentId, table.generation, table.sequence],
      name: "rika_hosted_workspace_preparation_output_pkey",
    }),
    foreignKey({
      columns: [table.assignmentId, table.generation],
      foreignColumns: [rikaHostedWorkspacePreparations.assignmentId, rikaHostedWorkspacePreparations.generation],
      name: "rika_hosted_workspace_preparation_assignment_id_generation_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_workspace_preparation_output_bounded").using(
      "btree",
      table.assignmentId.asc().nullsLast(),
      table.generation.asc().nullsLast(),
      table.sequence.desc().nullsFirst(),
    ),
    check("rika_hosted_workspace_preparation_output_attempt_check", sql`(attempt >= 1)`),
    check("rika_hosted_workspace_preparation_output_redacted_check", sql`redacted`),
    check(
      "rika_hosted_workspace_preparation_output_stream_check",
      sql`(stream = ANY (ARRAY['stdout'::text, 'stderr'::text]))`,
    ),
    check("rika_hosted_workspace_preparation_output_text_check", sql`(octet_length(text) <= 16384)`),
  ],
)

export const rikaHostedWorkspacePreparations = pgTable(
  "rika_hosted_workspace_preparations",
  {
    assignmentId: text("assignment_id").notNull(),
    ownerId: text("owner_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    generation: bigint({ mode: "number" }).notNull(),
    leaseEpoch: bigint("lease_epoch", { mode: "number" }).notNull(),
    attempt: integer().notNull(),
    state: rikaHostedPreparationState().notNull(),
    phase: rikaHostedPreparationPhase().notNull(),
    evidence: jsonb(),
    failure: jsonb(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.assignmentId, table.generation], name: "rika_hosted_workspace_preparations_pkey" }),
    foreignKey({
      columns: [table.assignmentId, table.ownerId],
      foreignColumns: [rikaHostedExecutorAssignments.id, rikaHostedExecutorAssignments.ownerId],
      name: "rika_hosted_workspace_preparations_assignment_id_owner_id_fkey",
    }).onDelete("cascade"),
    check("rika_hosted_workspace_preparations_attempt_check", sql`(attempt >= 1)`),
    check(
      "rika_hosted_workspace_preparations_check",
      sql`(((state = 'preparing'::rika_hosted_preparation_state) AND (evidence IS NULL) AND (failure IS NULL)) OR ((state = 'ready'::rika_hosted_preparation_state) AND (evidence IS NOT NULL) AND (failure IS NULL)) OR ((state = 'failed'::rika_hosted_preparation_state) AND (evidence IS NULL) AND (failure IS NOT NULL)))`,
    ),
    check(
      "rika_hosted_workspace_preparations_evidence_check",
      sql`((evidence IS NULL) OR (octet_length((evidence)::text) <= 16384))`,
    ),
    check(
      "rika_hosted_workspace_preparations_failure_check",
      sql`((failure IS NULL) OR (octet_length((failure)::text) <= 4096))`,
    ),
    check("rika_hosted_workspace_preparations_generation_check", sql`(generation >= 1)`),
    check("rika_hosted_workspace_preparations_lease_epoch_check", sql`(lease_epoch >= 1)`),
    index("rika_hosted_workspace_preparations_overdue")
      .on(table.deadlineAt)
      .where(sql`(state = 'preparing')`),
  ],
)

export const rikaHostedWorkspaces = pgTable(
  "rika_hosted_workspaces",
  {
    id: text().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    projectId: text("project_id"),
    createdByUserId: text("created_by_user_id").notNull(),
    executorKind: rikaHostedExecutorKind("executor_kind").notNull(),
    inheritProjectGrants: boolean("inherit_project_grants").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.ownerId],
      foreignColumns: [rikaHostedProjects.id, rikaHostedProjects.ownerId],
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

export const rikaThreadDeletionOutbox = pgTable("rika_thread_deletion_outbox", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => rikaThreads.id, { onDelete: "cascade" }),
  requestedAt: doublePrecision("requested_at").notNull(),
})

export const rikaThreadQueueState = pgTable(
  "rika_thread_queue_state",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => rikaThreads.id, { onDelete: "cascade" }),
    revision: integer().default(0).notNull(),
    queuedCount: integer("queued_count").default(0).notNull(),
  },
  (_table) => [
    check("rika_thread_queue_state_queued_count_check", sql`(queued_count >= 0)`),
    check("rika_thread_queue_state_revision_check", sql`(revision >= 0)`),
  ],
)

export const rikaThreadReadState = pgTable("rika_thread_read_state", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => rikaThreads.id, { onDelete: "cascade" }),
  lastReadAt: doublePrecision("last_read_at").notNull(),
})

export const rikaThreadTurnActivity = pgTable(
  "rika_thread_turn_activity",
  {
    turnId: text("turn_id")
      .primaryKey()
      .references(() => rikaTurns.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => rikaThreads.id, { onDelete: "cascade" }),
    projectedCursor: text("projected_cursor"),
    complete: integer().default(0).notNull(),
    added: integer().default(0).notNull(),
    modified: integer().default(0).notNull(),
    removed: integer().default(0).notNull(),
    lastEventAt: doublePrecision("last_event_at"),
    updatedAt: doublePrecision("updated_at").notNull(),
  },
  (table) => [
    index("rika_thread_turn_activity_summary").using(
      "btree",
      table.threadId.asc().nullsLast(),
      table.lastEventAt.desc().nullsFirst(),
    ),
    check("rika_thread_turn_activity_added_check", sql`(added >= 0)`),
    check("rika_thread_turn_activity_complete_check", sql`(complete = ANY (ARRAY[0, 1]))`),
    check("rika_thread_turn_activity_modified_check", sql`(modified >= 0)`),
    check("rika_thread_turn_activity_removed_check", sql`(removed >= 0)`),
  ],
)

export const rikaThreads = pgTable(
  "rika_threads",
  {
    id: text().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    workspace: text().notNull(),
    title: text().notNull(),
    labelsJson: text("labels_json").default("[]").notNull(),
    pinned: integer().default(0).notNull(),
    archived: integer().default(0).notNull(),
    lineageJson: text("lineage_json").default('{"_tag":"Original"}').notNull(),
    createdAt: doublePrecision("created_at").notNull(),
    updatedAt: doublePrecision("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.workspace],
      foreignColumns: [rikaWorkspaces.ownerId, rikaWorkspaces.path],
      name: "rika_threads_owner_id_workspace_fkey",
    }),
    index("rika_threads_listing").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.pinned.desc().nullsFirst(),
      table.updatedAt.desc().nullsFirst(),
      table.id.asc().nullsLast(),
    ),
    check("rika_threads_archived_check", sql`(archived = ANY (ARRAY[0, 1]))`),
    check("rika_threads_pinned_check", sql`(pinned = ANY (ARRAY[0, 1]))`),
  ],
)

export const rikaTranscriptCheckpoints = pgTable(
  "rika_transcript_checkpoints",
  {
    turnId: text("turn_id")
      .primaryKey()
      .references(() => rikaTurns.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => rikaThreads.id, { onDelete: "cascade" }),
    checkpointGeneration: integer("checkpoint_generation").default(0).notNull(),
    revision: integer().default(-1).notNull(),
    projectionVersion: integer("projection_version").default(1).notNull(),
    stateJson: text("state_json").notNull(),
    projectorVersion: integer("projector_version"),
    projectorCursor: text("projector_cursor"),
    projectorState: text("projector_state"),
    updatedAt: doublePrecision("updated_at").notNull(),
  },
  (_table) => [
    check(
      "rika_transcript_checkpoints_check",
      sql`(((projector_version IS NULL) AND (projector_cursor IS NULL) AND (projector_state IS NULL)) OR ((projector_version IS NOT NULL) AND (projector_cursor IS NOT NULL) AND (projector_state IS NOT NULL)))`,
    ),
    check("rika_transcript_checkpoints_checkpoint_generation_check", sql`(checkpoint_generation >= 0)`),
    check("rika_transcript_checkpoints_projection_version_check", sql`(projection_version >= 1)`),
    check(
      "rika_transcript_checkpoints_projector_version_check",
      sql`((projector_version IS NULL) OR (projector_version >= 1))`,
    ),
    check("rika_transcript_checkpoints_revision_check", sql`(revision >= '-1'::integer)`),
  ],
)

export const rikaTranscriptUnits = pgTable(
  "rika_transcript_units",
  {
    turnId: text("turn_id")
      .notNull()
      .references(() => rikaTurns.id, { onDelete: "cascade" }),
    unitKey: text("unit_key").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => rikaThreads.id, { onDelete: "cascade" }),
    unitOrderKey: text("unit_order_key").notNull(),
    parentId: text("parent_id"),
    revision: integer().notNull(),
    unitJson: text("unit_json").notNull(),
    createdAt: doublePrecision("created_at").notNull(),
    updatedAt: doublePrecision("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.turnId, table.unitKey], name: "rika_transcript_units_pkey" }),
    index("rika_transcript_units_page").using(
      "btree",
      table.threadId.asc().nullsLast(),
      table.createdAt.desc().nullsFirst(),
      table.turnId.desc().nullsFirst(),
      table.unitOrderKey.desc().nullsFirst(),
    ),
    index("rika_transcript_units_turn").using(
      "btree",
      table.turnId.asc().nullsLast(),
      table.unitOrderKey.asc().nullsLast(),
    ),
    unique("rika_transcript_units_turn_id_unit_order_key_key").on(table.turnId, table.unitOrderKey),
  ],
)

export const rikaTurnAdmissionOutbox = pgTable(
  "rika_turn_admission_outbox",
  {
    turnId: text("turn_id")
      .primaryKey()
      .references(() => rikaTurns.id, { onDelete: "cascade" }),
    startInputJson: text("start_input_json").notNull(),
    preparedTurnJson: text("prepared_turn_json"),
    admissionLinkJson: text("admission_link_json"),
    preparedAt: doublePrecision("prepared_at").notNull(),
    admittedAt: doublePrecision("admitted_at"),
    activationRequestedAt: doublePrecision("activation_requested_at"),
  },
  (table) => [
    index("rika_turn_admission_outbox_activation").on(table.activationRequestedAt, table.preparedAt, table.turnId),
  ],
)

export const rikaTurnSteeringOutbox = pgTable(
  "rika_turn_steering_outbox",
  {
    requestId: text("request_id").primaryKey(),
    targetTurnId: text("target_turn_id")
      .notNull()
      .references(() => rikaTurns.id, { onDelete: "cascade" }),
    sourceTurnId: text("source_turn_id").references(() => rikaTurns.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => rikaThreads.id, { onDelete: "cascade" }),
    admissionJson: text("admission_json").notNull(),
    sourceWithdrawn: integer("source_withdrawn").notNull(),
    status: text().notNull(),
    preparedAt: doublePrecision("prepared_at").notNull(),
  },
  (table) => [
    unique("rika_turn_steering_outbox_source_turn_id_key").on(table.sourceTurnId),
    check("rika_turn_steering_outbox_source_withdrawn_check", sql`(source_withdrawn = ANY (ARRAY[0, 1]))`),
    check(
      "rika_turn_steering_outbox_status_check",
      sql`(status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text]))`,
    ),
  ],
)

export const rikaTurns = pgTable(
  "rika_turns",
  {
    id: text().primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => rikaThreads.id, { onDelete: "cascade" }),
    prompt: text().notNull(),
    status: text().notNull(),
    createdAt: doublePrecision("created_at").notNull(),
    updatedAt: doublePrecision("updated_at").notNull(),
    promptPartsJson: text("prompt_parts_json"),
    executionRouteJson: text("execution_route_json"),
    executionLinkJson: text("execution_link_json"),
    queueClaimToken: text("queue_claim_token"),
    authorJson: text("author_json").default('{"_tag":"Human"}').notNull(),
    lineageJson: text("lineage_json").default('{"_tag":"Original"}').notNull(),
    shellCommand: text("shell_command"),
    shellResultText: text("shell_result_text"),
    shellResultTruncated: integer("shell_result_truncated"),
    shellResultExitCode: integer("shell_result_exit_code"),
    turnKind: text("turn_kind").default("AgentExecution").notNull(),
  },
  (table) => [
    uniqueIndex("rika_turns_one_active")
      .using("btree", table.threadId.asc().nullsLast())
      .where(
        sql`((turn_kind = 'AgentExecution'::text) AND (status = ANY (ARRAY['accepted'::text, 'running'::text, 'waiting'::text, 'cancelling'::text])))`,
      ),
    index("rika_turns_queue").using(
      "btree",
      table.threadId.asc().nullsLast(),
      table.status.asc().nullsLast(),
      table.createdAt.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    uniqueIndex("rika_turns_queue_claim")
      .using("btree", table.threadId.asc().nullsLast())
      .where(sql`(queue_claim_token IS NOT NULL)`),
    index("rika_turns_thread").using(
      "btree",
      table.threadId.asc().nullsLast(),
      table.createdAt.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    index("rika_turns_thread_nonqueued")
      .using(
        "btree",
        table.threadId.asc().nullsLast(),
        table.createdAt.desc().nullsFirst(),
        table.id.desc().nullsFirst(),
      )
      .where(sql`(status <> 'queued'::text)`),
    index("rika_turns_thread_updated").using(
      "btree",
      table.threadId.asc().nullsLast(),
      table.updatedAt.desc().nullsFirst(),
    ),
    check(
      "rika_turns_check",
      sql`(((turn_kind = 'AgentExecution'::text) AND (execution_route_json IS NOT NULL) AND (shell_command IS NULL) AND (shell_result_text IS NULL) AND (shell_result_truncated IS NULL) AND (shell_result_exit_code IS NULL)) OR ((turn_kind = 'RecordedShell'::text) AND (shell_command IS NOT NULL) AND (length(shell_command) > 0) AND (prompt = ('$ '::text || shell_command)) AND (prompt_parts_json IS NULL) AND (execution_route_json IS NULL) AND (execution_link_json IS NULL) AND (queue_claim_token IS NULL) AND (author_json = '{"_tag":"Human"}'::text) AND (lineage_json = '{"_tag":"Original"}'::text) AND (status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])) AND (((status = 'running'::text) AND (shell_result_text IS NULL) AND (shell_result_truncated IS NULL) AND (shell_result_exit_code IS NULL)) OR ((status = ANY (ARRAY['completed'::text, 'failed'::text, 'cancelled'::text])) AND (shell_result_text IS NOT NULL) AND (shell_result_truncated = ANY (ARRAY[0, 1]))))))`,
    ),
    check(
      "rika_turns_status_check",
      sql`(status = ANY (ARRAY['accepted'::text, 'queued'::text, 'running'::text, 'waiting'::text, 'cancelling'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))`,
    ),
  ],
)

export const rikaWorkspaces = pgTable(
  "rika_workspaces",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => rikaHostedOwners.id, { onDelete: "cascade" }),
    path: text().notNull(),
    createdAt: doublePrecision("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.path], name: "rika_workspaces_pkey" })],
)

export const rikaThreadPickerSummary = pgView("rika_thread_picker_summary", {
  threadId: text("thread_id"),
  workspace: text(),
  title: text(),
  pinned: integer(),
  archived: integer(),
  statusRank: integer("status_rank"),
  lastStatus: text("last_status"),
  lastActivityAt: doublePrecision("last_activity_at"),
  turnCount: integer("turn_count"),
  currentActivityCount: integer("current_activity_count"),
  added: integer(),
  modified: integer(),
  removed: integer(),
}).as(
  sql`SELECT thread.id AS thread_id, thread.workspace, thread.title, thread.pinned, thread.archived, CASE WHEN count(turn.id) FILTER (WHERE turn.status = ANY (ARRAY['accepted'::text, 'running'::text, 'waiting'::text, 'cancelling'::text])) > 0 THEN 2 WHEN count(turn.id) FILTER (WHERE turn.status = 'queued'::text) > 0 THEN 1 ELSE 0 END AS status_rank, ( SELECT latest.status FROM rika_turns latest WHERE latest.thread_id = thread.id ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1) AS last_status, GREATEST(thread.created_at, COALESCE(max(turn.updated_at), 0::double precision), COALESCE(max(activity.last_event_at), 0::double precision)) AS last_activity_at, count(turn.id)::integer AS turn_count, count(turn.id) FILTER (WHERE activity.turn_id IS NOT NULL AND ((turn.status <> ALL (ARRAY['completed'::text, 'failed'::text, 'cancelled'::text])) OR activity.complete = 1))::integer AS current_activity_count, COALESCE(sum(activity.added), 0::bigint)::integer AS added, COALESCE(sum(activity.modified), 0::bigint)::integer AS modified, COALESCE(sum(activity.removed), 0::bigint)::integer AS removed FROM rika_threads thread LEFT JOIN rika_turns turn ON turn.thread_id = thread.id LEFT JOIN rika_thread_turn_activity activity ON activity.turn_id = turn.id GROUP BY thread.id`,
)
