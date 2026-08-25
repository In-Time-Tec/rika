CREATE UNIQUE INDEX rika_hosted_tool_audit_decision_identity
  ON rika_hosted_tool_audit_records(audit_group_id)
  WHERE phase = 'decision';
