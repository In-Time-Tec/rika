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
