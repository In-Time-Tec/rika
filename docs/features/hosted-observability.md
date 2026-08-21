# Hosted observability

Hosted execution emits Effect spans, metrics, and structured logs at the durable authority boundaries for command and Turn admission, queue claims, model attempts, executor and workspace preparation, cells, leases, checkpoints, sandbox lifecycle, and client replay.

Owner, Thread, Turn, Run, operation, assignment, sandbox, build, command, and checkpoint identifiers correlate logs and spans. Identifiers never label metrics. Metric labels are closed stage, outcome, token-kind, and health-signal sets; duration and lag summaries retain at most 1,024 samples per series for 15 minutes. Exporters own longer-term retention.

Normal telemetry accepts correlation identifiers and numeric measurements only. Prompts, prompt parts, cell source, streamed output, secret values, provider credentials, and failure messages are excluded. Failed Effects are converted to an `Exit` inside the span so tracing records the bounded outcome instead of serializing the failure payload.

The bounded health signals are `stuck_queue_claim`, `stale_lease`, `setup_failure`, `unknown_outcome`, `replay_lag`, `orphan_sandbox`, and `restore_failure`. Each signal includes the available safe correlation identifiers plus a numeric value and threshold when one exists. A stuck Turn claim also makes the hosted Turn worker unready until the claim settles.
