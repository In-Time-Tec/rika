import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration021 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE INDEX rika_turns_thread_updated ON rika_turns (thread_id, updated_at DESC)`
  yield* sql`CREATE INDEX rika_turns_thread_nonqueued ON rika_turns (thread_id, created_at DESC, id DESC)
    WHERE status <> 'queued'`
  yield* sql`CREATE TABLE rika_thread_picker_summary (
    thread_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    workspace TEXT NOT NULL,
    title TEXT NOT NULL,
    pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
    archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
    status_rank INTEGER NOT NULL,
    waiting_count INTEGER NOT NULL CHECK (waiting_count >= 0),
    running_count INTEGER NOT NULL CHECK (running_count >= 0),
    queued_count INTEGER NOT NULL CHECK (queued_count >= 0),
    last_status TEXT,
    last_turn_created_at INTEGER,
    last_turn_id TEXT,
    last_activity_at INTEGER NOT NULL,
    turn_count INTEGER NOT NULL CHECK (turn_count >= 0),
    current_activity_count INTEGER NOT NULL CHECK (current_activity_count >= 0),
    added INTEGER NOT NULL CHECK (added >= 0),
    modified INTEGER NOT NULL CHECK (modified >= 0),
    removed INTEGER NOT NULL CHECK (removed >= 0)
  )`
  yield* sql`CREATE INDEX rika_thread_picker_summary_listing ON rika_thread_picker_summary (
    archived, pinned DESC, last_activity_at DESC, thread_id ASC
  )`
  yield* sql`INSERT INTO rika_thread_picker_summary (
    thread_id, workspace, title, pinned, archived, status_rank, waiting_count, running_count, queued_count,
    last_status, last_turn_created_at, last_turn_id, last_activity_at, turn_count, current_activity_count,
    added, modified, removed
  ) SELECT
    thread.id, thread.workspace, thread.title, thread.pinned, thread.archived,
    CASE
      WHEN SUM(CASE WHEN turn.status = 'waiting' THEN 1 ELSE 0 END) > 0 THEN 3
      WHEN SUM(CASE WHEN turn.status IN ('accepted', 'running') THEN 1 ELSE 0 END) > 0 THEN 2
      WHEN SUM(CASE WHEN turn.status = 'queued' THEN 1 ELSE 0 END) > 0 THEN 1
      ELSE 0
    END,
    SUM(CASE WHEN turn.status = 'waiting' THEN 1 ELSE 0 END),
    SUM(CASE WHEN turn.status IN ('accepted', 'running') THEN 1 ELSE 0 END),
    SUM(CASE WHEN turn.status = 'queued' THEN 1 ELSE 0 END),
    (SELECT last.status FROM rika_turns AS last WHERE last.thread_id = thread.id
      ORDER BY last.created_at DESC, last.id DESC LIMIT 1),
    (SELECT last.created_at FROM rika_turns AS last WHERE last.thread_id = thread.id
      ORDER BY last.created_at DESC, last.id DESC LIMIT 1),
    (SELECT last.id FROM rika_turns AS last WHERE last.thread_id = thread.id
      ORDER BY last.created_at DESC, last.id DESC LIMIT 1),
    MAX(thread.created_at, COALESCE(MAX(turn.updated_at), thread.created_at),
      COALESCE(MAX(activity.last_event_at), thread.created_at)),
    COUNT(turn.id),
    COALESCE(SUM(CASE WHEN activity.turn_id IS NOT NULL
      AND activity.projected_cursor IS turn.last_cursor
      AND (turn.status NOT IN ('completed', 'failed', 'cancelled') OR activity.complete = 1)
      THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(activity.added), 0), COALESCE(SUM(activity.modified), 0), COALESCE(SUM(activity.removed), 0)
  FROM rika_threads AS thread
  LEFT JOIN rika_turns AS turn ON turn.thread_id = thread.id
  LEFT JOIN rika_thread_turn_activity AS activity ON activity.turn_id = turn.id
  GROUP BY thread.id`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_thread_insert
    AFTER INSERT ON rika_threads BEGIN
      INSERT INTO rika_thread_picker_summary (
        thread_id, workspace, title, pinned, archived, status_rank, waiting_count, running_count, queued_count,
        last_activity_at, turn_count, current_activity_count, added, modified, removed
      ) VALUES (NEW.id, NEW.workspace, NEW.title, NEW.pinned, NEW.archived, 0, 0, 0, 0,
        NEW.created_at, 0, 0, 0, 0, 0);
    END`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_thread_update
    AFTER UPDATE OF workspace, title, pinned, archived ON rika_threads BEGIN
      UPDATE rika_thread_picker_summary SET workspace = NEW.workspace, title = NEW.title,
        pinned = NEW.pinned, archived = NEW.archived WHERE thread_id = NEW.id;
    END`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_turn_insert
    AFTER INSERT ON rika_turns BEGIN
      UPDATE rika_thread_picker_summary SET
        waiting_count = waiting_count + (NEW.status = 'waiting'),
        running_count = running_count + (NEW.status IN ('accepted', 'running')),
        queued_count = queued_count + (NEW.status = 'queued'),
        status_rank = MAX(status_rank, CASE WHEN NEW.status = 'waiting' THEN 3
          WHEN NEW.status IN ('accepted', 'running') THEN 2 WHEN NEW.status = 'queued' THEN 1 ELSE 0 END),
        last_status = CASE WHEN last_turn_created_at IS NULL OR (NEW.created_at, NEW.id) >
          (last_turn_created_at, last_turn_id) THEN NEW.status ELSE last_status END,
        last_turn_created_at = CASE WHEN last_turn_created_at IS NULL OR (NEW.created_at, NEW.id) >
          (last_turn_created_at, last_turn_id) THEN NEW.created_at ELSE last_turn_created_at END,
        last_turn_id = CASE WHEN last_turn_created_at IS NULL OR (NEW.created_at, NEW.id) >
          (last_turn_created_at, last_turn_id) THEN NEW.id ELSE last_turn_id END,
        last_activity_at = MAX(last_activity_at, NEW.updated_at),
        turn_count = turn_count + 1
      WHERE thread_id = NEW.thread_id;
    END`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_turn_update
    AFTER UPDATE OF status, last_cursor, updated_at ON rika_turns BEGIN
      UPDATE rika_thread_picker_summary SET
        waiting_count = waiting_count - (OLD.status = 'waiting') + (NEW.status = 'waiting'),
        running_count = running_count - (OLD.status IN ('accepted', 'running')) +
          (NEW.status IN ('accepted', 'running')),
        queued_count = queued_count - (OLD.status = 'queued') + (NEW.status = 'queued'),
        status_rank = CASE
          WHEN waiting_count - (OLD.status = 'waiting') + (NEW.status = 'waiting') > 0 THEN 3
          WHEN running_count - (OLD.status IN ('accepted', 'running')) +
            (NEW.status IN ('accepted', 'running')) > 0 THEN 2
          WHEN queued_count - (OLD.status = 'queued') + (NEW.status = 'queued') > 0 THEN 1 ELSE 0 END,
        last_status = CASE WHEN last_turn_id = NEW.id THEN NEW.status ELSE last_status END,
        last_activity_at = MAX(last_activity_at, NEW.updated_at),
        current_activity_count = current_activity_count + COALESCE((SELECT
          (activity.projected_cursor IS NEW.last_cursor AND
            (NEW.status NOT IN ('completed', 'failed', 'cancelled') OR activity.complete = 1)) -
          (activity.projected_cursor IS OLD.last_cursor AND
            (OLD.status NOT IN ('completed', 'failed', 'cancelled') OR activity.complete = 1))
          FROM rika_thread_turn_activity AS activity WHERE activity.turn_id = NEW.id), 0)
      WHERE thread_id = NEW.thread_id;
    END`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_turn_before_delete
    BEFORE DELETE ON rika_turns BEGIN
      UPDATE rika_thread_picker_summary SET
        current_activity_count = current_activity_count - COALESCE((SELECT
          activity.projected_cursor IS OLD.last_cursor AND
          (OLD.status NOT IN ('completed', 'failed', 'cancelled') OR activity.complete = 1)
          FROM rika_thread_turn_activity AS activity WHERE activity.turn_id = OLD.id), 0),
        added = added - COALESCE((SELECT added FROM rika_thread_turn_activity WHERE turn_id = OLD.id), 0),
        modified = modified - COALESCE((SELECT modified FROM rika_thread_turn_activity WHERE turn_id = OLD.id), 0),
        removed = removed - COALESCE((SELECT removed FROM rika_thread_turn_activity WHERE turn_id = OLD.id), 0)
      WHERE thread_id = OLD.thread_id;
    END`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_turn_delete
    AFTER DELETE ON rika_turns BEGIN
      UPDATE rika_thread_picker_summary SET
        waiting_count = waiting_count - (OLD.status = 'waiting'),
        running_count = running_count - (OLD.status IN ('accepted', 'running')),
        queued_count = queued_count - (OLD.status = 'queued'),
        status_rank = CASE WHEN waiting_count - (OLD.status = 'waiting') > 0 THEN 3
          WHEN running_count - (OLD.status IN ('accepted', 'running')) > 0 THEN 2
          WHEN queued_count - (OLD.status = 'queued') > 0 THEN 1 ELSE 0 END,
        turn_count = turn_count - 1,
        last_status = CASE WHEN last_turn_id = OLD.id THEN
          (SELECT status FROM rika_turns WHERE thread_id = OLD.thread_id
            ORDER BY created_at DESC, id DESC LIMIT 1) ELSE last_status END,
        last_turn_created_at = CASE WHEN last_turn_id = OLD.id THEN
          (SELECT created_at FROM rika_turns WHERE thread_id = OLD.thread_id
            ORDER BY created_at DESC, id DESC LIMIT 1) ELSE last_turn_created_at END,
        last_turn_id = CASE WHEN last_turn_id = OLD.id THEN
          (SELECT id FROM rika_turns WHERE thread_id = OLD.thread_id
            ORDER BY created_at DESC, id DESC LIMIT 1) ELSE last_turn_id END,
        last_activity_at = MAX(
          (SELECT created_at FROM rika_threads WHERE id = OLD.thread_id),
          COALESCE((SELECT MAX(updated_at) FROM rika_turns WHERE thread_id = OLD.thread_id), 0),
          COALESCE((SELECT MAX(last_event_at) FROM rika_thread_turn_activity WHERE thread_id = OLD.thread_id), 0)
        )
      WHERE thread_id = OLD.thread_id;
    END`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_activity_insert
    AFTER INSERT ON rika_thread_turn_activity BEGIN
      UPDATE rika_thread_picker_summary SET
        current_activity_count = current_activity_count + COALESCE((SELECT
          NEW.projected_cursor IS turn.last_cursor AND
          (turn.status NOT IN ('completed', 'failed', 'cancelled') OR NEW.complete = 1)
          FROM rika_turns AS turn WHERE turn.id = NEW.turn_id), 0),
        added = added + NEW.added, modified = modified + NEW.modified, removed = removed + NEW.removed,
        last_activity_at = MAX(last_activity_at, COALESCE(NEW.last_event_at, last_activity_at))
      WHERE thread_id = NEW.thread_id;
    END`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_activity_update
    AFTER UPDATE OF projected_cursor, complete, added, modified, removed, last_event_at ON rika_thread_turn_activity BEGIN
      UPDATE rika_thread_picker_summary SET
        current_activity_count = current_activity_count + COALESCE((SELECT
          (NEW.projected_cursor IS turn.last_cursor AND
            (turn.status NOT IN ('completed', 'failed', 'cancelled') OR NEW.complete = 1)) -
          (OLD.projected_cursor IS turn.last_cursor AND
            (turn.status NOT IN ('completed', 'failed', 'cancelled') OR OLD.complete = 1))
          FROM rika_turns AS turn WHERE turn.id = NEW.turn_id), 0),
        added = added - OLD.added + NEW.added,
        modified = modified - OLD.modified + NEW.modified,
        removed = removed - OLD.removed + NEW.removed,
        last_activity_at = CASE WHEN OLD.last_event_at = last_activity_at AND
          COALESCE(NEW.last_event_at, 0) < OLD.last_event_at THEN MAX(
            (SELECT created_at FROM rika_threads WHERE id = NEW.thread_id),
            COALESCE((SELECT MAX(updated_at) FROM rika_turns WHERE thread_id = NEW.thread_id), 0),
            COALESCE((SELECT MAX(last_event_at) FROM rika_thread_turn_activity WHERE thread_id = NEW.thread_id), 0)
          ) ELSE MAX(last_activity_at, COALESCE(NEW.last_event_at, last_activity_at)) END
      WHERE thread_id = NEW.thread_id;
    END`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_activity_delete
    AFTER DELETE ON rika_thread_turn_activity
    WHEN EXISTS (SELECT 1 FROM rika_turns WHERE id = OLD.turn_id) BEGIN
      UPDATE rika_thread_picker_summary SET
        current_activity_count = current_activity_count - COALESCE((SELECT
          OLD.projected_cursor IS turn.last_cursor AND
          (turn.status NOT IN ('completed', 'failed', 'cancelled') OR OLD.complete = 1)
          FROM rika_turns AS turn WHERE turn.id = OLD.turn_id), 0),
        added = added - OLD.added, modified = modified - OLD.modified, removed = removed - OLD.removed,
        last_activity_at = CASE WHEN OLD.last_event_at = last_activity_at THEN MAX(
          (SELECT created_at FROM rika_threads WHERE id = OLD.thread_id),
          COALESCE((SELECT MAX(updated_at) FROM rika_turns WHERE thread_id = OLD.thread_id), 0),
          COALESCE((SELECT MAX(last_event_at) FROM rika_thread_turn_activity WHERE thread_id = OLD.thread_id), 0)
        ) ELSE last_activity_at END
      WHERE thread_id = OLD.thread_id;
    END`
})

