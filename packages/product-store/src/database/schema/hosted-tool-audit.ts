import {
  pgTable,
  text,
  integer,
  bigint,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  foreignKey,
  check,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { SchemaReference } from "../reference"

export const rikaHostedToolAuditRecords = pgTable(
  "rika_hosted_tool_audit_records",
  {
    sequence: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    auditGroupId: text("audit_group_id").notNull(),
    phase: text().notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
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
      foreignColumns: [
        SchemaReference.column("rikaHostedThreads", "id"),
        SchemaReference.column("rikaHostedThreads", "ownerId"),
        SchemaReference.column("rikaHostedThreads", "workspaceId"),
      ],
      name: "rika_hosted_tool_audit_record_thread_id_owner_id_workspace_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.ownerId],
      foreignColumns: [
        SchemaReference.column("rikaHostedWorkspaces", "id"),
        SchemaReference.column("rikaHostedWorkspaces", "ownerId"),
      ],
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
