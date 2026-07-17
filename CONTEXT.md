# Rika Context

## Vocabulary

- **Workspace:** the local directory tree a Thread may inspect and change.
- **Thread:** a durable user-facing conversation and work record in one Workspace.
- **Turn:** one user instruction and its top-level Execution.
- **Pending Turn:** a durable instruction waiting for its own Execution while another Turn is active.
- **Thread Host:** the Relay entity that wakes and claims Pending Turns. It drives promotion but owns no product state.
- **Execution:** Relay-owned durable work for a Turn, Child Run, or workflow step.
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

Do not call a Thread a session or chat in product contracts, a Child Run an actor, or a Thread Projection canonical execution state.
