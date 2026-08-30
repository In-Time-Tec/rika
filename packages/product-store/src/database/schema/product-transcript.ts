import { pgTable, text, integer, doublePrecision, boolean, index, primaryKey, unique, check } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { SchemaReference } from "../reference"

export const rikaTranscriptCheckpoints = pgTable(
  "rika_transcript_checkpoints",
  {
    turnId: text("turn_id")
      .primaryKey()
      .references(() => SchemaReference.column("rikaTurns", "id"), { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => SchemaReference.column("rikaThreads", "id"), { onDelete: "cascade" }),
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
export const rikaTranscriptThreadUsage = pgTable("rika_transcript_thread_usage", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => SchemaReference.column("rikaThreads", "id"), { onDelete: "cascade" }),
  accumulatorJson: text("accumulator_json").notNull(),
  summaryJson: text("summary_json").notNull(),
  updatedAt: doublePrecision("updated_at").notNull(),
})
export const rikaTranscriptTurnUsage = pgTable(
  "rika_transcript_turn_usage",
  {
    turnId: text("turn_id")
      .primaryKey()
      .references(() => SchemaReference.column("rikaTurns", "id"), { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => SchemaReference.column("rikaThreads", "id"), { onDelete: "cascade" }),
    createdAt: doublePrecision("created_at").notNull(),
    usageJson: text("usage_json").notNull(),
    hasContext: boolean("has_context").notNull(),
    contextCapacityJson: text("context_capacity_json"),
    activeSince: doublePrecision("active_since"),
    updatedAt: doublePrecision("updated_at").notNull(),
  },
  (table) => [
    index("rika_transcript_turn_usage_thread").on(table.threadId, table.createdAt.desc(), table.turnId.desc()),
    index("rika_transcript_turn_usage_context")
      .on(table.threadId, table.createdAt.desc(), table.turnId.desc())
      .where(sql`has_context`),
    index("rika_transcript_turn_usage_active")
      .on(table.threadId, table.activeSince.asc())
      .where(sql`active_since IS NOT NULL`),
  ],
)
export const rikaTranscriptUnits = pgTable(
  "rika_transcript_units",
  {
    turnId: text("turn_id")
      .notNull()
      .references(() => SchemaReference.column("rikaTurns", "id"), { onDelete: "cascade" }),
    unitKey: text("unit_key").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => SchemaReference.column("rikaThreads", "id"), { onDelete: "cascade" }),
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
