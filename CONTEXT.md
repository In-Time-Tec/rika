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

**Subagent**:
An isolated agent worker with its own context that performs a bounded task and returns a final result to the parent thread.
_Avoid_: Worker, child thread, task agent

**Skill**:
A loadable package of task-specific instructions and resources that changes how the agent approaches a class of work.
_Avoid_: Prompt snippet, macro, recipe

**Plugin**:
Executable extension code that can register tools, commands, UI, policies, hooks, or custom agent surfaces.
_Avoid_: Skill, MCP server, script

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

**Remote Control**:
The API surface that lets external clients, IDEs, CLIs, or SDK users inspect and steer active Rika threads.
_Avoid_: Webhook, daemon API, RPC
