# Observability (Telemetry + Logging)

Rika writes structured telemetry through OpenTelemetry traces and logs over local OTLP/HTTP. The bundled debug surface is [motel](https://github.com/kitlangton/motel), a local ingest daemon, SQLite store, and TUI viewer.

## Debugging with bundled motel

Use the debug command to open motel without installing anything else:

```
rika debug --all                 # all Rika traces and logs
rika debug --thread <thread-id>  # only one thread
```

The TUI command palette exposes the same viewer. `/debug` is contextual: on an empty landing screen it opens all Rika telemetry, and inside an active thread it opens motel with `rika.thread_id=<thread-id>` applied. `/debug all` and `/debug thread` are explicit forms.

Motel listens on `http://127.0.0.1:27686` (`/v1/traces`, `/v1/logs`) and exposes a read API (`/api/services`, `/api/traces?service=rika`, `/api/logs?service=rika`, `/api/ai/calls`). Agents working in this repo can use the `motel-debug` skill under `.agents/skills/motel-debug/`.

## How export is wired

- `packages/core/src/telemetry.ts` builds the Effect layer. `Telemetry.layer(options)` installs the `@effect/opentelemetry` `NodeSdk` tracer (so every `Effect.fn("Name")` span is recorded and exported) and registers a global OTLP `LoggerProvider`. `Telemetry.diagnosticsLayer(options)` is a `Diagnostics.Service` variant that writes the local NDJSON file AND emits each entry as an OTLP log record, correlated to the enclosing span's `trace_id`/`span_id`.
- Both are merged into the three command layers in `packages/cli/src/runtime.ts` (`liveLayer`, `interactiveLiveLayer`, `serverLiveLayer`) via the `telemetryLayers` helper.
- Service resource: `service.name=rika`, `service.version`, `deployment.environment.name` (development when run from source, production from the compiled binary), `process.runtime.name=bun`.

## Configuration

| Env var                   | Default                  | Meaning                                                                            |
| ------------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `RIKA_TELEMETRY`          | on                       | `off`/`0`/`false`/`disabled` disables export; `on`/`1`/`true`/`enabled` forces it. |
| `RIKA_TELEMETRY_ENDPOINT` | `http://127.0.0.1:27686` | OTLP base URL; `/v1/traces` and `/v1/logs` are appended.                           |

Telemetry is **on by default in every mode, including the compiled binary**. The default endpoint is local (`127.0.0.1`), so data stays on the user's machine. `rika doctor` reports the effective state under `config.telemetry` / `config.telemetry_endpoint`.

## Hard constraints

- **Never write telemetry output to stdout/stderr.** Rika is a TUI; console output corrupts it. `Telemetry.suppressDiagnostics()` disables OpenTelemetry's internal `diag` logger, only OTLP/HTTP exporters + `Batch*Processor` are used, and the `Diagnostics` OTLP emit is wrapped in a swallowing `try/catch`.
- **Never crash when motel is unreachable.** Batch processors drop failed exports silently; `ECONNREFUSED` (no motel running — the common end-user case) is a no-op. The local NDJSON file sink always still works.
- **Redact secrets.** Correlated logs and AI-call spans can contain sensitive data. Do not log API keys/tokens or full prompt/response text by default; log counts, sizes, ids. Treat the motel store as sensitive dev data.

## Logging convention: wide events

Use the Effect-native wide-events pattern — one context-rich event per operation, emitted in a finally, through the single `Diagnostics` sink. Full guidance and the completion checklist live in `.agents/skills/effect-logging/SKILL.md`. Prefer the `Diagnostics.event(op, run, seed)` helper, which stamps `op`, `outcome`, `duration_ms`, and `error` and emits once via `onExit`. Never use `console.*` or `Effect.log*`; always go through `Diagnostics`.
