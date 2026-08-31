# Rika Context

## Vocabulary

- **Hosted Owner:** the resource boundary for hosted state, represented by either a user's Personal Owner or an Organization Owner.
- **Personal Owner:** the mandatory Hosted Owner for one user.
- **Organization Owner:** an optional Hosted Owner backed by a Better Auth Organization and its memberships.
- **Project:** an optional Hosted Owner-scoped collaboration and repository boundary for Threads.
- **Workspace Identity:** an opaque hosted identity that an assigned Executor maps to its machine-local directory tree. A path, E2B sandbox identifier, or provider snapshot is never Workspace Identity.
- **Workspace:** the directory tree an Executor exposes for one Workspace Identity. A Runner Workspace belongs to one registered user-controlled checkout; an Orb Workspace belongs to one E2B sandbox lineage.
- **Thread:** a durable Hosted Owner-scoped conversation and work record in one Workspace with one immutable Execution Target.
- **Turn:** one human- or Agent-authored instruction and its top-level Execution.
- **Model Turn:** one Generalist model call plus the tool calls emitted by that call. One Rika Turn may contain one or more Model Turns.
- **Pending Turn:** a durable instruction waiting for its own Execution while another Turn is active.
- **Execution:** Generalist-owned durable work for a Turn or Child Run.
- **Agent:** an immutable Generalist definition that configures the model/tool loop used by an Execution. It is not a durable identity, conversation, or the loop itself.
- **Child Run:** a durable child Execution with narrowed instructions or capabilities. User-facing copy may say subagent.
- **Mode:** a user-named behavior profile that selects model routes and reasoning behavior.
- **Provider:** an API-owned connection to a model service. Each admitted route pins the model definition, authentication kind, and non-secret owner-scoped credential identity; Railway resolves the credential only when constructing the Generalist model resource.
- **Resolved Context:** the guidance, mentions, skills, memory, and Thread references selected for an Execution.
- **Cell:** one `typescript` tool call and the TypeScript source it evaluates in the Session's kernel.
- **Kernel:** the persistent Bun REPL process one Generalist Session evaluates its cells in. Its namespace is working memory, never durable authority.
- **Kernel Epoch:** one identified kernel profile — runtime, workspace, limits, trust mode, and bindings digest. A changed surface starts a new epoch.
- **Binding:** one Schema-validated `rika.*` operation mounted into the kernel.
- **Continual Harness:** the scoped, versioned memories, skills, subagent specs, and prompt notes an Execution is pinned to.
- **Goal:** one durable per-Thread objective with a status, an optional budget, and accumulated usage.
- **Thread Projection:** disposable Rika read state derived from product metadata and Generalist Run events. It is not execution truth.
- **API:** the private hosted Rika service that owns identity integration, Organizations, Projects, Thread access, command order, executor assignment, and shared projections.
- **Web:** the private hosted FoldKit Thread control and review client plus browser identity pages. It calls the API and owns no identity, product, execution, or Workspace authority.
- **Proxy:** the only public hosted ingress. It routes same-origin browser, API, OAuth, health, and executor traffic to private services and owns no product authority.
- **Executor:** the process that owns one Workspace's filesystem, kernels, tools, and processes while it holds a fenced assignment. It does not own Thread or Generalist authority.
- **Runner:** a registered user-controlled process that executes assigned Threads in an approved checkout. The interactive CLI registers its current Runner; `rika --no-tui` runs it headlessly.
- **Orb:** a Rika-managed remote Executor in an E2B sandbox lineage, created only for a Thread explicitly targeting an Orb.
- **Execution Target:** the immutable `runner` or `orb` placement selected when a Thread is created.
- **Executor Generation:** the monotonically increasing fencing value for one Thread assignment. An Executor from an older generation cannot mutate authoritative state.
- **Client:** one authenticated TUI, CLI, automation, or FoldKit browser connection acting for a user, and optionally through an Organization membership.
- **Terminal Writer Lease:** the renewable single-writer right to send terminal input. Transcript and terminal output remain readable by every authorized collaborator.
- **Rika Server:** the hosted API process. A Runner is an Executor, not a second Server.
- **Profile:** a named local configuration identity and canonical data root, not a Mode.

## Ownership

- **Better Auth** owns users, sign-in identities, sessions, OAuth grants, Organizations, memberships, and invitations. Organization membership is optional.
- **Rika API** owns Hosted Owners, Projects, Thread and Project grants, Clients, Threads, Turns, execution placement, command order, executor leases and fencing, shared projections, presence, terminal-control leases, audit records, model routing, and encrypted provider credential use.
- **Rika Web** owns FoldKit browser rendering and local browser interaction state only; it depends on the API for authenticated Thread and account state.
- **Rika Proxy** owns public route selection and transport forwarding only.
- **Rika Executors** own Workspace access, kernels, coding tools, Workspace extensions, and executor-private operation receipts.
- **Generalist** owns durable Runs, children, cancellation, replay, model turns, tool-call protocol, nested durable operations, the cell tool and kernel pool, harness state and refinement, steering, compaction, skills integration, and Run events.
- **PostgreSQL** is authoritative for hosted Rika product state and stores Generalist's authority in Generalist-owned tables through its released PostgreSQL runtime. Executors never receive direct database authority.
- **E2B** owns remote sandbox lifecycle and isolation. An E2B sandbox identifier or snapshot is never identity or product authority.
- **OpenTUI** renders the terminal only through the TUI adapter.
- **TUI** owns presentation, local selection, and control input only. It never owns product state, Runs, Workspace side effects, or executor lifecycle, and disconnecting it never cancels hosted work.

Do not call a Thread a session, chat, or Agent in product contracts, a Child Run an actor, a Thread Projection canonical execution state, an E2B sandbox a Thread, or the kernel namespace durable state.
