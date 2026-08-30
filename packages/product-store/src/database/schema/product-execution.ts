import { pgTable, text, integer, doublePrecision, uniqueIndex, index, unique, check } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { SchemaReference } from "../reference"

export const rikaTurnAdmissionOutbox = pgTable("rika_turn_admission_outbox", {
  turnId: text("turn_id")
    .primaryKey()
    .references(() => rikaTurns.id, { onDelete: "cascade" }),
  startInputJson: text("start_input_json").notNull(),
  preparedAt: doublePrecision("prepared_at").notNull(),
})
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
      .references(() => SchemaReference.column("rikaThreads", "id"), { onDelete: "cascade" }),
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
      .references(() => SchemaReference.column("rikaThreads", "id"), { onDelete: "cascade" }),
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

SchemaReference.register("rikaTurns", { id: rikaTurns.id })
