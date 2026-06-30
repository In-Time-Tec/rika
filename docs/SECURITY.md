# Security Reference

Rika is a local-first coding agent that can inspect files, run commands, edit code, load plugins, call MCP servers, and serve a remote-control API. Treat it like a developer shell with model-driven automation.

## Trust model

| Surface             | Default trust posture                                               |
| ------------------- | ------------------------------------------------------------------- |
| Workspace files     | Untrusted input to the model unless explicitly trusted by the user. |
| Shell/tool calls    | Powerful local actions routed through `ToolExecutor` and policy.    |
| Plugins             | Trusted local TypeScript. MVP plugins are **not sandboxed**.        |
| MCP command servers | Untrusted executable code until approved by fingerprint.            |
| Remote MCP servers  | External services; credentials stay in config.                      |
| Remote-control API  | Localhost-first; bearer token required when configured.             |
| Rivet actors        | Runtime ownership boundary; durable truth remains the event log.    |

## Tools and permissions

Tool calls run through `ToolExecutor.Service`; plugins and MCP tools do not bypass the normal policy path. Rika's default policy is `allow-all`, matching Amp's no-approval local workflow: read, write, shell, MCP, specialty, and plugin tools run without prompting unless configuration or trusted plugins override the decision.

The centralized `PermissionPolicy.Service` supports four decisions for every tool call:

- `allow` — execute the original call.
- `reject-and-continue` — return a normal `kind: "permission"` tool result and let the agent continue.
- `modify` — execute the call with replacement input.
- `synthesize` — return a tool result without executing the registry handler.

Set `RIKA_GUARDED_TOOLS` and/or `RIKA_GUARDED_FILES` to opt into a configured guarded mode. Guard patterns support exact values and `*` wildcards. Permission diagnostics record only mode/action and the matched tool/path pattern; they must not persist full tool inputs or secret values. The MVP does not claim complete sandboxing.

When working in untrusted repositories:

- prefer ephemeral mode for experiments: `--ephemeral`
- inspect commands before asking Rika to run broad fixes
- avoid approving workspace MCP command servers until you reviewed their command/args/env
- do not enable generated plugins without a real verification command

## Secret handling

Secrets should enter through environment/config boundaries:

- `RIKA_API_KEY`
- `RIKA_RIVET_TOKEN` / `RIVET_TOKEN`
- remote MCP headers/tokens when configured
- remote-control bearer token

Rika should not persist raw secret values into thread events, artifacts, plugin trust records, or doctor output. `rika doctor` reports only whether secrets are configured.

## Shared local backend

Interactive TUI windows share one local backend per workspace/data directory by default. The backend connection record lives under `RIKA_DATA_DIR` and includes a bearer token used by local SDK clients. Rika writes that record as a private file, `rika doctor` redacts the token, and normal UI output never prints it.

- Treat the shared backend token like a local session secret.
- Delete a stale backend record or run `rika doctor` if a workspace appears disconnected after a crash.
- Set `RIKA_BACKEND_URL` / `RIKA_BACKEND_TOKEN` only for backends you trust.
- Use `--ephemeral` for isolated in-process tests when sharing would hide a bug.

## Plugins

Plugins are executable TypeScript modules loaded from trusted local plugin locations. They can register commands, tools, modes, subagents, lifecycle hooks, UI calls, and permission hooks.

Rules:

- Generated plugins are written disabled first.
- Enabling a generated plugin requires an explicit verification command.
- Rollback disables plugin execution without deleting source.
- The MVP plugin loader is not a sandbox and must not be treated as isolation.

## MCP

Workspace command MCP servers require explicit approval before spawn. Approval is scoped by workspace root, server name, and config fingerprint. Remote MCP tools should be filtered before entering model context to reduce prompt bloat and accidental capability exposure.

## Remote control and hosted workspaces

The HTTP server can require `Authorization: Bearer <token>`. Hosted user requests pass `user_id` through schema payloads and are checked by `WorkspaceAccess.Service` against durable workspace memberships.

- Requests without `user_id` keep local-first behavior.
- Requests with `user_id` require workspace membership for thread/artifact reads and writes.
- The first identified user to create an empty hosted workspace becomes owner.
- Outsiders receive access-denied errors rather than filtered data.

Remote control grants thread steering, not unrestricted filesystem access. Keep local filesystem mutation behind normal tools/policy.

## Persistence and recovery

The append-only event log is canonical. Projections and actor hot state are rebuildable. Workspace membership data is security-sensitive and should be backed up before hosted deployments.

Operational minimum:

```bash
bun run db:migrate
bun run docs:check
bun run package:smoke
```

## Security test coverage

Coverage currently includes:

- MCP approval scoping and fingerprint tests.
- Workspace membership/access-control tests.
- Plugin trust, verification, and rollback tests.
- Doctor output secret-redaction tests.
- Remote-control token and user-scope tests.

## Reporting issues

Use GitHub issues for security reports during the private launch. Do not paste provider tokens, API keys, database files, or private thread exports into public issues.
