# Rika Context

## Vocabulary

- **Organization:** the top-level identity and access boundary for people and Projects.
- **Project:** an Organization-owned collaboration and access boundary for Threads.
- **Workspace:** the directory tree an Executor exposes to one Thread. A local Workspace belongs to one registered device; a remote Workspace belongs to one E2B sandbox lineage.
- **Thread:** a durable Organization-owned conversation and work record in one Workspace with one immutable execution kind.
- **Turn:** one human- or Agent-authored instruction and its top-level Execution.
- **Model Turn:** one TenetKit model call plus the tool calls emitted by that call. One Rika Turn may contain one or more Model Turns.
- **Pending Turn:** a durable instruction waiting for its own Execution while another Turn is active.
- **Execution:** TenetKit-owned durable work for a Turn or Child Run.
- **Agent:** an immutable TenetKit definition that configures the model/tool loop used by an Execution. It is not a durable identity, conversation, or the loop itself.
- **Child Run:** a durable child Execution with narrowed instructions or capabilities. User-facing copy may say subagent.
- **Mode:** a user-named behavior profile that selects model routes and reasoning behavior.
- **Provider:** a configured connection to a model service. Credentials come from named environment variables or a profile-scoped account login; each admitted route pins the authentication kind and non-secret credential identity.
- **Resolved Context:** the guidance, mentions, skills, memory, and Thread references selected for an Execution.
- **Cell:** one `typescript` tool call and the TypeScript source it evaluates in the Session's kernel.
- **Kernel:** the persistent Bun REPL process one TenetKit Session evaluates its cells in. Its namespace is working memory, never durable authority.
- **Kernel Epoch:** one identified kernel profile — runtime, workspace, limits, trust mode, and bindings digest. A changed surface starts a new epoch.
- **Binding:** one Schema-validated `rika.*` operation mounted into the kernel.
- **Continual Harness:** the scoped, versioned memories, skills, subagent specs, and prompt notes an Execution is pinned to.
- **Goal:** one durable per-Thread objective with a status, an optional budget, and accumulated usage.
- **Thread Projection:** disposable Rika read state derived from product metadata and TenetKit Run events. It is not execution truth.
- **API:** the hosted Rika service that owns identity integration, Organizations, Projects, Thread access, command order, executor assignment, and shared projections.
- **Executor:** the process that owns one Workspace's filesystem, kernels, tools, and processes while it holds a fenced assignment. It does not own Thread or TenetKit authority.
- **Local Executor:** an Executor on a registered user device. It is selected by default for a new Thread and never becomes remote implicitly.
- **Remote Executor:** an Executor in an E2B sandbox. It exists only for a Thread explicitly created as remote.
- **Execution Kind:** the immutable `local-device` or `e2b` placement selected when a Thread is created.
- **Executor Generation:** the monotonically increasing fencing value for one Thread assignment. An Executor from an older generation cannot mutate authoritative state.
- **Client:** one authenticated CLI or TUI installation acting for a member.
- **Controller Lease:** the renewable single-writer right to send terminal input. Transcript and terminal output remain readable by every authorized collaborator.
- **Rika Server:** the hosted API process. The local background process is a Local Executor, not a second Server.
- **Profile:** a named local configuration identity and canonical data root, not a Mode.

## Ownership

- **Better Auth** owns users, sign-in identities, sessions, OAuth grants, Organizations, memberships, and invitations.
- **Rika API** owns Projects, Thread and Project grants, Clients, Threads, Turns, execution placement, command order, executor leases and fencing, shared projections, presence, terminal-control leases, audit records, model routing, and encrypted provider credential use.
- **Rika Executors** own Workspace access, kernels, coding tools, Workspace extensions, and executor-private operation receipts.
- **TenetKit** owns durable Runs, children, cancellation, replay, model turns, tool-call protocol, nested durable operations, the cell tool and kernel pool, harness state and refinement, steering, compaction, skills integration, and Run events.
- **PostgreSQL** is authoritative for hosted Rika product state and stores TenetKit's authority in TenetKit-owned tables through its released PostgreSQL runtime. Executors never receive direct database authority.
- **E2B** owns remote sandbox lifecycle and isolation. An E2B sandbox identifier or snapshot is never identity or product authority.
- **OpenTUI** renders the terminal only through the TUI adapter.

Do not call a Thread a session, chat, or Agent in product contracts, a Child Run an actor, a Thread Projection canonical execution state, an E2B sandbox a Thread, or the kernel namespace durable state.
