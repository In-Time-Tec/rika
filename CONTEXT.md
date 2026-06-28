# Rika Context

Rika is the domain of an autonomous coding agent system: human users work with durable agent threads that inspect, edit, review, and extend software projects.

## Language

**Rika**:
The product and codebase name for the Effect-native coding agent system.
_Avoid_: Orika, Amp clone, wrapper

**Thread**:
A durable conversation and work ledger for one user task, including messages, tool calls, state transitions, and artifacts.
_Avoid_: Chat, session, transcript

**Turn**:
One user instruction and the agent work it triggers inside a thread.
_Avoid_: Prompt, request, run

**Artifact**:
A durable output associated with a thread, such as a patch, image, research note, review finding, or shared reference.
_Avoid_: Attachment, blob, result

**Resolved Context**:
The deterministic set of guidance files, mentioned files, images, and thread references selected for one turn before model execution. Resolved context is persisted for replay/debugging and rendered as untrusted data, not policy.
_Avoid_: Prompt stuffing, hidden instructions, implicit context

**Workspace**:
The filesystem and repository context where a thread is allowed to inspect and modify code.
_Avoid_: Project, cwd, folder

**Agent Mode**:
A named behavior profile that controls model routing, autonomy, reasoning depth, and default tool policy.
_Avoid_: Model, preset, personality

**Model Provider**:
A model backend Rika can ask for assistant output through Effect AI provider packages. Agent modes choose a model provider without making threads or tools care which backend answers.
_Avoid_: Vendor SDK, model client, API wrapper

**Tool**:
A typed capability the agent may invoke to observe or change the outside world.
_Avoid_: Function, command, action

**Specialty Tool**:
A purpose-built tool for work that should leave the main agent path, such as second-opinion reasoning, external codebase research, or image generation.
_Avoid_: Provider name, magic model, side channel

**Citation**:
A durable reference that supports external research output with a source title, repository or URL, and optional file/line or excerpt details.
_Avoid_: Footnote, source blob, search hit

**Subagent**:
An isolated agent worker with its own context that performs a bounded task and returns a final result to the parent thread.
_Avoid_: Worker, child thread, task agent

**Skill**:
A loadable package of task-specific instructions and resources that changes how the agent approaches a class of work.
_Avoid_: Prompt snippet, macro, recipe

**Plugin**:
Executable extension code that can register tools, commands, UI, policies, hooks, or custom agent surfaces.
_Avoid_: Skill, MCP server, script

**Self-Extension**:
An auditable workflow where Rika creates or modifies its own project-local skills and plugins through normal workspace files, records the resulting diff and trust decision as an artifact, and keeps executable plugins disabled until explicitly verified and enabled.
_Avoid_: Hidden mutation, hot patch, magic self-modification

**Trust Decision**:
A durable record of why executable extension code is enabled, disabled, or rolled back, including whether verification ran and who or what made the decision.
_Avoid_: Permission prompt, boolean flag, implicit approval

**MCP Server**:
An external Model Context Protocol endpoint that Rika can connect to and expose as policy-governed tools. Workspace command MCP servers require explicit approval before execution.
_Avoid_: Plugin, built-in tool, trusted script

**Permission Policy**:
A rule set that decides whether a proposed tool call is allowed, rejected, modified, or synthesized.
_Avoid_: Approval flow, safety setting, guardrail

**Event Log**:
The canonical append-only record of thread and workspace-relevant facts.
_Avoid_: Database, history table, audit log

**Projection**:
A rebuildable read model derived from the event log for fast UI, search, or runtime decisions.
_Avoid_: Cache, state, snapshot

**Thread Actor**:
The active runtime owner for one thread's orchestration, hot state, model loop, and tool execution queue.
_Avoid_: Session process, worker, server object

**Interactive Session**:
A terminal UI run that renders thread events, accepts prompts and command-palette commands, and delegates turns to the agent loop. Interactive sessions are adapters over durable threads, not a separate source of truth.
_Avoid_: Terminal state, chat UI, REPL transcript

**IDE Client**:
An editor-side participant connected to Rika for one or more workspaces. It can supply editor context and receive requests to reveal code without becoming the thread's source of truth.
_Avoid_: Editor plugin, IDE session, frontend

**IDE Context**:
The user-visible editor state supplied by an IDE client for a turn, including open workspace roots, active file, selection, and diagnostics.
_Avoid_: Editor state, workspace snapshot, hidden prompt

**Navigation Request**:
A request for an IDE client to reveal a file or range for the user. It is advisory UI steering, not a workspace mutation.
_Avoid_: Open-file command, editor action, jump

**Remote Control**:
The API surface that lets external clients, IDEs, CLIs, or SDK users inspect and steer active Rika threads.
_Avoid_: Webhook, daemon API, RPC
