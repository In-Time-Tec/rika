CREATE INDEX rika_hosted_executor_assignments_runner_poll
  ON rika_hosted_executor_assignments (
    (placement ->> 'deviceId'),
    (placement ->> 'checkoutFingerprint'),
    lifecycle
  )
  WHERE executor_kind = 'runner';
