CREATE FUNCTION rika_hosted_notify_thread_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  changed_thread_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed_thread_id := OLD.thread_id;
  ELSE
    changed_thread_id := NEW.thread_id;
  END IF;
  PERFORM pg_notify('rika_thread_protocol', changed_thread_id);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION rika_hosted_notify_preparation_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  changed_assignment_id TEXT;
  changed_thread_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed_assignment_id := OLD.assignment_id;
  ELSE
    changed_assignment_id := NEW.assignment_id;
  END IF;
  SELECT thread_id INTO changed_thread_id
  FROM rika_hosted_executor_assignments
  WHERE id = changed_assignment_id;
  IF changed_thread_id IS NOT NULL THEN
    PERFORM pg_notify('rika_thread_protocol', changed_thread_id);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rika_hosted_protocol_event_notification
AFTER INSERT ON rika_hosted_thread_protocol_events
FOR EACH ROW EXECUTE FUNCTION rika_hosted_notify_thread_change();

CREATE TRIGGER rika_hosted_protocol_snapshot_notification
AFTER INSERT OR UPDATE ON rika_hosted_thread_protocol_snapshots
FOR EACH ROW EXECUTE FUNCTION rika_hosted_notify_thread_change();

CREATE TRIGGER rika_hosted_turn_status_notification
AFTER UPDATE OF status, execution_link_json ON rika_turns
FOR EACH ROW WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  OR OLD.execution_link_json IS DISTINCT FROM NEW.execution_link_json
)
EXECUTE FUNCTION rika_hosted_notify_thread_change();

CREATE TRIGGER rika_hosted_assignment_notification
AFTER INSERT OR UPDATE OF lifecycle, generation, bootstrap_expires_at, capability_generation, capability_snapshot
ON rika_hosted_executor_assignments
FOR EACH ROW EXECUTE FUNCTION rika_hosted_notify_thread_change();

CREATE TRIGGER rika_hosted_assignment_reconnection_notification
AFTER UPDATE OF lease_expires_at ON rika_hosted_executor_assignments
FOR EACH ROW WHEN (OLD.lease_expires_at <= CURRENT_TIMESTAMP AND NEW.lease_expires_at > CURRENT_TIMESTAMP)
EXECUTE FUNCTION rika_hosted_notify_thread_change();

CREATE TRIGGER rika_hosted_preparation_notification
AFTER INSERT OR UPDATE OR DELETE ON rika_hosted_workspace_preparations
FOR EACH ROW EXECUTE FUNCTION rika_hosted_notify_preparation_change();
