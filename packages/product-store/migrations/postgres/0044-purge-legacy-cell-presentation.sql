-- Replacing kernel cells with native workspace tools removed the `Cell` presentation block and the
-- `GoalChanged` interactive event from the persisted contracts without migrating stored rows. Every
-- Thread whose protocol snapshot or event still carries one of those tags failed to decode, which wedged
-- replay and every later append for that Thread. These rows are derived from Generalist's durable Run log
-- and the product repositories: the next attach materializes a fresh snapshot from them, so the affected
-- Threads lose only their cached protocol history and cell transcript units, not any authority.

CREATE TEMP TABLE legacy_protocol_threads ON COMMIT DROP AS
SELECT DISTINCT owner_id, thread_id
FROM rika_hosted_thread_protocol_snapshots
WHERE snapshot @? '$.** ? (@._tag == "Cell" || @._tag == "GoalChanged")'
UNION
SELECT DISTINCT owner_id, thread_id
FROM rika_hosted_thread_protocol_events
WHERE event @? '$.** ? (@._tag == "Cell" || @._tag == "GoalChanged")';

DELETE FROM rika_hosted_thread_protocol_events events
USING legacy_protocol_threads legacy
WHERE events.owner_id = legacy.owner_id AND events.thread_id = legacy.thread_id;

DELETE FROM rika_hosted_thread_protocol_snapshots snapshots
USING legacy_protocol_threads legacy
WHERE snapshots.owner_id = legacy.owner_id AND snapshots.thread_id = legacy.thread_id;

DELETE FROM rika_transcript_units
WHERE unit_json::jsonb @? '$.** ? (@._tag == "Cell")';
