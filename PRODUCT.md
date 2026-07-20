# Rika Product

Rika is a personal coding agent for one developer working in local repositories. It combines a clear terminal interface with durable threads, parallel agent work, approvals, and restart-safe workflows. The goal is to make substantial coding work understandable while it runs and recoverable when a process stops.

## Audience

Rika is for a technical owner who prefers a local CLI and TUI, controls the workspace and credentials, and wants automation without operating a hosted Rika service.

## Direction

- Keep product state and authority local.
- Make ongoing and completed agent work easy to inspect in the terminal.
- Preserve durable work across process failure without duplicating execution authority.
- Expose typed tools and clear permission choices rather than unrestricted model access.
- Keep model routes configurable while modes describe stable user intent.
- Consume framework behavior through released package contracts.
- Prefer one current pre-1.0 contract over compatibility layers.

## Boundaries

Rika owns local product semantics, workspace policy, configuration, projections, tools, extensions, persistence, and terminal behavior. Relay owns durable execution. Baton owns the agent loop. OpenTUI stays behind the rendering adapter.

Rika is not a hosted collaboration service, public agent SDK, account or billing system, web or IDE client, remote runner, sandbox platform, or social sharing product. It does not copy another product's branding or protocol, and it does not own a local semantic code index or an ast-grep outline subsystem.
