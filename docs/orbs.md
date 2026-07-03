# Orbs

Orbs run a thread inside a remote sandbox created from a Project profile.

## Provisioning

`OrbManager.provisionForThread` creates a staged orb row, starts an E2B sandbox with `thread_id` and `project_id` metadata, places the repository at `/home/user/repo`, runs setup there, starts `rika server --orb --base-commit <sha>` with `RIKA_SUBAGENT_TOOLS=full`, waits for authenticated `/health`, then stores the endpoint and marks the orb running.

The default repository transfer path is a local git bundle. This supports local branches that have not been pushed to the Project origin.

Set `RIKA_ORB_CLONE=origin` to clone the Project `repo_origin` and `default_branch` instead. Origin clone mode is for repositories where the remote branch is the intended source of truth.

## Credentials

Project environment variables and Project secrets are injected only as per-command process environment for sandbox exec calls. They are not written to the repository bundle, sandbox files, diagnostics, command arguments, or orb records.

For private origin clones, store a Project secret named `GIT_TOKEN`. Rika passes it to the clone command environment as `GIT_TOKEN`; the token must not be embedded in the clone URL or persisted in git config.

The orb server token is generated per provisioning run and stored only through `OrbStore.endpointCredentials`. Normal orb record reads omit the token.

## MCP Servers

During provisioning, Rika copies approved workspace MCP servers from `<workspace>/.rika/settings.json` into `/home/user/repo/.rika/settings.json` inside the sandbox and seeds matching approval rows there. Unapproved workspace command servers are omitted. MCP config values that reference unresolved project env or secret variables are omitted with a provisioning warning.

Remote URL MCP servers are sandbox-safe when their headers and network endpoint are valid from the sandbox. Local command MCP servers are sandbox-safe only when the command binary and its runtime dependencies are installed in the orb template.

## Sync

`rika sync <thread-id>` mirrors a running orb thread's workspace changes into a local dedicated worktree at `<workspace>/.rika/worktrees/<thread-id>`. The CLI resolves the thread's orb endpoint, fetches `/v1/orb/changes`, verifies the orb base commit exists locally, then resets and cleans the worktree before applying the binary patch.

The worktree stays under `.rika/`, which is ignored by the repository. Re-running sync is idempotent for tracked edits, new untracked files, and binary files because the worktree is reset to the base commit and cleaned before each apply.

## Usage Visibility

`OrbStore` records running intervals when an orb enters `running` and closes them when it leaves `running`. Startup repair closes stale open intervals for non-running orbs at the orb's `last_active_at` timestamp.

Use `rika orb usage [--project <name>] [--since <ISO date>]` to print per-orb running minutes and interval counts plus a grand total. This is operational visibility only; Rika does not implement hosted billing or pricing.
