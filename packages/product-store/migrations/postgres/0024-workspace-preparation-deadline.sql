ALTER TABLE rika_hosted_workspace_preparations
  ADD COLUMN deadline_at TIMESTAMPTZ;

UPDATE rika_hosted_workspace_preparations
SET deadline_at = CASE
  WHEN state = 'preparing' THEN updated_at + interval '30 minutes'
  ELSE updated_at
END;

ALTER TABLE rika_hosted_workspace_preparations
  ALTER COLUMN deadline_at SET NOT NULL;

CREATE INDEX rika_hosted_workspace_preparations_overdue
  ON rika_hosted_workspace_preparations (deadline_at)
  WHERE state = 'preparing';
