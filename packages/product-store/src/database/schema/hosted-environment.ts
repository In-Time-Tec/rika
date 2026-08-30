import { rikaHostedPreparationPhase, rikaHostedPreparationState } from "./hosted-enums"
import {
  pgTable,
  text,
  integer,
  bigint,
  bigserial,
  timestamp,
  boolean,
  jsonb,
  customType,
  uniqueIndex,
  index,
  foreignKey,
  primaryKey,
  unique,
  check,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { SchemaReference } from "../reference"

export const rikaHostedEnvironmentValues = pgTable(
  "rika_hosted_environment_values",
  {
    id: text().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
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
      foreignColumns: [
        SchemaReference.column("rikaHostedProjects", "id"),
        SchemaReference.column("rikaHostedProjects", "ownerId"),
      ],
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
export const rikaHostedOrganizationEnvironmentPolicy = pgTable("rika_hosted_organization_environment_policy", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
  personalOverrides: boolean("personal_overrides").default(true).notNull(),
  updatedByUserId: text("updated_by_user_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`transaction_timestamp()`)
    .notNull(),
})
export const rikaHostedPhaseEgressPolicy = pgTable(
  "rika_hosted_phase_egress_policy",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
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
      foreignColumns: [
        SchemaReference.column("rikaHostedProjects", "id"),
        SchemaReference.column("rikaHostedProjects", "ownerId"),
      ],
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
export const rikaHostedSourceEnvironmentApprovals = pgTable(
  "rika_hosted_source_environment_approvals",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
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
      foreignColumns: [
        SchemaReference.column("rikaHostedProjects", "id"),
        SchemaReference.column("rikaHostedProjects", "ownerId"),
      ],
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
export const rikaHostedWorkspaceCapabilityAdmissions = pgTable(
  "rika_hosted_workspace_capability_admissions",
  {
    threadId: text("thread_id").notNull(),
    turnId: text("turn_id").notNull(),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedExecutorAssignments", "id"), { onDelete: "cascade" }),
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
      foreignColumns: [
        SchemaReference.column("rikaHostedExecutorAssignments", "id"),
        SchemaReference.column("rikaHostedExecutorAssignments", "ownerId"),
      ],
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
