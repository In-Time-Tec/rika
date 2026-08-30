import { rikaHostedGrantRole, rikaHostedRepositoryPublicationState } from "./hosted-enums"
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
      foreignColumns: [
        SchemaReference.column("rikaHostedExecutorAssignments", "id"),
        SchemaReference.column("rikaHostedExecutorAssignments", "ownerId"),
      ],
      name: "rika_hosted_repository_publications_assignment_id_owner_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.projectId, table.ownerId],
      foreignColumns: [rikaHostedProjects.id, rikaHostedProjects.ownerId],
      name: "rika_hosted_repository_publications_project_id_owner_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [
        SchemaReference.column("rikaHostedThreads", "id"),
        SchemaReference.column("rikaHostedThreads", "ownerId"),
      ],
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

SchemaReference.register("rikaHostedOwners", { id: rikaHostedOwners.id })
SchemaReference.register("rikaHostedProjects", { id: rikaHostedProjects.id, ownerId: rikaHostedProjects.ownerId })
