# Rika Context

This file is Rika's canonical vocabulary. Implementation details belong in specs and ADRs.

## Product

**Rika**: The local-only personal coding-agent CLI and TUI.

**Workspace**: The local directory tree within which a Thread may inspect and modify files.

**Thread**: A durable user-facing conversation and work ledger associated with a Workspace.

**Turn**: One user instruction and the agent execution it starts within a Thread.

**Pending Turn**: A durable user instruction accepted while another Turn is active and waiting to receive its own top-level Execution.

**Thread Host**: The perpetual Relay entity that durably drives one Thread: it wakes on delivered promotion messages and claims Pending Turns. It is not a Turn, not a session, and never owns product state.

**Execution**: Relay-owned durable work for a Turn, child run, or workflow step.

**Child Run**: A durable Relay execution spawned by another execution with narrowed instructions, tools, mode, budget, or output contract. User-facing copy may say subagent.

**Workflow**: A versioned Rika definition of durable sequence, parallelism, branches, joins, waits, retries, budgets, cancellation, and compensation compiled to Relay operations.

**Agent Mode**: A stable Rika behavior profile controlling model routing, reasoning, autonomy, budget, and default tools.

**Model Route**: Product configuration resolved through Baton to an Effect AI language-model layer.

**Tool**: A typed capability an agent may invoke to observe or change the Workspace or another external system.

**Permission Decision**: The canonical Baton/Relay policy result for a proposed tool call: allow, deny, or ask. An accepted ask may be remembered as always according to the published framework contract.

**Resolved Context**: The deterministic guidance, mentioned content, skills, optional thread memory, and thread references selected for an execution.

**Artifact**: A durable product output such as a patch, image, report, citation bundle, or exported transcript.

**Execution Event**: A Relay/Baton fact about durable execution progress.

**Thread Projection**: Rika-owned read state derived from execution events and product metadata for terminal rendering and search.

**Execution Cursor**: The durable position after which execution events are replayed.

**Live Transport**: A Rika-owned WebSocket boundary used only when execution and control streaming crosses a process boundary. In-process streams remain Effect Streams. Provider and MCP transports follow their package contracts.

**Skill**: A lazily activated instruction and resource package discovered from supported local skill directories.

**Plugin**: Trusted local TypeScript extension code that can register tools, policies, commands, agents, modes, or UI actions.

**MCP Server**: A local command or remote Model Context Protocol endpoint whose tools are adapted into Baton tools under Rika policy.

## Framework Boundaries

**Baton**: The package dependency that owns the non-durable agent loop, model/tool protocol, steering, permissions seams, compaction, and agent events.

**Relay**: The package dependency that owns durable executions, child runs, waits, joins, replay, and workflow runtime state.

**Effect SQL**: The persistence API Rika uses for product-owned SQLite state.

**OpenTUI**: The terminal renderer confined to the Rika TUI adapter.

## Avoided Vocabulary

- Do not call a Thread a session or chat in product contracts.
- Do not call a Child Run an actor.
- Do not call a Model Route a provider client.
- Do not call a Thread Projection canonical execution truth.
- Do not use orb, hosted control plane, remote runner, or Rivet vocabulary.
