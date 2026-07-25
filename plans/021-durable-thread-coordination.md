# Plan 021: Durable Thread coordination for Agents

> **Executor instructions**: Implement this plan in order. An agent-created Thread is a normal
> Rika Thread with a top-level Relay Execution, never a Child Run. Preserve one execution
> authority, one Turn queue, and one transcript projection. Do not touch `repos/*`.

## Status

- **Priority**: P1
- **Effort**: XL (18–27 engineering days including Relay prerequisite, delivery, and
  recovery proof)
- **Risk**: HIGH (durable mutation tools, root-execution ownership, schema migration, and
  concurrent same-Workspace agents)
- **Depends on**: Plan 020 phases 1–3 for structured bounded retrieval. Plan 020 phase 4
  may ship with empty related-Thread pages; this plan's slice 5 adds relation-aware prompt
  behavior without creating a circular dependency
- **Category**: durable agent orchestration and Thread interfaces
- **Planned at**: current Workspace state, 2026-07-23
- **Status**: TODO

## Goal

A Rika agent can create an independent durable Thread in its current Workspace, send a
durable message to another known Thread in that Workspace, inspect compact recent
messages, wait for exact accepted work, and ask ReadThread a grounded question about the
result. The target continues independently if the source Turn completes, fails, or is
cancelled. Resident restart neither loses nor duplicates admitted work.

By default, when an agent-created Thread finishes, Rika delivers its bounded final answer
back to the source Thread as a new agent-authored Turn. `RootTurnOwner` wakes the source
Thread, and a new root Agent run inspects the result and decides what to do next.
The source tool call does not need to remain open. An explicit manual result channel lets
the source use `wait_for_threads` instead, but the two channels are never combined.

This adds connected agent-created Threads alongside existing Child Runs:

- A **Child Run** remains a narrowed Relay child Execution whose lifetime, result, depth,
  projection, and cancellation are owned by its parent Turn.
- An **agent-created Thread** is a normal Rika Thread and each instruction is a normal root Turn.
  Creation/message provenance links it to another Thread, but the link does not transfer
  execution ownership or imply cancellation.

Success means all of the following are true:

1. `create_thread` returns a stable `{ threadId, turnId }` after the new Thread and first
   Turn are durably admitted, without waiting for completion.
2. `thread_interact` with `action: "message"` returns a stable accepted Turn handle. An
   idle target starts; a busy target uses the existing FIFO Pending Turn queue.
3. A Relay retry after local commit returns the same handle and never creates a duplicate
   Thread, Turn, prompt, or root Execution.
4. Source and target use the exact same stored Workspace. No create/send input accepts a
   Workspace path.
5. Agent-authored prompts are structurally distinct from human instructions in model
   context, transcript projection, TUI, export, search, and ReadThread evidence.
6. `thread_interact` with `action: "preview_messages"` returns recent structured messages
   within a strict budget;
   `read_thread` progressively follows explicit nested Child Run and related-Thread
   provenance.
7. `wait_for_threads` waits on exact accepted Turn handles, returns on terminal or
   actionable waiting state, has a finite timeout, and never cancels target work.
8. Every accepted agent-authored Turn has exactly one result channel: durable reply to source or
   explicit wait/manual inspection. Automatic replies are delivered once after the target
   result is projection-ready, survive restart, and never recursively reply to themselves.
9. `thread_interact` distinguishes FIFO message, active-Turn steer, active cancellation,
   whole-Thread stop, bounded preview, and status. Each mutation binds retry-stable target
   identities before performing effects.
10. Approval remains governed by the normal user path. An agent-authored message cannot approve a
    tool or elevate authority.
11. Restart tests force every admission/start/result/delivery ambiguity window and prove forward
    recovery without duplicate execution.

## Scope

### Included

- Rika-native agent-created Thread admission and same-Workspace messaging.
- Stable invocation identity from Relay tool calls to product handlers.
- Atomic idempotent Thread/Turn admission and durable provenance.
- One reusable root-Turn owner shared by interactive, Run, queued, recovery, and agent-created Thread
  paths.
- Compact preview/wait/cancel tools and question-driven ReadThread integration.
- Exactly-once bounded final-result delivery back to the creating/sending source Thread.
- Related provenance in search, transcript reads, TUI projection, and exports.
- Explicit recursion/concurrency limits, diagnostics, migration, packaging, and installed
  acceptance proof.

### Required constraints

- Relay remains authoritative for execution, waits, replay, children, and cancellation.
- Rika remains authoritative for Threads, Turns, Workspaces, provenance, admission, and
  projections.
- Baton continues to own the agent loop, steering, compaction, and model/tool protocol.
- Independent background work is a root Turn. `invokeChild`, `childRuns`, child execution references, and
  child transcript attachment are forbidden for this path.
- No Amp dependency, external service, remote runner, actor, or hosted protocol.

### Deferred

- Interrupt-and-replace and approval resolution by another agent. Queue, steer, cancel,
  and stop are included, but agent-authored messages never approve tools.
- Cross-Workspace messages, arbitrary Workspace input, broadcast, and group Threads.
- Source-to-target cancellation or deletion propagation.
- Open-ended waits for an entire Thread rather than exact accepted Turn handles.
- Generated relationship summaries, embeddings, semantic memory, and unbounded traversal.
- A new `rika --no-tui` mode or bidirectional external-controller protocol. The resident
  already provides the process owner this feature needs.

## Current behavior and root causes

### Rika has durable Threads but agents cannot control them

The CLI and TUI can create, select, continue, fork, preview, queue, steer, cancel, and
resolve approvals. Those behaviors are methods on one active `InteractiveSession` or
branches inside `Operation.productLayer`. Model tools expose only delegated `read_thread`
and its two internal retrieval tools.

`create_thread` and `send_message_to_thread` already have transcript presentation
fallbacks, but no schemas, registrations, handlers, or product implementation. Replace
those speculative names with the real `create_thread` and discriminated `thread_interact`
contracts rather than treating presentation fallbacks as functionality.

Current owners:

- `packages/app/src/operation.ts` owns root submission, following, queue promotion,
  reconciliation, and projection.
- `packages/persistence/src/thread-repository.ts` and `turn-repository.ts` own product
  records and atomic per-Thread queue constraints.
- `packages/runtime/src/execution-backend.ts` owns Relay mapping and tool execution.
- `packages/tools` owns model-facing contracts and policy metadata.

Concrete duplication to remove is in `packages/app/src/operation.ts`:
`reconcileInternal` around lines 264–512, interactive submission around 2090–2274,
queued promotion around 2432–2660, and CLI Run around 3940–4148. Runtime root mapping is
in `packages/runtime/src/execution-backend.ts` around 428–438, 650–662, and 1506–1565;
`ExecutionBackend.follow` already wraps Relay follow plus child-tree reconciliation around
817–1021. `routedToolRuntimeLayer` around 216–285 reads Relay `ToolCallInfo` but currently
drops `eventSequence` and `idempotencyKey` before `@rika/tools` handlers. Queue state and
wake generations remain owned by `TurnRepository`, and Thread Host calls its registered
promoter. The current product database migration is 16.

### An agent-created Thread cannot be implemented as another Child Run

Root execution identity is `execution:${turnId}` and uses the stable Relay Session for its
Thread. Child identity encodes parent execution and tool call, inherits depth, is followed
as a descendant, appears beneath a parent tool row, and is recursively cancelled with its
parent.

Using Child Run APIs would make the conversation non-selectable, non-messageable, and
parent-owned. The target must first exist as a Rika Thread and Turn, then use the ordinary root
start path.

### The correct root lifecycle exists but has several owners

Interactive submission currently:

1. creates/selects a Thread;
2. pins the route;
3. atomically admits an accepted or queued Turn;
4. claims an observer;
5. prepares context and extension pins;
6. starts/follows Relay with live events;
7. persists transcript and summary projection;
8. settles terminal state and drains queued work.

Run, queue promotion, and startup reconciliation repeat parts of this path. Agent-callable Thread tools
must not add a fourth copy or call `InteractiveSession`: selection state, TUI dispatch,
and session-scoped fibers are the wrong owners for independent work.

### Relay tool context has the idempotency key, but Rika drops it

The released Relay tool context supplies a stable `idempotencyKey`, execution identity,
tool call, event sequence, and timestamp. Rika uses execution identity for Workspace
routing and logs the call id, then invokes `@rika/tools` without invocation context.

Relay may retry after Rika committed but before Relay stored the result. Admission must
deduplicate on the stable invocation key and reject reuse with different canonical input.
Do not build against an unverified Relay `operationId`, and do not pass Relay branded
types into tools or app contracts.

### Existing records cannot distinguish the speaker

`Thread` has Workspace/display metadata only. `Turn` stores prompt, attachments, status,
route, and timestamps. Transcript creation treats every Turn prompt as human `user` input.

Agent-authored text must remain actionable model input, but cannot impersonate human
approval or silently inherit system authority. Author, lineage, and relationships must be
durable product data from which model context and all projections derive.

### Same-Workspace roots have no global cap

Each Thread serializes its own Turns, but separate Threads in one Workspace may run with
unbounded concurrency. Relay tool execution is also unbounded. This is acceptable for
explicit human sessions but unsafe for recursive agent-created Threads editing the same
files. The first release needs enforceable product limits.

## Research basis

Amp is a behavioral reference, not a dependency. Its Thread API separates create/accept,
append, bounded reads, wait, and cancel, while recording parent provenance without making
the Thread a nested execution.

The current Amp plugin contract was inspected in depth. The useful interface distinctions
to preserve in Rika are:

- `Agent.createThread({ parentThreadID })` returns an independently running background
  Thread handle; the Thread outlives the caller.
- `PluginThread.appendUserMessage` queues a normal message and can mark it preferred for
  the next safe interruption point.
- `PluginThread.waitForResponse` waits for running/awaiting-approval to return to idle and
  returns the last assistant reply; `state` separately reports idle, running,
  awaiting-approval, and error.
- `PluginThread.messages` defaults to the newest ten, caps at twenty, and distinguishes
  inference-visible compacted context from explicit full-history reads.
- `PluginThread.cancel` stops the current Turn rather than deleting the Thread.
- Amp's built-in agent-to-agent tool attaches source/reply routing; background agents can
  report their final result back while the creator continues other work.
- Amp separates public `find_thread` discovery from question-driven `read_thread` and
  separates normal queueing from steering and forced interruption.

Rika adopts those interfaces where they fit, but uses normal Rika Turns, Relay roots,
Rika's existing queue, local Workspace confinement, and durable projection-ready delivery.
It does not adopt Amp executors, cloud/orb routing, plugin handles, or private APIs.

Primary sources consulted 2026-07-23:

1. Amp plugin Thread behavior: <https://ampcode.com/manual/plugin-api>
2. Amp's specialist, question-driven Thread reading:
   <https://ampcode.com/news/read-threads>
3. Temporal accepted/completed messaging, handler ordering, and message ids:
   <https://docs.temporal.io/handling-messages>
4. Temporal's commit/result-loss and origin-generated idempotency guidance:
   <https://temporal.io/blog/idempotency-and-durable-execution>
5. Anthropic's focused handoffs, progressive search, parallelism, and tracing:
   <https://www.anthropic.com/engineering/multi-agent-research-system>
6. Anthropic's just-in-time retrieval and subagent context isolation:
   <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
7. OpenAI's manager/tool versus handoff ownership choice:
   <https://developers.openai.com/api/docs/guides/agents/orchestration>

These sources support accepted handles, explicit provenance, idempotent admission,
context isolation, and bounded reads. They do not justify a swarm, shared scratchpad, or
second workflow engine.

### Amp behavior mapped to Rika ownership

| Amp interface/behavior                   | Useful semantic                                                   | Rika implementation                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `find_thread` keyword/file query DSL     | Discover first; do not dump histories                             | Public `find_thread` over Plan 020 FTS, successful file-path evidence, current Workspace only                                                                                              |
| question-driven `read_thread` subagent   | Isolate large retrieval context and return only relevant evidence | ReadThread over structured recent/relevant/subtree/related selectors; checks later revisions and terminal outcomes                                                                         |
| `Agent.createThread({ parentThreadID })` | Independent background conversation with explicit source link     | New Rika Thread + root Turn + retained source relationship; no Relay Child Run                                                                                                             |
| `appendUserMessage`                      | Normal communication becomes a later Turn                         | `thread_interact { action: "message" }` through existing accepted/FIFO queued Turn admission                                                                                               |
| queued message with steering preference  | Handle the message at a safe interruption point                   | `thread_interact { action: "steer" }` against the receipt-bound active root through retry-safe Relay steering                                                                              |
| `messages({ from: "end", limit })`       | Recent context by default with bounded pagination                 | `preview_messages`, newest 10/default, max 20, persisted semantic messages and opaque cursor                                                                                               |
| `state`                                  | Status is separate from message content                           | `status` reports idle/queued/running/awaiting-approval/error plus active Turn and queue count                                                                                              |
| `waitForResponse()`                      | Blocking join returns final assistant reply                       | `wait_for_threads` over exact manual-result Turn handles and projection-ready final text                                                                                                   |
| `cancel()`                               | Stop current work, not delete Thread                              | `cancel` active scope; Rika additionally offers explicit Thread stop to cancel the bound queue set                                                                                         |
| built-in source/reply route              | Background completion reports back automatically                  | Pending delivery receipt atomically queues one bounded agent-authored Turn on the source Thread after projection readiness; `RootTurnOwner` wakes it and a new root Agent run decides next |
| execute-mode steer/message distinction   | Queue, safe-point steer, and force-stop are different             | Discriminated actions; no overloaded message boolean and no implicit cancellation                                                                                                          |

Rika intentionally narrows Amp's broader surface: no cross-project search, orb/local/runner
selection, file transfer, workspace teammates, remote machines, or public/shared Threads in
this release. The interfaces stay familiar while authority remains local and explicit.

## Target design

### Relay/Baton contract alignment

| Level                  | Contract and owner                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| Rika Thread            | Durable product conversation and work record; Relay has no Thread entity                       |
| Rika Turn              | One durable human- or Agent-authored instruction and its root Execution                        |
| Relay root Execution   | Durable execution truth for that Turn, grouped by a host-chosen SessionId                      |
| Baton Agent run        | One run of an immutable Agent definition; final content is `Completed.text`                    |
| 1..n Baton model turns | Each is one model call plus the tools emitted by that call                                     |
| Relay Child Run        | Durable child edge and ChildExecutionId; the child is then an ordinary Relay Execution/session |

```diagram
Rika Thread → Rika Turn → Relay root Execution → one Baton Agent run → 1..n Baton model turns
                                     └→ Relay child edge → separate child Execution
```

Relay has no Thread or durable product Agent identity. A Baton Session is append-only
agent-loop context and a host-owned checkpoint seam, not a Rika Thread; its transport
registry is process-local and never schedules durable Rika work. Relay SessionId is host
grouping, and Resident is runtime identity. Baton handoff, `AgentTool`, and `fanOut` are
same-process and non-durable; independent background Threads always use root Executions.
Provider prompt roles do not establish product authorship or human authority.

```diagram
┌──────────────────────── source root Turn ────────────────────────┐
│ find / read / create / interact / wait tool call                 │
└──────────────────────────────┬───────────────────────────────────┘
                               │ ToolInvocation
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ @rika/app ThreadToolGateway                                      │
│ stable forwarding port registered by resident product scope      │
└──────────────────────────────┬───────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ ThreadToolService                                                │
│ Workspace/authority/limit checks + idempotent admission           │
└───────────────┬───────────────────────────────┬───────────────────┘
                │                               │
                ▼                               ▼
┌────────────────────────────┐   ┌─────────────────────────────────┐
│ ThreadInteractionRepository│   │ RootTurnOwner                   │
│ atomic records/admission  │   │ prepare/start/follow/project/   │
│ admission by invocation key│   │ settle/reconcile in owner scope │
└───────────────┬────────────┘   └────────────────┬────────────────┘
                │                                 │
                ▼                                 ▼
┌────────────────────────────┐   ┌─────────────────────────────────┐
│ Rika SQLite product state  │   │ Relay root Execution           │
│ Turn/queue/author/receipts │   │ execution:${turnId}            │
└────────────────────────────┘   └─────────────────────────────────┘
```

### One ordinary Thread and Turn model

Store authorship, fork lineage, Thread relationships, and idempotency as separate facts.
They answer different questions and must not share one tagged union:

```ts
type ThreadLineage =
  | { readonly _tag: "Original" }
  | {
      readonly _tag: "Fork"
      readonly sourceThreadId: ThreadId
      readonly sourceTurnId?: TurnId
    }

type TurnAuthor =
  | { readonly _tag: "Human" }
  | {
      readonly _tag: "Agent"
      readonly sourceThreadId: ThreadId
      readonly sourceRootTurnId: TurnId
      readonly threadCreationDepth: number
    }

type TurnLineage =
  | { readonly _tag: "Original" }
  | {
      readonly _tag: "ForkCopy"
      readonly sourceThreadId: ThreadId
      readonly sourceTurnId: TurnId
    }
```

Migration 18 backfills every schema-17 Thread/Turn as `Human` plus `Original`. After that
migration, missing or malformed authoritative author/lineage data is an error; silently
defaulting future corruption to Human would be an authority escalation. An agent-authored
Turn copied by a fork therefore remains `Agent` + `ForkCopy` rather than losing authorship.

Source ids are non-cascading soft references. Deleting a source never deletes an
independent target or rewrites who authored it; retrieval reports `unavailable` when the
source cannot be resolved. Export includes author, source Thread/root Turn, and fork
lineage, but never Relay execution ids, tool-call ids, invocation hashes, or input hashes.

Add two internal persistence records:

```ts
interface ThreadInvocationBase {
  readonly invocationDigest: string
  readonly schemaVersion: 1
  readonly inputDigest: string
  readonly sourceThreadId: ThreadId
  readonly sourceRootTurnId: TurnId
  readonly sourceExecutionRef: string
  readonly sourceToolCallId: string
  readonly createdAt: number
}

type ThreadInvocationReceipt =
  | (ThreadInvocationBase & {
      readonly operation: "create" | "message"
      readonly targetThreadId: ThreadId
      readonly targetTurnId: TurnId
      readonly resultDelivery: "reply" | "manual"
      readonly outcome: "accepted"
    })
  | (ThreadInvocationBase & {
      readonly operation: "steer"
      readonly targetThreadId: ThreadId
      readonly targetTurnId?: TurnId
      readonly executionRef?: string
      readonly steeringText: string
      readonly state: "no-active-noop" | "bound" | "applied"
      readonly steeringMessageId?: string
      readonly steeringSequence?: number
    })
  | (ThreadInvocationBase & {
      readonly operation: "cancel"
      readonly targetThreadId: ThreadId
      readonly targetTurnId?: TurnId
      readonly executionRef?: string
      readonly state: "idle-noop" | "bound" | "applied"
      readonly observedStatus?: string
    })
  | (ThreadInvocationBase & {
      readonly operation: "stop"
      readonly targetThreadId: ThreadId
      readonly targetTurnId?: TurnId
      readonly executionRef?: string
      readonly queueRevision: number
      readonly queuedTurnIds: ReadonlyArray<TurnId>
      readonly state: "idle-noop" | "bound" | "applied"
      readonly observedStatus?: string
    })

type ThreadResultRoute =
  | {
      readonly channel: "manual"
      readonly targetTurnId: TurnId
      readonly sourceThreadId: ThreadId
      readonly sourceRootTurnId: TurnId
    }
  | {
      readonly channel: "reply"
      readonly targetTurnId: TurnId
      readonly sourceThreadId: ThreadId
      readonly sourceRootTurnId: TurnId
      readonly sourceExecutionRoute: ExecutionRoute
      readonly sourceCapabilityCeiling: CapabilityPin
      readonly delivery:
        | { readonly state: "awaiting-result" }
        | { readonly state: "ready"; readonly projectedCursor: string; readonly readyAt: number }
        | { readonly state: "delivered"; readonly deliveredTurnId: TurnId }
        | { readonly state: "source-unavailable" }
    }
```

Store a cryptographic digest of Relay's stable invocation key, not the raw key. The
globally unique receipt survives deletion of either endpoint, so a late Relay retry can
never recreate deleted work. Same invocation/same canonical input returns the stored
handle or no-op; reuse with different operation, source, target, route, mode, text,
`resultDelivery`, or control action fails. Steering text is internal persisted product
input required to finish an already-bound control after restart; never export or log it.

The result route is not another scheduler. Manual routes never enter delivery scans.
Reply routes persist the source root's execution route and capability ceiling at
admission, so a reply cannot inherit target authority or mutable current defaults. It is
an exactly-once result-routing
receipt. The delivered response is an ordinary accepted/queued source Turn, and the
existing root owner remains its only execution scheduler.

No durable Agent identity row or special Thread entity is introduced. `Agent.Agent` is an
immutable Baton definition value used to run the model/tool loop. A Thread created by an
Agent remains an ordinary Thread. Durable
provenance is source Thread plus source root Turn, with `Human` or `Agent` on each Turn.

### Atomic Thread admission, not a second scheduler

Add `ThreadInteractionRepository` in `@rika/persistence`:

```ts
interface ThreadInteractionRepository {
  readonly createThread: (input: CreateThreadInput) => Effect<AcceptedThreadTurn, ThreadAdmissionError>
  readonly appendMessage: (input: AppendThreadMessageInput) => Effect<AcceptedThreadTurn, ThreadAdmissionError>
  readonly bindSteer: (input: BindThreadSteerInput) => Effect<BoundThreadControl, ThreadControlError>
  readonly bindCancel: (input: BindThreadCancelInput) => Effect<BoundThreadControl, ThreadControlError>
  readonly bindStop: (input: BindThreadStopInput) => Effect<BoundThreadControl, ThreadControlError>
  readonly deliverResult: (input: DeliverThreadResultInput) => Effect<DeliveredThreadResult, ThreadDeliveryError>
}

interface AcceptedThreadTurn {
  readonly threadId: ThreadId
  readonly turnId: TurnId
}
```

`createThread` performs one transaction that resolves an existing receipt first, validates
the source and authority, enforces limits, creates one independent same-Workspace Thread,
inserts its first accepted Turn with pinned route/author/lineage, creates relationship and
delivery records, stores the receipt, and initializes queue state.

`appendMessage` resolves duplicate receipts first, rejects
self/missing/archived/cross-Workspace targets, enforces limits, and atomically stores its
receipt/relationship/delivery plus one accepted or queued Turn through the same active and
queue rules as human submission.

`bindSteer`, `bindCancel`, and `bindStop` resolve the target active root once and persist
that exact Turn before calling Relay. State-dependent negative outcomes are durable too:
a lost `no-active-steer` or idle cancel/stop result remains a no-op on retry and never
re-resolves later work. Stop additionally records and cancels the exact queued Turn ids
under the same queue revision; later messages are new work.

`deliverResult` runs only after the target Turn is projection-ready. In one transaction it
deduplicates on target Turn/channel, reads a bounded final assistant result, inserts one
agent-authored reply Turn on the source Thread (accepted or queued), records a `reply`
relationship, and marks delivery complete. Missing/deleted/archived source records become
`source-unavailable`, never an endless retry. Reply Turns have `channel: manual` so a
delivered result cannot recursively generate another automatic reply.

Only `reply/ready` routes enter the delivery scan, ordered stably by
`(readyAt, targetTurnId)`. Queue-full leaves the route ready. Capacity release from queue
claim, queued-Turn cancellation/stop, and other queue-removal transitions signals a
delivery rescan; startup reconciliation scans ready routes independently of normal queue
wakes. Insertion and transition to `delivered { deliveredTurnId }` are one transaction.

SQL and memory implementations preserve the same constraints. If current independent
memory repositories cannot provide atomic cross-record admission, introduce one
persistence-owned shared memory admission state; do not approximate the race with
check-then-write calls in `@rika/app`.

Thread/Turn ids are generated once during first admission and recovered through the
receipt. Relay start remains idempotent on stored Turn id. Do not derive user-visible ids
from secret invocation bytes. Reject hard deletion of a Thread with accepted, queued,
running, or waiting Turns. Retain invocation/delivery receipts after endpoint deletion.

### Rika-owned invocation context

Define a product-neutral Effect context in `@rika/tools`:

```ts
interface ToolInvocation {
  readonly executionId: string
  readonly callId: string
  readonly toolName: string
  readonly eventSequence: number
  readonly createdAt: number
  readonly idempotencyKeyDigest: string
}

interface InvocationSource {
  readonly rootTurnId: string
  readonly threadId: string
  readonly callerProfile: string
  readonly threadCreationDepth: number
  readonly effectiveGrants: ReadonlyArray<string>
}
```

`@rika/runtime` creates this context from released Relay `ToolCallInfo` around handler
execution and retains Relay-branded values inside the adapter. Relay exposes
`executionId`, `call`, `eventSequence`, `createdAt`, and stable `idempotencyKey` here; it
does not expose a tool-attempt id or Baton model-call/model-turn identity. `@rika/tools`
contracts stay transport-neutral.

Extend Rika's transport-neutral `ExecutionBackend` contract with
`resolveInvocationSource(executionId)`. `@rika/runtime` implements it from public Relay
inspection, child ancestry, and propagated metadata; app code never parses Relay root or
child execution strings. The result supplies `InvocationSource`. `ThreadToolService` then
loads the authoritative source Turn and Thread to derive exact stored Workspace, route,
mode, capability pins, and result-delivery ceiling. Missing, malformed, or conflicting
ancestry is a typed failure, never a fallback to the currently selected Thread. Wait uses
an absolute deadline derived from stable `createdAt`; restart never resets its timeout.

### One reusable root-Turn owner

Extract an app-internal `RootTurnOwner` from `Operation.productLayer`. It owns:

- observer claims and one owner-scoped follower per root Turn;
- preparation and extension pinning;
- calls to only `ExecutionBackend.start`, `follow`, `cancel`, and `inspect`, plus live projection;
- terminal settlement and summary repair;
- a rebuildable Rika projection-ready checkpoint containing the last committed root Relay
  cursor and sequence, canonical terminal or actionable-wait inspection, projected Baton
  `Completed.text`, and nested Child Run backfill reconciled or explicitly unavailable;
- exactly-once Thread-result delivery after that checkpoint;
- queue wake/promotion and session quiescence;
- restart reconciliation for accepted/running/waiting roots.

Final invariant: only `RootTurnOwner` may claim a root Turn, transition accepted/queued
work to running, call root `start`/`follow`, settle projections, deliver Thread results, or
promote queue work. Interactive, Run, recovery, Thread tool handlers, and Thread Host may submit
or signal work but never execute a root directly. TUI event dispatch is an optional
observer, not execution ownership.

Use compare-and-set transitions. Accepted becomes running only while still accepted;
queued becomes running only through its durable queue claim; terminal work never starts.
This closes cancellation during preparation. `schedule(turnId)` is only a non-durable
wake hint. The admitted Turn remains the recovery source, and restart invokes the same
owner for every nonterminal root.

After agent-created admission, accepted work is scheduled in resident `ownerScope`; queued work
uses the existing Pending Turn queue/Thread Host; a crash before scheduling is repaired
from the nonterminal Turn; source tool interruption never interrupts the target. Terminal
status alone is not completion for wait/delivery: the owner must make the projection-ready
checkpoint readable first. Recovery inspects and follows from the last committed cursor
through `ExecutionBackend`, then repairs that checkpoint; no
transaction spans Relay and Rika SQLite.

`@rika/runtime` alone owns Relay's `startByAddress`/`startByAgentDefinition`, branded IDs,
cursor-resuming follow, sequence dedupe, inspection reconciliation, and root/child tree
following. `RootTurnOwner` owns the Rika claim, status, transactional projection/checkpoint,
queue, and result delivery. Relay SQL/event log remains execution truth; notifications and
`EnvelopeReady` are adapter hints, never proof that Rika projected or rendered an event.
The derived projection and cursor/sequence commit in one Rika transaction.

Extend `ExecutionBackend.start`, `follow`, and Relay-backed `cancel` results with an
adapter-resolved `ExecutionCheckpoint { cursor, sequence }`. The pair identifies the root
event through which runtime reconciled the result, including an already-terminal or
actionable-wait follow that returns no new events. App code must not infer readiness from
`result.events.at(-1)`. If Relay rejects a stored cursor, runtime may replay from the
beginning only while deduplicating by canonical sequence and the committed checkpoint;
silently consuming from no cursor without that proof is forbidden.

The stable Rika Turn id is persisted before start. Runtime starts immutable input with
`execution:${turnId}`, `session:${threadId}`, and `idempotency_key: turnId`; an ambiguous
start retries that exact input. No extra start receipt is needed. Thread tool invocation
receipts still dedupe create, message, and control side effects.

Use a discriminated readiness authority shared by status, preview, wait, and reply:

```ts
type RootProjectionReadiness =
  | {
      readonly _tag: "WaitingReady"
      readonly relayCursor: string
      readonly relaySequence: number
      readonly inspection: "actionable-wait"
      readonly waitProjection: "synchronized"
    }
  | {
      readonly _tag: "TerminalReady"
      readonly relayCursor: string
      readonly relaySequence: number
      readonly status: "completed" | "failed" | "cancelled"
      readonly inspection: "terminal"
      readonly completedOutput: "projected" | "not-produced"
      readonly childBackfill: "reconciled" | "unavailable"
    }
  | {
      readonly _tag: "CancelledBeforeStartReady"
      readonly status: "cancelled"
      readonly completedOutput: "not-produced"
    }
```

Waiting readiness never requires terminal fields. Terminal wait/delivery never infers
readiness from Turn status alone. A receipt-bound cancel or stop that wins while the Turn
is still accepted atomically records `CancelledBeforeStartReady`, prevents
accepted-to-running, and never calls Relay. Running or waiting roots use the Relay-backed
cancel path and require its execution checkpoint. Automatic reply delivery may use the
local readiness variant to report deterministic cancellation without inventing a Relay
cursor or Execution.

### Gateway breaks construction order without another durable queue

The backend needs handlers before `Operation.productLayer` exists, while background execution
needs the product-owned root owner. Add a scoped linearizable forwarding registry. Its API
may resemble `ThreadHost.Registry`, but that mutable one-slot callback is not a sufficient
lifecycle implementation:

```ts
interface ThreadToolGateway {
  readonly register: (service: ThreadToolService) => Effect<Subscription>
  readonly createThread: (...) => Effect<AcceptedThreadTurn, ThreadToolUnavailable | ...>
}
```

`ThreadToolService` is the service behind Agent-callable Thread tools; it is not an
entity. The gateway is only its construction-order and lifetime seam.

The gateway exists while the backend is assembled. It permits exactly one generation of
the product service. Registration returns a token so an old finalizer cannot unregister a
replacement. Each call acquires an in-flight lease; shutdown rejects new admission,
drains acquired calls, unregisters the generation, and only then closes the owner.

Resident startup registers the owner before recovery resumes any execution that can call
Agent-callable Thread tools. “Unavailable” is a known-no-change shutdown/takeover result, never the routine
construction path and never an unbounded `Deferred` wait.

The gateway owns no state, queue, retries, or status.

### Public model tools

Expose the Amp-like high-level workflow through five public tools:

1. `find_thread` discovers candidate Threads (Plan 020).
2. `read_thread` extracts a grounded answer through the ReadThread specialist.
3. `create_thread` starts one independent background Thread.
4. `thread_interact` performs status, preview, queued message, steer, cancel, or stop on a
   known Thread.
5. `wait_for_threads` joins exact manual-result handles when blocking is necessary.

Keep lower `search_threads` and `read_thread_transcript` tools ReadThread-only. Do not add
separate public send/preview/status/steer/cancel tools: one discriminated interaction
contract reduces model tool-choice overhead while preserving distinct semantics.

#### Naming and Amp alignment

Public model-tool wire names follow Amp's built-in model-tool shape and Rika's existing
snake_case convention exactly: `find_thread`, `read_thread`, `create_thread`,
`thread_interact`, and `wait_for_threads`. `thread_interact` keeps the discriminated
`status`, `preview_messages`, `message`, `steer`, `cancel`, and `stop` actions. This aligns
with Amp's built-in tool behavior while avoiding six separate model tools; each action
maps to a typed service operation underneath.

TypeScript and Effect services use camelCase and mirror the corresponding Thread API
semantics: `createThread`, `appendMessage`, `messages`, `state`, `waitForResponse`,
`steer`, `cancel`, and `stop`. The model-tool mapping is `create_thread` →
`createThread`; `thread_interact.message` → `appendMessage`;
`thread_interact.preview_messages` → `messages`; `thread_interact.status` → `state`;
the three control actions map directly; and `wait_for_threads` → `waitForResponse` for
each exact handle under one aggregate deadline. Do not use Amp's `appendUserMessage`
name internally: submitted text is authored by another Agent, not a human or user, while
`appendMessage` preserves the same accepted/FIFO queue semantics.

Amp is a behavioral and naming reference only. Rika does not wrap, call, or depend on Amp.

#### `create_thread`

```ts
{
  prompt: string
  mode?: "low" | "medium" | "high" | "ultra"
  resultDelivery?: "reply" | "manual"
}
```

- Defaults to the invoking root Turn mode.
- Defaults `resultDelivery` to `reply` so the source continues without holding a tool open.
- Accepts no Workspace, source, parent, executor, profile, or arbitrary tool list.
- Creates an ordinary Thread whose root Turn uses the main Agent definition.
- Returns `{ accepted: true, threadId, turnId, resultDelivery }` after admission, not
  completion.
- `reply` records a durable source route and eventually queues exactly one bounded final
  result back to the source Thread. `manual` creates no automatic reply and permits wait.

#### `thread_interact`

```ts
type ThreadInteractInput =
  | { action: "status"; threadId: string }
  | { action: "preview_messages"; threadId: string; cursor?: string; limit?: number }
  | {
      action: "message"
      threadId: string
      message: string
      mode?: "low" | "medium" | "high" | "ultra"
      resultDelivery?: "reply" | "manual"
    }
  | { action: "steer"; threadId: string; message: string }
  | { action: "cancel"; threadId: string }
  | { action: "stop"; threadId: string }
```

Every action derives authority from the invoking root and requires exact stored Workspace
equality. No action accepts a Workspace, execution id, Turn id override, or permission
answer.

`status` returns:

```ts
{
  threadId: string
  state: "idle" | "queued" | "running" | "awaiting-approval" | "error"
  activeTurnId?: string
  queuedCount: number
  latestProjectionReadyTurnId?: string
}
```

`preview_messages` defaults newest 10 and caps at 20, matching Amp's useful bounded
default. It reads only persisted projection-ready human/agent/assistant messages, supports
opaque backward pagination, excludes reasoning/raw tool output/diffs/child activity, and
reports omissions. It never uses a live model or internal ReadThread handler.

`message` is ordinary multi-Turn communication:

- it defaults route from the target's latest Turn inside the admission transaction;
- it defaults `resultDelivery` to `reply`;
- idle target work is accepted; busy target work enters the existing FIFO queue;
- it returns `{ accepted, threadId, turnId, state, resultDelivery }` and never waits;
- it is not steering and never interrupts active work.

A durable `message` is always a Rika Pending Turn when the target is busy. It never uses
Baton `Steering.steer`, `Steering.followUp`, or the process-local transport SessionRegistry
queue. Baton steer drains at the next safe point and follow-up drains only when a run would
finish; neither is a durable Rika queue entry.

`steer` targets only the exact active root Turn bound in its durable invocation receipt.
It asks Baton to incorporate the text at Relay's next safe steering point and returns the
Relay steering receipt. Idle, queued-only, terminal, or approval-blocked targets return a
typed no-active-steer failure; callers use `message` for a future Turn.

`cancel` and `stop` are explicit, different actions:

- `cancel`: bind the exact active root Turn and call `ExecutionBackend.cancel` once;
  retain all queued target Turns.
- `stop`: atomically bind the active root and mark the exact current queued Turn set
  cancelled, then call `ExecutionBackend.cancel` once for the bound root. It does not delete, archive, or
  permanently pause the Thread; messages admitted afterward are new work.

Relay root cancellation already cancels open fan-outs, Child Run edges/executions, waits,
and tool work recursively. Rika must not walk descendants. Stop is a Rika product
operation; Relay has no separate stop operation.

Both actions return the bound active Turn, cancelled queue ids/count, and observed final
status. An idle target is a receipt-backed stable no-op. Source cancellation never
propagates to other Threads, and target cancellation never touches source work.

#### Steering requires a released retry-safe Relay contract

Relay 0.7.10 `SteerInput` has no caller idempotency key. `SteerAccepted` returns a sequence
and message id, while `steering.delivered` proves later consumption at a Baton safe point;
neither lets Rika inspect or dedupe a lost acceptance response. A local receipt can bind
the correct target but cannot close the crash window after Relay accepts text and before
Rika stores the response. Blind retry is forbidden because the outcome is unknown.

Therefore steering cannot ship on Relay 0.7.10. It requires a released public contract
with a caller idempotency key plus lookup/dedupe, or another released exactly-once-safe
mechanism that resolves unknown acceptance. `steering.delivered` alone is insufficient.

Do not edit vendored/upstream Relay code, emulate steering with another Turn, or ship an
at-least-once duplicate-text window. This is an implementation prerequisite, not a reason
to remove steering from the promised interface.

#### `wait_for_threads`

```ts
{
  targets: ReadonlyArray<{ threadId: string; turnId: string }>
  timeoutSeconds?: number
}
```

- Requires 1–10 exact same-Workspace handles.
- Defaults 300 seconds; accepts 1–600.
- Accepts only handles admitted with `resultDelivery: manual`; reply and wait are mutually
  exclusive result channels.
- Computes one absolute deadline from `ToolInvocation.createdAt`, then uses
  check-subscribe-recheck to avoid lost wakeups. Restart never resets the timeout.
- Returns `completed`, `failed`, `cancelled`, `waiting`, or `timed-out` per target plus a
  bounded final assistant result and ReadThread selector when terminal.
- Actionable waiting includes only bounded metadata needed to open the target.
- Terminal means the target status and projection-ready checkpoint agree at the same Relay
  cursor and required nested backfill is complete or explicitly unavailable.
- Timeout never cancels. Waiting on the invoking root Turn is rejected.

Bound the complete schema-encoded wait result, not each target independently. Reuse Plan
020's output-budget machinery with 36,000 encoded characters under the 40,000-character
tool policy. Reserve envelope, status, and selector space for every input first, then share
remaining text budget deterministically in input order. Truncate text only at Unicode
boundaries and report `item_text_truncated`; every target always retains status and a
working ReadThread selector.

Keep `read_thread`, but change its public input to:

```ts
{ question: string; threadId?: string }
```

Runtime still supplies current identity. Existing prompt-only durable calls receive the
one-release public compatibility translation owned by this plan; Plan 020 separately
translates legacy internal transcript-read inputs.

### Exactly-once result delivery to the source Thread

`resultDelivery: reply` is the default asynchronous coordination path:

1. Create/message admission stores source route plus a pending delivery record.
2. The target runs independently; source completion/cancellation or tool-fiber closure has
   no effect on it.
3. `RootTurnOwner` reaches terminal state, persists root/nested transcript projection, and
   writes the projection-ready checkpoint.
4. `deliverResult` atomically inserts one source Turn and marks delivery `delivered`.
5. If the source is idle, the new Turn is accepted and scheduled. If busy, it enters the
   ordinary FIFO queue. If its queue is full, delivery stays pending and retries when queue
   capacity changes or recovery scans it.
6. Rika queues exactly one agent-authored result Turn on the source Thread with a trusted
   product envelope containing target Thread/Turn id, terminal status, and bounded final
   assistant text projected from Baton `AgentEvent.Completed.text`/`Agent.Result.text`.
   `RootTurnOwner` wakes it and starts a fresh or resumed root Agent run for that Turn; no
   live Agent identity is called or persisted. The run decides whether to preview/read,
   steer, message, wait, cancel, or do nothing.

The reply body is deterministic and context-bounded: at most 12,000 Unicode-safe
characters of the final assistant message, terminal error/cancel state when no final text
exists, and a `read_thread` selector for full evidence. It excludes reasoning, raw tools,
diffs, and command output. No model summarizes the reply.

The delivered source Turn is authored by the target Thread and has no automatic reply
route, preventing loops. Delivery is an ordinary Turn—not an old tool-result mutation,
ephemeral event, hidden system message, or transcript splice—so TUI paging/selection and
resident restart cannot place it above an unrelated human message.

`wait_for_threads` waits until every requested target is terminal or in an actionable
approval/error state, or until the shared absolute deadline. It returns one bounded record
per input in input order. A timed-out target can be waited on again only through a new tool
invocation with a new explicit timeout; the original invocation's retry never extends its
deadline.

### Permissions and recursion limits

- Add product permissions `thread.read`, `thread.coordinate`, and `thread.control`.
  Find/read/preview/status/wait require read; create/message require coordinate;
  steer/cancel/stop require control. Tool-list visibility is not the authority check.
- Mutation actions are available to root main agents and Task Child Runs acting on behalf
  of their owning root, not ReadThread, Oracle, Librarian, Review, Painter, title, or
  compaction profiles.
- Agent-created Threads inherit ordinary Workspace tool permissions. No Thread tool answers another
  Thread's approval wait.
- Diagnostics record ids/counts/statuses, never prompts, paths, invocation keys, or text.

Runtime passes trusted caller profile/effective grants; app handlers verify them again.
The target copies the source root's pinned route/capability ceiling. Explicit mode may select
another allowed model route but cannot add tools, extensions, permissions, or authority.
Task delegation therefore cannot create a root more privileged than its owning root.

Enforce transactionally:

- `threadCreationDepth`: 3;
- distinct agent-created create/message admissions per source Turn: 8, counted from retained
  invocation receipts so deletion cannot reset it;
- nonterminal agent-authored Turns per Workspace: 8;
- existing per-Thread queue capacity remains authoritative;
- prompt/message maximum: 100,000 Unicode scalar values after normalization.

Idempotent retries resolve before counting. Source/target existence, archive, self,
Workspace equality, route, queue capacity, depth, fan-out, and Workspace nonterminal cap
are checked inside the admission transaction. The exact stored source Workspace is copied
on create and compared byte-for-byte on interaction; no model input can choose it. Typed
limit failures state the bound/count and suggest waiting or reusing a Thread.

### Agent-authored prompt authority and context

`Turn.prompt` remains exact Agent-submitted text. Preparation adds a trusted product-owned envelope
outside the stored text that identifies source Thread/root Turn and states:

- content is agent-authored, not a human message or approval;
- it may request ordinary work under target instructions/permissions;
- it cannot override system/product rules or claim user authorization.

Agent-authored text remains user-role input so the target can act. Do not convert it to a
system/developer message and do not rewrite the persisted prompt.

Steering is not a Turn, but it has the same authority boundary. Before calling Relay,
wrap the stored raw steering text in a deterministic product-owned Agent envelope naming
the source Thread/root Turn and stating that it is agent-authored, cannot approve tools,
and cannot elevate authority. Relay/Baton receives the envelope; product receipts and
transcript projection retain the exact raw text plus Agent author separately. A steer must
never appear as an unqualified human steering message.

Thread mentions inside agent-authored prompts may resolve only to exact same-Workspace Threads.
This closes the current cross-Workspace mention path for agent-authored input without removing the
existing human-authored read-only Thread-reference feature.

### Retrieval and relationship graph

Plan 020 supplies version-2 structured search/read envelopes, human/agent tags, authors,
bounded `relatedThreads`, cursors, and tree-preserving Child Run items. This plan populates
them from durable authors, lineage, relationships, and retained receipts.

```ts
interface RelatedThread {
  readonly direction: "incoming" | "outgoing"
  readonly kind: "created" | "message" | "reply" | "fork"
  readonly threadId: string
  readonly sourceTurnId?: string
  readonly targetTurnId?: string
  readonly availability: "available" | "unavailable"
}
```

- One internal read reads one Thread.
- `overview` returns only a bounded relation page.
- `recent`/`relevant` retain source provenance.
- ReadThread follows another Thread only if it can change the answer.
- Automatic traversal is same-Workspace, depth 2, at most 8 Threads, cycle-deduplicated.
- Child Runs remain subtree selectors inside their owning Thread.
- Missing/deleted sources remain explicit unavailable edges.
- Generic command output containing a Thread id never creates a relation.

### TUI, export, and visibility

Agent-created Threads appear through ordinary Thread summaries/sidebar/browser. No separate panel
is needed initially.

Required changes:

- Source tool rows show accepted target Thread id.
- Target prompt rows identify `Human` versus `Thread <short-id>` authorship.
- Selecting an agent-created Thread behaves like any Thread.
- Approval waiting is visible through normal status/transcript.
- JSON/Markdown export include safe Thread/Turn author and lineage.
- New forks record Fork/ForkCopy independently of author; old stored forks remain Human
  plus Original unless provenance can be
  proven without guessing.

Creation never switches focus or inserts the target prompt into the source transcript.
Only a completed reply route may append to the source, and it appears at its true queue
position as `Thread <short-id>`, never as a human message.

## Expected change map

- `packages/tools/src/thread-tools.ts` and tool policy/registry files: public schemas,
  discriminated interaction actions, permissions, `ToolInvocation`, legacy adapters, and
  output budgets.
- `packages/persistence/src/product-database.ts`, Thread/Turn schemas/repositories, and a
  new `thread-interaction-repository.ts`: migration 18, authorship/lineage, receipts,
  relationships, readiness, atomic admission/control/delivery, and memory/SQL parity.
- `packages/transcript/src/schema.ts` and projection code: author/lineage plus deterministic
  agent-reply/control projection; no second transcript tree.
- `packages/app/src/operation.ts`, new focused `root-turn-owner.ts`, `thread-tool-service.ts`, and
  `thread-tool-gateway.ts` modules,
  ThreadQuery, and tool handlers: one root lifecycle, state/preview/wait, delivery, and
  same-Workspace authority.
- `packages/runtime/src/execution-backend.ts`, execution contract, profiles, and prompts:
  Relay invocation context, transport-neutral `resolveInvocationSource`, authoritative
  execution checkpoints, retry-safe steering key, profile permissions, tool wiring, and
  ReadThread guidance. Runtime must not import `@rika/app`.
- `apps/rika/src/main.ts`: construct the gateway, compose app handlers into the runtime
  toolkit, enforce the startup barrier, and register the product owner before recovery.
- `packages/tui` and `apps/rika/test/tui-app.ts`: author labels, accepted targets, queue and
  control state, reply placement, and user-visible acceptance proof.

Create only the focused modules that remain coherent after extraction; do not turn this
map into catch-all helper files or a second application layer.

## Implementation slices

### 1. Freeze vocabulary, contracts, limits, and failure corpus

**Result:** Tests describe the end state before mutation paths change.

**Changes:**

1. Update `CONTEXT.md` and `docs/features/threads-and-turns.md` for admitted instructions
   and agent-authored regular Threads.
2. Add Effect Schemas for author, lineage, invocation/delivery receipt, accepted handle,
   state, interaction actions, result channel, typed failures, and tool contracts.
3. Add `ToolInvocation` context without changing ordinary handlers. Include only the
   derivable execution/call/tool/event-sequence/created-time/idempotency-digest fields;
   add transport-neutral runtime `resolveInvocationSource` so app code never parses Relay
   identities, then load route/capability authority from the source Rika Turn.
4. Add `thread.read`, `thread.coordinate`, and `thread.control` policy tests and prove a
   Task Child Run acts only with its owning root's pinned capability ceiling.
5. Add a real released-Relay fixture that crashes after tool-handler effect but before
   result acknowledgement and proves invocation key/execution/call/createdAt stability.
6. Prove root start retries preserve byte-equivalent pinned Agent definition/revision and
   immutable start input, not only execution id and idempotency key.
7. Prove `ExecutionBackend` returns the exact root cursor/sequence checkpoint for new-event
   and zero-new-event terminal/actionable-wait follows; prove cursor-loss replay cannot
   duplicate projection or delivery.
8. Prove repeated cancellation against one exact root is monotonic, completion can win,
   a terminal cancel is a no-op, Relay owns descendant settlement, and pre-start cancel
   creates local readiness without creating a Relay Execution.
9. Prove Relay's projected final output corresponds exactly to Baton `Completed.text` for
   ordinary, empty, tool-then-answer, failed, cancelled, and restart-replayed runs; never
   choose an arbitrary assistant delta.
10. Record steering as blocked on Relay 0.7.10. Upgrade only to a released contract with a
    caller idempotency key plus lookup/dedupe, or another exactly-once-safe mechanism; prove
    lost acceptance before enabling the action. Public registration is blocked, but
    persistence and root-owner work may proceed without exposing steer.
11. Update Plan 020 fixtures for human/agent author, Original/ForkCopy lineage,
    create/reply edges, deleted sources, and malformed post-migration author.
12. Add fixtures for duplicate/conflicting invocation, result delivery, queue-full source,
    limits, Workspaces, archive, self-message, waiting approval, deleted source, cycles,
    and nested Child Run versus related agent-created Thread.

**Tests:** schemas round-trip; schema-17 migration fixtures become Human+Original; missing
post-migration author fails; profile/permission exposure is exact; agent-authored prompts cannot
render/export as human; Relay identity/control assumptions are proven against the installed
version.

**Checks:**

```sh
bun --bun vitest run packages/tools/test/tool-contract.test.ts packages/runtime/test/agent-profiles.test.ts packages/transcript/test
bun --cwd packages/tools run typecheck
```

**Depends on:** Plan 020 contract decisions.

**Cleanup:** Every create/interact presentation name has a real registered contract; remove
obsolete send/preview/cancel fallback aliases.

### 2. Add migration 18, receipts, and atomic Thread admission/control binding

**Result:** Persistence admits one agent-created Thread/Turn or message exactly once without
starting Relay work.

**Changes:**

1. Add migration 18 after Plan 020 migration 17 with author/lineage fields,
   non-cascading relationship rows, retained invocation receipts, delivery receipts, and
   projection-ready checkpoint fields.
2. Add unique invocation, source/target, limit, pending-delivery, and related-page indexes.
3. Backfill all old records Human+Original, rebuild Plan 020 FTS triggers/documents from
   authoritative author, and fail integrity if an agent-authored prompt is indexed human.
4. Implement memory/SQLite `ThreadInteractionRepository` for create/message admission,
   steer/cancel/stop binding, and result delivery with input-digest conflicts.
5. Persist author and Fork/ForkCopy lineage independently for new forks.
6. Reject hard deletion with nonterminal work; retain receipts after endpoint deletion;
   keep unavailable relation evidence without cascading target deletion.
7. Resolve default route/capability pins inside the transaction and reuse stored values on
   retries.

**Tests:** schema-17 migration/reopen; concurrent duplicate returns one handle; changed
input conflicts; delete-then-retry returns original handle; limit races admit exactly the
bound; Workspace/archive/self/route checks are atomic; Agent+ForkCopy retains authorship;
source deletion preserves target/unavailable edge; controls bind one exact active Turn;
negative controls remain no-ops after later work starts; manual routes never scan; ready
reply delivery is stable-ordered and inserts once; memory/SQL parity.

**Checks:**

```sh
bun --bun vitest run packages/persistence/test/product-database.test.ts packages/persistence/test/thread-interaction-repository.test.ts packages/persistence/test/turn-repository.test.ts
bun --cwd packages/persistence run typecheck
```

**Depends on:** Slice 1 and Plan 020 migration 17.

**Cleanup:** Do not add a command inbox, second scheduler, or second relation authority.

### 3. Extract the resident-owned root Turn lifecycle

**Result:** Accepted roots run/recover independently of TUI, through one owner.

**Changes:**

1. Extract `RootTurnOwner` with product-scope supervision and make it the only root
   execution/queue-promotion authority.
2. Move prepare/start/follow/project/settle/reconcile and queue promotion behind it with
   guarded accepted→running and queue-claim transitions.
3. Make TUI dispatch optional while preserving selection epochs/stale rejection.
4. Migrate Interactive first, then Run and Thread Host promotion with parity proof.
5. Add projection-ready checkpoint repair and pending result-delivery scan after root/nested
   projection settlement.
6. Register owner/gateway before recovery starts tool-capable executions and retain them
   for the resident lifetime.
7. Add single-generation, token-protected, in-flight-leased `ThreadToolGateway`; drain
   calls before owner shutdown.

**Tests:** current interactive/Run/queue/cancel/approval/recovery behavior remains; detached
accepted Turn starts without TUI; cancellation during prepare prevents start; source
session close does not interrupt target; crashes before start/during follow/after terminal
and before/after delivery converge; queue-full delivery later drains; gateway
startup/takeover/shutdown never hangs or exposes a closed owner. Every queue-capacity
release path and startup scan wakes ready result delivery without depending on queue wake
rows.

**Checks:**

```sh
bun --bun vitest run packages/app/test/interactive-session.test.ts packages/app/test/operation.test.ts packages/runtime/test/recovery.proc.test.ts
bun --cwd packages/app run typecheck
```

**Depends on:** Slice 2.

**Cleanup:** Delete copied lifecycle branches only after each migrated caller passes parity.

### 4. Make Agent authority visible, then expose interaction and automatic replies

**Result:** Root and Task Agents coordinate ordinary Threads through typed tools.

**Changes:**

1. Provide Relay invocation identity around handler execution.
2. Add app handlers through the existing additional-toolkit composition seam.
3. Carry Turn author/lineage through context preparation and transcript projection; add
   trusted envelopes for agent-authored Turns/steering and same-Workspace mention confinement.
4. Add author-aware preview and TUI prompt labels before any agent-authored input can execute.
5. Admit create/message and schedule accepted work through `RootTurnOwner`.
6. Implement status/preview from authorization-aware repositories and Plan 020 projection
   budgeting, not the internal ReadThread handler.
7. Implement wait as absolute-deadline check-subscribe-recheck over projection-ready state
   with repository fallback after restart.
8. Implement receipt-bound same-Workspace steer only after the released retry-safe Relay
   prerequisite passes; otherwise keep the public tool set unregistered.
9. Implement receipt-bound active cancel and whole-Thread stop; each calls root cancel once,
   while stop first atomically cancels the bound queue set. Relay owns descendants.
10. Deliver bounded final replies to source through ordinary admission and owner wake.
11. Expose public `find_thread` from Plan 020 and register `create_thread`, discriminated
    `thread_interact`, and `wait_for_threads` only after steps 3–10 pass together.
12. Add content-free logs for operation/replay/status/rejection/limits/waits/control and
    delivery state/count.
13. Teach root Agents: background Threads default to reply delivery; use manual+wait only
    when blocking is required; queue and steer are distinct; timeout never cancels; one
    result channel per accepted Turn.

**Tests:** Relay retry after commit returns one handle; parallel creates stop at limit;
message idle starts and busy queues FIFO; preview is recent/bounded/paginated; wait rejects
reply channel and returns projection-ready terminal/waiting/absolute-timeout without
cancel; ten-target output remains globally bounded with all statuses/selectors; steer retry
appends once to the bound Turn and renders Agent authority; a lost no-active result never
controls later work; active cancel retains queue; stop cancels the bound queue set;
automatic result queues/starts once with source capability ceiling and wakes source;
source cancellation does not affect target; approval remains user-owned.

**Checks:**

```sh
bun --bun vitest run packages/runtime/test/execution-backend-relay.test.ts packages/runtime/test/standard-tool-transcripts.test.ts packages/app/test/thread-tool-service.test.ts packages/app/test/thread-tool-gateway.test.ts
bun --cwd packages/runtime run typecheck
bun --cwd packages/app run typecheck
```

**Depends on:** Slice 3.

**Cleanup:** Remove test-only handler bypasses; tools call only gateway/service contracts.

### 5. Complete related-Thread retrieval, export, and TUI polish

**Result:** Humans/agents understand authorship and retrieve only needed related evidence.

**Changes:**

1. Populate Plan 020 create/message/reply/fork relation pages, agent search source, and
   source snippets.
2. Change public `read_thread` input with its own one-release `{ prompt }` compatibility
   adapter/snapshot fixture, then teach bounded relationship traversal/citation.
3. Complete relation indicators in TUI, safe exports, presentation, and feature documents.
4. Prove expansion/selection cannot insert agent-authored prompts above unrelated human messages or
   into the wrong selected Thread.

**Tests:** authorship survives live/replay/paging/preview/selection; ReadThread finds one
nested grandchild Child Run and one related agent-created Thread while following only required selectors; cycles terminate;
agent-authored cross-Workspace mentions are omitted with diagnostics; export round-trips safe
author/lineage but omits receipt internals; automatic reply appears at its real queue
position and never above the human message that created its source work.

**Checks:**

```sh
bun --bun vitest run packages/app/test/thread-query.test.ts packages/runtime/test/subagent-spawn.test.ts packages/tui/test/view-state.test.ts apps/rika/test/app.tui.test.ts
bun run test-tui
```

**Depends on:** Slice 4 and the Plan 020 ReadThread baseline. Plan 020 itself may have
shipped with empty related pages.

**Cleanup:** Remove legacy prompt-only `read_thread` after its one-release compatibility
window and schema-digest rehearsal.

### 6. Rehearse restart, concurrency, migration, and installed behavior

**Result:** The capability is proven through real resident and Relay boundaries.

**Changes/tests:**

1. Add `*.proc.test.ts` fixtures for crash before admission response, after commit before
   Relay start, after Relay steer acceptance, during running/waiting/terminal projection,
   before/after projection-ready, before/after source reply insertion, queue-full reply,
   queued message during source cancellation, duplicate Relay retry, source/target
   deletion, and resident takeover during wait/control/delivery.
2. Force same-Workspace concurrent file edits and prove limits, visible conflicts, and no
   product-state corruption. Do not claim conflict-free Git semantics.
3. Resume pre-change executions whose snapshots lack new tools and legacy public
   `read_thread { prompt }` calls; retain pinned capabilities and apply only the bounded
   one-release adapter without schema poisoning.
4. Migrate a real schema-17 database, rebuild FTS/transcript/readiness projections, prove
   no agent-authored document is classified human, run integrity checks, package,
   install, and perform TUI acceptance.

**Final checks:**

```sh
bun run test
bun run check
bun run test-proc
bun run test-tui
bun run package -- --target <local-target>
bun run release-smoke
```

Installed acceptance:

1. Start a human Thread and create two reply-delivery background Threads plus one manual background Thread in parallel.
2. Confirm all appear without switching the active Thread.
3. Send a normal message to one busy target and verify FIFO queueing; steer another and
   verify incorporation at the next safe Relay point, not as a new Turn.
4. Let the manual target await approval; wait returns `waiting`, and TUI resolves normally.
5. Let one reply-delivery Thread complete while the source remains active; verify exactly one bounded
   agent-authored source Turn is queued, then `RootTurnOwner` wakes it and a new root Agent run decides next.
6. Cancel one active target and retain its queue; stop another and cancel its bound queued
   set plus Relay Child Runs. Both Threads remain selectable.
7. Restart during control and result delivery; verify no duplicate Thread, Turn, steering
   message, reply, or visible response.
8. Ask ReadThread for one nested Child Run fact and one related Thread fact; verify bounded selectors
   and cited ids.
9. Find a Thread by successful touched file path, then read it and verify newer revisions
   and terminal tool outcomes beat earlier attempts.
10. Delete the source; targets remain selectable with unavailable-source provenance and
    retrying old mutation receipts never recreates work.

## Rollout and recovery

Ship one local executable and database without a dual execution owner:

1. Plan 020 migration 17, public find, internal search/read, and structured retrieval are
   present first; related pages may be empty.
2. Relay retry/control assumptions are proven; steering uses a released deduplicating
   contract before exposure.
3. Migration 18 adds author/lineage, relationships, receipts, delivery, readiness, and FTS
   trigger rebuild transactionally.
4. RootTurnOwner preserves existing behavior and gateway lifecycle before Agent-callable Thread tools
   become available.
5. Agent author projection/envelopes, basic TUI labels, contracts, handlers, result routing,
   and profile permissions pass together before public registration.
6. Relation-aware ReadThread, relation UI polish, and safe export then consume the same
   records.
7. Existing execution snapshots remain pinned and do not gain new tools on replay.

Rollback to a binary that rejects schema 18 is unsupported. Recovery is forward while
preserving Threads, Turns, authorship, lineage, receipts, delivery state, and Relay
executions.

If a tool result is lost, Relay retries with the same invocation key and receives the
committed handle/bound control. If an accepted Turn was not started, reconciliation
starts/follows by stored Turn id. If Relay completed before local projection, replay
repairs the readiness checkpoint. If projection completed before reply admission, the
pending delivery scan inserts the source Turn once. None creates another execution
authority.

## STOP conditions

Stop and report instead of adding a fallback if:

1. Actual Relay retry/restart does not provide a stable idempotency key.
2. Atomic admission/receipt/delivery cannot preserve SQL/memory parity, survive endpoint
   deletion, or reject changed-input reuse.
3. Root owner extraction changes interactive queue, cancellation, approval, recovery,
   transcript, title, usage, or selection behavior.
4. Detached work requires an attached TUI or source tool fiber.
5. An agent-created Thread uses Child Run identity, projection ownership, or cancellation.
6. A Workspace/archive/self/depth/fan-out/concurrency race can commit invalid work.
7. An agent-authored prompt appears human-authored, becomes system authority, resolves permission,
   or imports a cross-Workspace Thread mention.
8. ReadThread recursively dumps relations, loses Child Run provenance, exceeds policy, or
   omits evidence without continuation/unavailable reason.
9. Wait can return before projection-ready, reset its deadline, block forever, cancel on
   timeout, miss check/subscription transitions, or deadlock shutdown.
10. Cancel/stop is not monotonic/idempotent in the released Relay contract, re-resolves and
    controls a newly promoted Turn, loses its bound queue set, or propagates from source.
11. Steering is exposed before retry-safe deduplication is proven or a retry can append
    duplicate steering text.
12. A terminal reply is lost, duplicated, recursively replied to, inserted out of order,
    delivered with target/mutable authority, scanned from a manual route, or delivered
    through both reply and wait channels.
13. Gateway takeover permits two root owners, drops an in-flight admission, retains a
    closed service, or exposes tools before product readiness.
14. Restart can duplicate Threads, Turns, roots, controls, deliveries, or visible responses.
15. Public Agent-callable Thread tools can execute before author-aware projection/envelopes, same-Workspace
    mention confinement, author-aware preview/TUI labels, and agent FTS classification are active.
16. A ten-target wait can exceed its aggregate policy budget or omit any target's
    status/selector.
17. Migration, packaged recovery, TUI acceptance, or release smoke fails.

## Explicit non-goals

- Amp interoperability or protocol compatibility.
- Remote agents, runners, orbs, hosted collaboration, multiplayer, Slack, web, or IDE
  clients.
- Shared mutable Agent memory outside Workspace files and durable messages.
- Automatic merge conflict resolution across concurrent agents.
- Unlimited recursive spawning.
- Treating model messages as human consent.
- Replacing Task/Oracle/Librarian/Review/ReadThread when a bounded Child Run result remains
  the right interface.
