import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const thread_events = sqliteTable(
  "thread_events",
  {
    id: text().primaryKey(),
    thread_id: text().notNull(),
    turn_id: text(),
    sequence: integer().notNull(),
    version: integer().notNull(),
    type: text().notNull(),
    payload: text().notNull(),
    message_id: text(),
    tool_call_id: text(),
    artifact_id: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("thread_events_thread_sequence_idx").on(table.thread_id, table.sequence),
    index("thread_events_thread_created_idx").on(table.thread_id, table.created_at),
    index("thread_events_type_idx").on(table.type),
  ],
)

export type ThreadEventRow = typeof thread_events.$inferSelect
export type NewThreadEventRow = typeof thread_events.$inferInsert

export const thread_projections = sqliteTable(
  "thread_projections",
  {
    thread_id: text().primaryKey(),
    workspace_id: text().notNull(),
    user_id: text(),
    latest_message_id: text(),
    latest_message_role: text(),
    latest_message_text: text(),
    latest_message_created_at: integer(),
    title_text: text(),
    diff_additions: integer().notNull().default(0),
    diff_modifications: integer().notNull().default(0),
    diff_deletions: integer().notNull().default(0),
    active_turn_id: text(),
    active_turn_status: text(),
    archived: integer().notNull().default(0),
    last_sequence: integer().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("thread_projections_updated_idx").on(table.updated_at),
    index("thread_projections_workspace_idx").on(table.workspace_id),
  ],
)

export type ThreadProjectionRow = typeof thread_projections.$inferSelect
export type NewThreadProjectionRow = typeof thread_projections.$inferInsert

export const mcp_server_approvals = sqliteTable(
  "mcp_server_approvals",
  {
    id: text().primaryKey(),
    workspace_root: text().notNull(),
    server_name: text().notNull(),
    fingerprint: text().notNull(),
    approved_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("mcp_server_approvals_workspace_server_fingerprint_idx").on(
      table.workspace_root,
      table.server_name,
      table.fingerprint,
    ),
    index("mcp_server_approvals_workspace_idx").on(table.workspace_root),
  ],
)

export type McpServerApprovalRow = typeof mcp_server_approvals.$inferSelect
export type NewMcpServerApprovalRow = typeof mcp_server_approvals.$inferInsert

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text().primaryKey(),
    thread_id: text().notNull(),
    turn_id: text(),
    kind: text().notNull(),
    title: text(),
    content: text().notNull(),
    metadata: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("artifacts_thread_created_idx").on(table.thread_id, table.created_at),
    index("artifacts_kind_idx").on(table.kind),
  ],
)

export type ArtifactRow = typeof artifacts.$inferSelect
export type NewArtifactRow = typeof artifacts.$inferInsert

export const workspace_memberships = sqliteTable(
  "workspace_memberships",
  {
    id: text().primaryKey(),
    workspace_id: text().notNull(),
    user_id: text().notNull(),
    role: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("workspace_memberships_workspace_user_idx").on(table.workspace_id, table.user_id),
    index("workspace_memberships_user_idx").on(table.user_id),
    index("workspace_memberships_workspace_idx").on(table.workspace_id),
  ],
)

export type WorkspaceMembershipRow = typeof workspace_memberships.$inferSelect
export type NewWorkspaceMembershipRow = typeof workspace_memberships.$inferInsert
