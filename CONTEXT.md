# Rika Context

## Vocabulary

- **Workspace:** the local directory tree a Thread may inspect and change.
- **Thread:** a durable user-facing conversation and work record in one Workspace.
- **Turn:** one human- or Agent-authored instruction and its top-level Execution.
- **Model Turn:** one Baton model call plus the tool calls emitted by that call. One Rika Turn may contain one or more Model Turns.
- **Pending Turn:** a durable instruction waiting for its own Execution while another Turn is active.
- **Thread Host:** the Relay entity that carries durable wake signals to Rika's registered root-Turn promoter. It never claims or owns Pending Turns or other product state.
- **Execution:** Relay-owned durable work for a Turn, Child Run, or workflow step.
- **Agent:** an immutable Baton definition that configures the model/tool loop used by an Execution. It is not a durable identity, conversation, or the loop itself.
- **Child Run:** a durable child Execution with narrowed instructions or capabilities. User-facing copy may say subagent.
- **Workflow:** versioned Rika data compiled to Relay durable operations.
- **Mode:** a stable behavior profile that selects model routes and reasoning behavior.
- **Provider:** a configured connection to a model service. Credentials come from the environment.
- **Resolved Context:** the guidance, mentions, skills, memory, and Thread references selected for an Execution.
- **Thread Projection:** disposable Rika read state derived from product metadata and Relay events. It is not execution truth.
- **Resident Rika Service:** the single execution and persistence owner for a Profile and canonical data root.
- **Profile:** a named local configuration identity and canonical data root, not a Mode.

## Ownership

- **Rika** owns Threads, Turns, Workspaces, modes, configuration, projections, tools, extensions, and terminal behavior.
- **Relay** owns durable executions, children, waits, joins, cancellation, replay, and workflow runtime state.
- **Baton** owns model turns, tool-call protocol, steering, compaction, skills integration, and agent events.
- **Effect SQL** owns the API used for Rika's SQLite persistence.
- **OpenTUI** renders the terminal only through the TUI adapter.

Do not call a Thread a session, chat, or Agent in product contracts, a Child Run an actor, or a Thread Projection canonical execution state.
