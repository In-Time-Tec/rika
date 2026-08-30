import {
  pgTable,
  text,
  integer,
  doublePrecision,
  index,
  foreignKey,
  primaryKey,
  unique,
  check,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { SchemaReference } from "../reference"

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
      .references(() => SchemaReference.column("rikaTurns", "id"), { onDelete: "cascade" }),
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
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
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
    unique("rika_threads_hosted_authority").on(table.id, table.ownerId, table.workspace),
    check("rika_threads_archived_check", sql`(archived = ANY (ARRAY[0, 1]))`),
    check("rika_threads_pinned_check", sql`(pinned = ANY (ARRAY[0, 1]))`),
  ],
)
export const rikaWorkspaces = pgTable(
  "rika_workspaces",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
    path: text().notNull(),
    createdAt: doublePrecision("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.path], name: "rika_workspaces_pkey" })],
)

SchemaReference.register("rikaThreads", { id: rikaThreads.id })
