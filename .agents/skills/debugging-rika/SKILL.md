---
name: debugging-rika
description: >
  Use this skill when the user wants to diagnose Rika behavior or find the cause of a Rika failure. Also use when Rika crashes, hangs, fails to start, loses its resident connection, or produces an unexpected result. Do not use when the cause and fix are already known and only implementation remains.
---

# Debugging Rika

Use Rika's supported diagnostics commands to explain what happened before reading databases or internal implementation files.

## Workflow

1. Run `rika diagnostics status` and record the reported directory and file count.
2. Run `rika diagnostics path` when another tool needs the raw location.
3. Sort `client-*.jsonl` and `resident-*.jsonl` by modification time. Start with the newest file for each role.
4. Parse each line as JSON. Find the relevant `process`, `resident.connection`, `resident.operation`, `turn`, `execution`, `tool`, or `tui` events around the unexpected behavior. Treat an incomplete `.open.jsonl` file as evidence that the process may not have shut down cleanly.
5. Correlate entries by `rika.process.instance`, then by `rika.resident.request.id`, `rika.thread.id`, `rika.turn.id`, `rika.execution.id`, or `rika.tool.call.id`.
6. Check the resident log before blaming the client when connection or execution behavior is involved. Use `rika.duration.ms`, `rika.execution.status`, `rika.event.type`, and `rika.failure.kind` to identify the last successful, stalled, or failed boundary.
7. Export a reviewable copy with `rika diagnostics export <new-directory>`.
8. Reproduce once with the same command when safe, then compare the correlated boundaries in both runs.

## Safety

- Treat the diagnostics directory and every export as sensitive local data.
- Do not paste full logs into an issue or prompt without reviewing them.
- Do not infer that a missing `process.stopped` record proves one cause; SIGKILL, power loss, and runtime failure can prevent the final buffered write.
- Do not edit logs in place. Export them first when annotations or ordering need analysis.
- Do not delete the resident token, SQLite files, or logs during diagnosis.

## Evidence to report

Report the command, observed behavior, process role, log filename, timestamps, stable event names, safe IDs, and the smallest relevant JSON records. State whether the behavior was reproduced and whether the resident remained alive.
