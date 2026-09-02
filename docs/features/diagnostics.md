# Diagnostics

The Runner stream covers transport lifecycle and reconnects, durable native tool admission and settlement, machine dispatch and cancellation, and Executor fencing. Diagnostics identify Accepted, Started, Output, Terminal, `MachineExecute`, `MachineCancel`, and `MachineResult` transitions with opaque operation, tool-call, assignment, and machine identifiers.

Diagnostics never contain prompts, commands, file content, tool output, provider payloads, or credentials. A stalled operation therefore leaves only safe lifecycle evidence: last durable frame, reconnect or replay decision, cancellation state, deadline, and terminal outcome. Ambiguous unsafe execution is recorded as unknown rather than rewritten as success or replayed blindly.

## Client log files

Every Rika process writes one JSON Lines file under `~/.config/rika/diagnostics/client-<timestamp>-<pid>.jsonl`. INFO and DEBUG records carry only a structured operation name (`hosted.first_draw.success`, `tui.renderer.started`, `runner.status.ready`, ...) and whitelisted annotations; free text is dropped. WARN, ERROR, and FATAL records also keep a `detail` field with the message text and the pretty-printed cause, passed through a redactor that removes JWTs, Authorization and DPoP headers, `*token`, `*secret`, `*password`, `*api_key`, and `*private*` assignments, and common key prefixes before the record reaches disk.

Every process exit path is recorded. A command that fails with a user-facing error writes `cli.exit.failure`; an unexpected defect writes `cli.exit.defect` and also prints the redacted cause to stderr with the instruction to run `rika debug`. Closing the TUI does not close the log file; the file settles when the process exits, so a failure after teardown still reaches disk.

## `rika debug`

`rika debug [--runs N]` prints one pasteable report for support: the installed version and executable, runtime, platform, `TERM`, `TERM_PROGRAM`, `COLORTERM`, terminal size, shell, the login origin and owner from `hosted.json`, the diagnostics directory size, and for each of the N most recent runs (default 3) the version, start and last record time, record count, lifecycle stage chain, and every WARN or ERROR record with its detail. The command reads only already-redacted records and never prints credentials. `rika diagnostics export` still copies the raw files when the full history is needed.

## Server refusals

A non-2xx server response surfaces as `<action> failed (HTTP <status>): <one-line excerpt of the body>`. The API replaces the framework's empty 400 for request decoding failures with a message naming the endpoint and the mismatched part and telling a Rika CLI to run `rika update`. Any change to the Runner registration wire shape must bump `runnerProtocolVersion` in `packages/product/src/hosted/executor/runner-registration.ts`, and the API must not be deployed with such a change before the matching client release is published.
