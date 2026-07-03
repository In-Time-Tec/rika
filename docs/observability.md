# Observability (Telemetry + Logging)

Rika writes structured telemetry through OpenTelemetry traces and logs over local OTLP/HTTP. Rika Inspect ships with the CLI and provides a local ingest daemon, SQLite store, and terminal telemetry viewer without requiring a separate install.

## Inspecting telemetry

Use the inspect command to open telemetry without installing anything else:

```
rika inspect --all                 # all Rika traces and logs
rika inspect --thread <thread-id>  # only one thread
```

The TUI command palette exposes the same telemetry surface in-process. On an empty landing screen it offers `/inspect all`; once a thread has activity it offers `/inspect thread` plus `/inspect all`. Thread inspect opens a full-screen Rika pane with `service.name=rika` and the `rika.thread_id=<thread-id>` filter applied.

The local telemetry daemon listens on `http://127.0.0.1:27686` (`/v1/traces`, `/v1/logs`) and exposes a read API (`/api/services`, `/api/traces?service=rika`, `/api/logs?service=rika`, `/api/ai/calls`).

## How export is wired

- `packages/core/src/telemetry.ts` builds the Effect layer. `Telemetry.layer(options)` installs the `@effect/opentelemetry` `NodeSdk` tracer (so every `Effect.fn("Name")` span is recorded and exported) and registers a global OTLP `LoggerProvider`. `Telemetry.diagnosticsLayer(options)` is a `Diagnostics.Service` variant that writes the local NDJSON file AND emits each entry as an OTLP log record, correlated to the enclosing span's `trace_id`/`span_id`.
- Runtime command layers in `packages/cli/src/runtime.ts` merge telemetry through the `telemetryLayers` helper and share the same `SecretRedactor` instance as local event-log and orb-management services.
- Service resource: `service.name=rika`, `service.version`, `deployment.environment.name` (development when run from source, production from the compiled binary), `process.runtime.name=bun`.

## Configuration

| Env var                   | Default                  | Meaning                                                                            |
| ------------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `RIKA_TELEMETRY`          | on                       | `off`/`0`/`false`/`disabled` disables export; `on`/`1`/`true`/`enabled` forces it. |
| `RIKA_TELEMETRY_ENDPOINT` | `http://127.0.0.1:27686` | OTLP base URL; `/v1/traces` and `/v1/logs` are appended.                           |

The same values can be set in `~/.config/rika/settings.json` or `<workspace>/.rika/settings.json` as `telemetry.enabled` and `telemetry.endpoint`. Environment variables override workspace settings, which override user settings.

Telemetry is **on by default in every mode, including the compiled binary**. The default endpoint is local (`127.0.0.1`), so data stays on the user's machine. `rika doctor` reports the effective state under `config.telemetry` / `config.telemetry_endpoint`.

## Hard constraints

- **Never write telemetry output to stdout/stderr.** Rika is a TUI; console output corrupts it. `Telemetry.suppressDiagnostics()` disables OpenTelemetry's internal `diag` logger, only OTLP/HTTP exporters + `Batch*Processor` are used, and the `Diagnostics` OTLP emit is wrapped in a swallowing `try/catch`.
- **Never crash when the local telemetry daemon is unreachable.** Batch processors drop failed exports silently; `ECONNREFUSED` (no daemon running — the common end-user case) is a no-op. The local NDJSON file sink always still works.
- **Redact secrets.** `SecretRedactor` registers exact secret values from environment variables ending in `_API_KEY`, `_TOKEN`, `_SECRET`, or `_PASSWORD`, plus local backend/orb bearer tokens and project secrets. Thread event payloads are redacted before append/idempotency checks. Diagnostics entries, OTLP log data, failure text, and span annotations are redacted before export. Do not log API keys/tokens or full prompt/response text by default; log counts, sizes, ids. Treat the local telemetry store as sensitive dev data.
- **Do not rely on redaction across split streams.** Redaction is exact-value matching inside one string field or JSON value. It does not reconstruct a secret split across multiple model/tool stream chunks, diagnostic entries, or span annotations. Avoid emitting secret fragments and treat the redactor as a last-resort choke point, not a data-loss-prevention system.

## Logging convention: wide events

Use the Effect-native wide-events pattern — one context-rich event per operation, emitted in a finally, through the single `Diagnostics` sink. Full guidance and the completion checklist live in `.agents/skills/effect-logging/SKILL.md`. Prefer the `Diagnostics.event(op, run, seed)` helper, which stamps `op`, `outcome`, `duration_ms`, and `error` and emits once via `onExit`. Never use `console.*` or `Effect.log*`; always go through `Diagnostics`.
