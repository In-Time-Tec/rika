# Security Reference

Rika is a local-first coding agent that can inspect files, run commands, edit code, load plugins, call MCP servers, and serve a remote-control API. Treat it like a developer shell with model-driven automation.

## Trust model

| Surface             | Default trust posture                                               |
| ------------------- | ------------------------------------------------------------------- |
| Workspace files     | Untrusted input to the model unless explicitly trusted by the user. |
| Shell/tool calls    | Powerful local actions routed through `ToolExecutor` and policy.    |
| Plugins             | Trusted local TypeScript. MVP plugins are **not sandboxed**.        |
| MCP command servers | Untrusted executable code until approved by fingerprint and cwd.    |
| Remote MCP servers  | External services; credentials stay in config.                      |
| Remote-control API  | Localhost-first; bearer token required when configured.             |
| Rivet actors        | Runtime ownership boundary; durable truth remains the event log.    |

## Tools and permissions

Tool calls run through `ToolExecutor.Service`; plugins and MCP tools do not bypass the normal policy path. Rika's default policy is `allow-all` for unguarded paths, matching Amp's no-approval local workflow. Writes targeting `.rika/plugins/**` are guarded by default, including absolute paths matching `*/.rika/plugins/**`, so executable plugin source changes require policy review even when ambient mode is `allow-all`.

`guarded_files` is a best-effort argument-path guard. It resolves path-like tool input strings against the workspace root before matching configured patterns, including symlinked directories, but it does not parse arbitrary shell command text. The plugin loader's workspace-scoped trust record and source hash verification are the security boundary for plugin execution.

Subagents default to `RIKA_SUBAGENT_TOOLS=readonly` in local processes. `RIKA_SUBAGENT_TOOLS=full` gives subagents the standard tool surface except the recursive `task` tool; every subagent tool call still goes through `ToolExecutor.Service` and `PermissionPolicy.Service`. Orb servers are launched with full subagent tools because the workspace is already inside the sandbox boundary.

The centralized `PermissionPolicy.Service` supports four decisions for every tool call:

- `allow` — execute the original call.
- `reject-and-continue` — return a normal `kind: "permission"` tool result and let the agent continue.
- `modify` — execute the call with replacement input.
- `synthesize` — return a tool result without executing the registry handler.

Set `RIKA_GUARDED_TOOLS` and/or `RIKA_GUARDED_FILES` to add configured guards. Guard patterns support exact values and `*` wildcards. Permission diagnostics record only mode/action and the matched tool/path pattern; they must not persist full tool inputs or secret values. The MVP does not claim complete sandboxing.

When working in untrusted repositories:

- prefer ephemeral mode for experiments: `--ephemeral`
- inspect commands before asking Rika to run broad fixes
- avoid approving workspace MCP command servers until you reviewed their command/args/env
- do not enable generated plugins without a real verification command

## Secret handling

Secrets should enter through environment/config boundaries:

- `RIKA_API_KEY`
- `RIKA_EMBEDDINGS_API_KEY`
- `RIKA_RIVET_TOKEN` / `RIVET_TOKEN`
- remote MCP headers/tokens when configured
- remote-control bearer token

Rika should not persist raw secret values into thread events, artifacts, plugin trust records, or doctor output. `rika doctor` reports only whether secrets are configured.

Thread memory sends completed-turn digest text to the configured embedding provider and persists the digest text plus embedding bytes in the local SQLite database.

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
- SelfExtension records the workspace id and enabled plugin source hash in its artifact trust decision.
- PluginHost imports an active `.rika/plugins/*.ts` file only when the latest SelfExtension trust artifact for the loading workspace and plugin is enabled, verification passed, and the current file hash matches the recorded hash.
- Missing trust records, stale hashes, disabled or rolled-back trust states, and same-timestamp trust ambiguity are rejected before plugin source is imported.
- Rollback disables plugin execution without deleting source.
- The MVP plugin loader is not a sandbox and must not be treated as isolation.

## MCP

Workspace command MCP servers require explicit approval before spawn. Approval is scoped by workspace root, server name, config fingerprint, and effective launch directory. Skill-bundled `mcp.json` command servers use the same approval store and are registered only when the skill is explicitly loaded. Remote MCP tools should be filtered before entering model context to reduce prompt bloat and accidental capability exposure.

## Skills

`rika skills add` clones Git sources and copies validated skill directories into project or user skill roots. Installed skills are prompt instructions and optional resources, not executable code by themselves. Treat their contents as untrusted workspace context until explicitly loaded; any bundled `mcp.json` still follows MCP approval before command-server execution. Provenance is recorded in `skills-lock.json` with source, commit, install time, scope, and directory.

## Remote control and hosted workspaces

The HTTP server can require `Authorization: Bearer <token>`. That bearer token gates remote API access. `user_id` is a self-asserted participant identity for attribution, turn-conflict display, and presence; it is not an authorization secret and must not be treated as proof of workspace membership.

- Requests without `user_id` keep local-first behavior.
- Requests with `user_id` stamp attribution where the schema supports it.
- Presence uses `user_id` for ephemeral active/typing snapshots and is not persisted.
- The first identified user to create an empty hosted workspace becomes owner.
- Workspace membership remains durable security data, but remote-control routes must not infer access control from `user_id` alone.

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
