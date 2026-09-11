import { check, foreignKey, primaryKey, bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { SchemaReference } from "../../reference"

export const rikaBoxAssignmentBindings = pgTable(
  "rika_box_assignment_bindings",
  {
    assignmentId: text("assignment_id").notNull(),
    generation: bigint({ mode: "number" }).notNull(),
    boxId: text("box_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.assignmentId, table.generation],
      name: "rika_box_assignment_bindings_pkey",
    }),
    foreignKey({
      columns: [table.assignmentId],
      foreignColumns: [SchemaReference.column("rikaHostedExecutorAssignments", "id")],
      name: "rika_box_assignment_bindings_assignment_id_fkey",
    }).onDelete("cascade"),
    check("rika_box_assignment_bindings_generation_check", sql`${table.generation} >= 1`),
    check(
      "rika_box_assignment_bindings_box_id_check",
      sql`${table.boxId} ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'`,
    ),
  ],
)
