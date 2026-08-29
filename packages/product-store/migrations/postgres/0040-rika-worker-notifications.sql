CREATE FUNCTION rika_hosted_notify_worker()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  worker_domain TEXT;
BEGIN
  FOREACH worker_domain IN ARRAY TG_ARGV LOOP
    PERFORM pg_notify('rika_worker', worker_domain);
  END LOOP;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rika_hosted_command_worker_notification
AFTER INSERT OR UPDATE ON rika_hosted_thread_protocol_commands
FOR EACH ROW EXECUTE FUNCTION rika_hosted_notify_worker('command', 'turn');

CREATE TRIGGER rika_hosted_turn_worker_notification
AFTER INSERT OR UPDATE OF status, execution_link_json ON rika_turns
FOR EACH ROW EXECUTE FUNCTION rika_hosted_notify_worker('turn', 'projection', 'reconciliation');

CREATE TRIGGER rika_hosted_assignment_worker_notification
AFTER INSERT OR UPDATE OF lifecycle, generation, lease_expires_at, bootstrap_expires_at
ON rika_hosted_executor_assignments
FOR EACH ROW EXECUTE FUNCTION rika_hosted_notify_worker('turn');

CREATE TRIGGER rika_hosted_preparation_worker_notification
AFTER INSERT OR UPDATE OR DELETE ON rika_hosted_workspace_preparations
FOR EACH ROW EXECUTE FUNCTION rika_hosted_notify_worker('turn');

CREATE TRIGGER rika_hosted_projection_worker_notification
AFTER INSERT OR UPDATE ON rika_transcript_checkpoints
FOR EACH ROW EXECUTE FUNCTION rika_hosted_notify_worker('reconciliation');

CREATE TRIGGER rika_hosted_steering_worker_notification
AFTER INSERT OR UPDATE OR DELETE ON rika_turn_steering_outbox
FOR EACH ROW EXECUTE FUNCTION rika_hosted_notify_worker('reconciliation');
