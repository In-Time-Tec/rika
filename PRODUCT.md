# Rika Product

Rika is a collaborative coding agent for organizations working in local repositories and isolated remote workspaces. It combines a clear terminal interface with durable Threads, parallel agent work, restart-safe execution, and shared control. The goal is to make substantial coding work understandable while it runs, recoverable when an executor stops, and accessible to the people an organization trusts.

## Audience

Rika is for technical teams that prefer a CLI and TUI, need local development to remain direct, and want an explicit remote option for durable collaborative work.

## Direction

- Keep organization, access, and shared Thread authority in the hosted API.
- Keep local and remote execution as explicit first-class choices; never move work between them implicitly.
- Run remote work only in isolated E2B workspaces while preserving TenetKit as execution authority.
- Let multiple authorized people inspect and control durable work without sharing host or provider credentials.
- Make ongoing and completed agent work easy to inspect in the terminal.
- Preserve durable work across process failure without duplicating execution authority.
- Expose one programmable environment whose capabilities act with the selected executor's authority.
- Keep model routes configurable while modes describe stable user intent.
- Consume framework behavior through released package contracts.
- Prefer one current pre-1.0 contract over compatibility layers.
- Keep each public contract at its exact owning subpath so product semantics do not leak through adapter-shaped facades.

## Boundaries

Rika owns identity integration, organizations, access, execution placement, workspace policy, configuration, projections, tools, extensions, product persistence, and terminal behavior. TenetKit owns durable execution and the agent loop. E2B supplies remote sandbox infrastructure without becoming product authority. OpenTUI stays behind the rendering adapter.

Rika is not a billing system, public agent SDK, web or IDE coding client, general sandbox platform, or social network. Local execution is not isolated from the developer's machine; remote isolation belongs to E2B. Rika does not copy another product's branding or protocol, support interchangeable remote providers, or own a local semantic code index or ast-grep outline subsystem.
