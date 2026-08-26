UPDATE rika_turns AS turn_record
SET status = 'failed',
    updated_at = floor(extract(epoch from clock_timestamp()) * 1000),
    queue_claim_token = NULL
WHERE turn_record.turn_kind = 'AgentExecution'
  AND turn_record.status IN ('accepted', 'running', 'waiting', 'cancelling')
  AND turn_record.execution_link_json IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM rika_turn_admission_outbox AS admission
    WHERE admission.turn_id = turn_record.id
      AND admission.prepared_turn_json IS NOT NULL
  );
