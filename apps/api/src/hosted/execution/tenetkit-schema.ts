import { integer, pgTable, text } from "drizzle-orm/pg-core"

export const runs = pgTable("tenetkit_runs", {
  runId: text("run_id").primaryKey(),
  status: text().notNull(),
})

export const runOperations = pgTable("tenetkit_run_operations", {
  runId: text("run_id").notNull(),
  operationId: text("operation_id").notNull(),
  operationKey: text("operation_key").notNull(),
  status: text().notNull(),
  attempt: integer().notNull(),
  startedAt: text("started_at"),
  resolutionJson: text("resolution_json"),
})
