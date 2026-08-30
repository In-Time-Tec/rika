import { text, integer, doublePrecision, pgView } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const rikaThreadPickerSummary = pgView("rika_thread_picker_summary", {
  threadId: text("thread_id"),
  workspace: text(),
  title: text(),
  pinned: integer(),
  archived: integer(),
  statusRank: integer("status_rank"),
  lastStatus: text("last_status"),
  lastActivityAt: doublePrecision("last_activity_at"),
  turnCount: integer("turn_count"),
  currentActivityCount: integer("current_activity_count"),
  added: integer(),
  modified: integer(),
  removed: integer(),
}).as(
  sql`SELECT thread.id AS thread_id, thread.workspace, thread.title, thread.pinned, thread.archived, CASE WHEN count(turn.id) FILTER (WHERE turn.status = ANY (ARRAY['accepted'::text, 'running'::text, 'waiting'::text, 'cancelling'::text])) > 0 THEN 2 WHEN count(turn.id) FILTER (WHERE turn.status = 'queued'::text) > 0 THEN 1 ELSE 0 END AS status_rank, ( SELECT latest.status FROM rika_turns latest WHERE latest.thread_id = thread.id ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1) AS last_status, GREATEST(thread.created_at, COALESCE(max(turn.updated_at), 0::double precision), COALESCE(max(activity.last_event_at), 0::double precision)) AS last_activity_at, count(turn.id)::integer AS turn_count, count(turn.id) FILTER (WHERE activity.turn_id IS NOT NULL AND ((turn.status <> ALL (ARRAY['completed'::text, 'failed'::text, 'cancelled'::text])) OR activity.complete = 1))::integer AS current_activity_count, COALESCE(sum(activity.added), 0::bigint)::integer AS added, COALESCE(sum(activity.modified), 0::bigint)::integer AS modified, COALESCE(sum(activity.removed), 0::bigint)::integer AS removed FROM rika_threads thread LEFT JOIN rika_turns turn ON turn.thread_id = thread.id LEFT JOIN rika_thread_turn_activity activity ON activity.turn_id = turn.id GROUP BY thread.id`,
)
