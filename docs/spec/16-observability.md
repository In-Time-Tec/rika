# Observability and Diagnostics

## Diagnostics

Every resident-backed Rika client and Resident Rika Service process writes Effect JSON logs beneath `<data-root>/diagnostics`. Client and resident files are separate and include process role, version, process instance, and safe operation identifiers as Effect log annotations. Rika retains normally closed log files for fourteen days. It preserves `.open.jsonl` files left by abrupt termination as crash evidence.

Resident logs record connection attempts and outcomes, accepted operations, interactive action methods and event counts, queue overflow boundaries, thread-host recovery generations, Turn state changes, Relay execution submission and following, selected model identifiers, important durable execution event types, local tool outcomes, durations, and typed failure kinds. Thread, Turn, execution, request, connection, action, event, and tool-call identifiers correlate records without copying payloads. Delta content is not logged.

`rika diagnostics path` and `rika diagnostics status` inspect this location without connecting to the resident or creating another log. `rika diagnostics export <new-directory>` copies only log files into a private directory for local analysis.

Effect scopes flush pending records during normal completion, typed failure, interruption, SIGINT, and SIGTERM. Logging is best effort for abrupt runtime termination, SIGKILL, power loss, disk write failure, and failure before the Effect runtime starts. Process lifecycle and failure records are always retained; `logging.level` filters operation records.

## Security

Secrets, prompts, model bodies, tool arguments and results, shell commands and output, headers, arbitrary error messages, and credentials are not fields in Rika-owned log records. Those records use named events and an allowlist of safe identifiers. Local logs and exports are treated as sensitive data and use private filesystem permissions.

## User Surface

The CLI provides doctor, local log path/status/export, log-level configuration, effective configuration, dependency versions, database migration state, MCP status, and execution replay diagnostics.
