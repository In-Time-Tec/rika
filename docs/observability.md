# Observability (Telemetry + Logging)

Rika writes structured telemetry (wide events + logs) to a local NDJSON file and, when telemetry is enabled, also exports OpenTelemetry traces and logs over OTLP/HTTP.

## Viewing logs: `rika logs` (built in, zero dependencies)

The fastest way to see what Rika did is the bundled `rika logs` command. It reads the local NDJSON log this workspace already writes (`{data_dir}/logs/session.ndjson`) — no motel, no external process, nothing beyond the `rika` binary itself.

```
rika logs                       # recent entries, formatted
rika logs -f                    # follow (stream new entries live)
rika logs --op agent.turn       # only a specific wide-event op
rika logs --level error         # only error entries
rika logs --thread <thread-id>  # only one thread
rika logs --since 15m           # entries newer than a duration (30s/15m/2h/1d)
rika logs --limit 50            # cap output (default 200)
rika logs --json                # raw NDJSON for piping to jq
```

The log path resolves the same way the writer does: `RIKA_LOG_FILE`, then `AMP_LOG_FILE`, then `{data_dir}/logs/session.ndjson` (`--workspace` overrides the root used to compute `data_dir`).

## Motel (optional, richer trace waterfalls)

[motel](https://github.com/kitlangton/motel) is a local OTLP ingest server and viewer backed by SQLite. It adds trace-waterfall and AI-call views on top of what `rika logs` shows, for humans (TUI/web) and agents (HTTP API). It is optional — `rika logs` needs nothing external.

## Running motel

```
bunx @kitlangton/motel        # server + TUI
bunx @kitlangton/motel daemon # background ingest server only
```

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
