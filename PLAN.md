# PLAN: A persistent TypeScript RLM with Baton-native child control

## Goal

Give every conversational Rika Agent a persistent **Bun/TypeScript/Effect cell** for its RLM environment, plus Baton's blocking singleton and grouped child tools for restart-safe recursive control.

The model works the way Prime Agent's model works: it writes code into a long-lived environment where everything it previously wrote is still there. Variables, functions, imports, parsed data, and analysis persist across cells, Rika Turns, and compaction. Session history, resolved context, and the continual harness are reachable as data from inside that environment, so the model can inspect, search, and partition context that no longer fits its token window. Delegation remains outside the JavaScript continuation: Baton suspends the parent Run on `run_child` or `run_child_group` and resumes that same Run durably after settlement.

```text
Rika TUI / CLI
    │ Threads, Turns, projections, presentation (unchanged)
    ▼
Baton Runtime
    │ durable Runs, model turns, children, events, cancellation, compaction
    ├── run_child / run_child_group (durable suspension and resumption)
    ▼
typescript { code } (persistent RLM environment)
    │ persistent Bun worker per Baton Session, replMode transform + vm context
    ├── ordinary TypeScript with top-level await, imports, Bun.$ project commands
    ├── rika.* typed host modules (Effect-backed, host-authoritative)
    ├── context / history / harness variables (context as data)
    └── artifacts
```

The language changes from Prime's Python to TypeScript. The architecture that makes Prime work remains: a persistent programmatic environment, a host-owned control plane, real isolated child agents, progressive skills, and honest recovery semantics. Child suspension is the deliberate native control boundary because a JavaScript promise cannot be reconstructed after process death.

## Why TypeScript instead of IPython

An earlier revision of this plan chose a Jupyter/IPython kernel. The Bun kernel replaces it because:

- Rika already ships Bun; no managed Python distribution, `ipykernel` bootstrap, ZeroMQ native dependency, or Python/npm release-skew problem.
- The kernel and host share one language, one package ecosystem, and the same Effect Schemas; host capabilities are ordinary typed modules instead of generated Python wrappers over a comm protocol.
- Effect interruption, scopes, resources, and errors are native inside cells.
- The model writes the same language it is editing in most Rika workspaces.
- The transparent-persistence mechanism exists natively: Bun's REPL transform (`Bun.Transpiler({ loader: "tsx", replMode: true })`) hoists `const`/`let`/`function`/`class` declarations to `var` assignments on the evaluation context and wraps top-level `await` in an async IIFE returning `{ value }`. Bun vendors and tests this exact contract for `bun repl` (`oven-sh/bun` `src/ast/repl_transforms.zig`, `test/js/bun/transpiler/repl-transform.test.ts`).

What is lost versus IPython and accepted (each mitigated below; see "Closing the gaps"):

- Weaker in-place interruption than `KeyboardInterrupt` — but Bun implements Node's `vm` watchdog: `timeout` and `breakOnSigint` terminate a synchronous busy loop inside the script while the context, its variables, and the worker all survive (proven in this session: loop killed at 300ms / by SIGINT, `x` intact, next cell ran). Worker kill remains only the last resort for native-code hangs.
- No Jupyter ecosystem (rich MIME renderers, kernel protocol maturity). Rika owns its own small JSONL protocol and vendor display events instead.
- Python's data-science library advantage. Out of scope for a coding agent whose workspaces are code.

## Closing the weak spots (researched and proven)

The three weaknesses versus Prime identified in review — interruption, snapshot fidelity, and TS-REPL model ergonomics — each have a concrete mitigation, two of them already executed in this session.

### 1. Interruption: Bun's vm watchdog recovers the kernel in place

Research finding: Bun implements Node's `node:vm` watchdog semantics on JSC (`oven-sh/bun` `NodeVMScript.cpp` `setupWatchdog`/`checkForTermination`; PRs #32773, #35985 refined the deadline and termination-attribution logic; Node docs specify `timeout` and `breakOnSigint` create a watchdog thread that terminates the script, not the process).

Executed proof (Bun 1.3.14):

- `vm.runInContext("while (true) { x++ }", ctx, { timeout: 300 })` → `ERR_SCRIPT_EXECUTION_TIMEOUT`; the context survived (`x` intact), and the next cell ran normally.
- The same loop with `{ breakOnSigint: true }` + SIGINT → `ERR_SCRIPT_EXECUTION_INTERRUPTED`; state intact, next cell ran.

Design consequence: every cell runs under a configurable watchdog deadline, and user cancellation escalates: AbortSignal (async/Effect work) → watchdog termination via SIGINT-equivalent (synchronous loops, state preserved) → worker kill + epoch + restore (native hangs only). Known caveats are encoded as tests: microtask-scheduled loops that escape the eval-scoped watchdog (nodejs/node#3020 class) are caught by draining microtasks inside the watchdog scope (Bun does this) plus a host-side stall detector; `Bun.spawnSync` and native addon calls are un-interruptible by any JS watchdog and remain the worker-kill case. This closes most of the SIGINT gap: like IPython, a stuck pure-JS cell is terminated in place with the namespace intact.

### 2. Snapshot fidelity: v8-serialize for data + source re-evaluation for functions

Research finding: no JS runtime can structured-clone closures, and the general tools (nokia/ts-serialize-closures) require a compile-time transform unsuited to model-authored cells. But REPL-transformed cells have a special property: every persistent function/class is a _context-global binding_ whose free variables are themselves context globals — closures over cell-local state do not survive the hoist anyway. So `fn.toString()` re-evaluation in the restored context is semantically faithful for exactly the class of functions the REPL creates.

Executed proof: session 1 defined `const base = 10` and `function addBase(n) { return n + base }`; snapshot captured `base` via `v8.serialize` and `addBase` via source text; a fresh context restored data first, re-evaluated function sources second, and `addBase(32)` returned 42.

Design consequence: the snapshot has three tiers — (a) v8-serializable values, (b) function/class bindings restored by source re-evaluation after data restore (recorded per-binding in the manifest as `restored-by-source`), (c) live handles (sockets, subprocesses, module namespaces) dropped with explicit names. Module imports are restored by replaying recorded import statements (idempotent, cached by the loader). This brings restore fidelity close to dill — which also cannot revive live handles — while staying honest: source-restored functions that captured non-global locals are re-bound to current globals, and the manifest says so.

### 3. Model ergonomics: Promise-first surface, Effect underneath

Research finding: cross-language benchmarks (MultiPL-E; Multi-LCB, arXiv 2606.20517) show frontier models are strong in TypeScript but Python-tuned; more importantly, models are far more fluent in _plain async TypeScript_ than in Effect's generator DSL. Meanwhile the Effect ecosystem provides the right host machinery: `ManagedRuntime` for a long-lived runtime at a non-Effect boundary, `@effect/platform` Worker/WorkerRunner with Bun implementations for typed, Schema-serialized, interruptible worker transport.

Design consequence — "Effect TypeScript" lives in the right layer:

- **Cells are plain TypeScript with top-level await.** `rika.*` returns Promises. The model never has to write `Effect.gen`/`yield*` to act (low action-failure rate, matches training distribution).
- **Every `rika.*` Promise is a thin `runtime.runPromise(...)` over a real Effect** in the worker's `ManagedRuntime`: Schema-validated, interruptible (AbortSignal wired to fiber interruption), resource-scoped, retryable.
- **Effect is fully available when wanted:** `import { Effect, Schema, Stream } from "effect"` works in cells (proven in the tracer), and every `rika.*` module also exposes its Effect form (`rika.workspace.replaceEffect(...)` or `rika.effect(<Effect>)` running in the kernel runtime) so the model can compose typed pipelines, concurrency, and streams natively when the task benefits.
- The host side (worker transport, pool, host router, nested operations) is built on `@effect/platform` BunWorker/WorkerRunner rather than the hand-rolled stdio protocol of the tracer — Schema-tagged requests, structured interruption, and CloseLatch lifecycle come from the platform.

The Phase 5 eval compares plain-TS-surface vs Effect-surface prompting explicitly before fixing the default prompt guidance.

## Proven tracer (executed evidence)

A working prototype (worker + host, ~200 lines, Bun 1.3.14, run against the real Rika repo) proved every load-bearing mechanism before this plan was written:

| Mechanism                                                                      | Result                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `const workspaceFiles: string[] = await ...` in cell 1, used in cells 2, 4, 10 | persists transparently                                                                                                                                                                                                                                                        |
| `function summarize(...)` declared in cell 4, called in cell 10                | persists                                                                                                                                                                                                                                                                      |
| `const { Effect } = await import("effect"); Effect.runPromise(...)`            | works via `importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`                                                                                                                                                                                             |
| `require(...)` resolved against the workspace                                  | works via `createRequire(workspaceRoot)`                                                                                                                                                                                                                                      |
| `await rika.context.historyPage({ limit: 50 })` then filter in TS              | context as data works                                                                                                                                                                                                                                                         |
| `Bun.spawnSync(["bun", "--version"])`                                          | project-native commands work                                                                                                                                                                                                                                                  |
| `throw new Error("boom")` in cell 9                                            | typed cell failure; cell 10 still sees all prior state                                                                                                                                                                                                                        |
| Per-variable `v8.serialize` snapshot                                           | saved `workspaceFiles, child, page`; dropped `Effect (module), summarize (function), proc (subprocess)` with an explicit manifest — the same honest saved/dropped contract Prime implements with dill (`prime-agent packages/coding-agent/src/core/kernel/state-snapshot.ts`) |

## Research basis

Local revisions audited: Rika `ef8efeb8`, Baton `21924c98` (`0.19.2`), Prime Agent `87e7a7f1`.

What Prime Agent's ever-evolving environment actually is (all verified in source):

- One model tool, `ipython { code }`, sequential because one namespace is shared (`src/core/tools/ipython.ts:626-633`).
- The persistent namespace is process state in a lazily provisioned kernel owned per session (`IpythonKernelProvisioner`, `ipython.ts:329-545`); restart revives a prior namespace **before** re-running the runtime bootstrap so live handles are re-bound on top of restored data (`ipython.ts:508-525`), and the model is told exactly which names were restored or lost (`onRestore`, `KERNEL_RESTART_NOTICE` `ipython.ts:157-161`).
- Host capabilities are typed requests over a comm; replies use the control channel because the shell channel is serialized behind the executing cell (`docs/rlm-runtime.md`, kernel `index.ts:1189-1279`).
- The conversation log path is injected into the system prompt (`system-prompt.ts:53`) so the model can read its own transcript as data; harness state is loaded fresh into every system-prompt rebuild (`agent-session.ts:4288`, `7548-7554`).
- Continual harness = four entry kinds (prompt/memory/skill/subagent) + refinement events, JSON stores with local (session artifact) and global scopes, versioned entries with before/after snapshots and rollback proposals, applied only in a brief agent-disconnected critical section that then rebuilds the system prompt (`refinement.ts:30-102, 730-836`; `agent-session.ts:7767-7850`).
- Children are host-admitted sessions with a parent-scoped durable registry that survives kernel restart and compaction; admission handles never carry answers (`docs/rlm-runtime.md`, `agent-session-recursion.test.ts`).

External sources (unchanged from prior revision): Prime RLM docs, CodeAct (arXiv:2402.01030), RLM (arXiv:2512.24601, including the depth-0 ablation showing the programmable-REPL-over-context mechanism itself carries much of the value), Anthropic code-execution-with-MCP and multi-agent-research posts, OpenAI Structured Outputs, Jupyter security docs (kernel = arbitrary code execution; process boundary is not a sandbox).

Baton facts this plan builds on (verified): `ToolContext` carries session/Run/call/operation identity, interruption, and progress (`core/src/tools/tool-context.ts`); ordinary tool calls run under durable operations with `replayPolicy: "never"` and unknown outcomes on interruption; `SessionStore` owns the exact entry log, leaf, and compaction checkpoints with `buildContext` as the pure projector (`core/src/context/session.ts`); `Runtime` exposes start/send/spawn/events/history/tree/steer/cancel/resolveOperation (`runtime/src/runtime.ts:204-227`); `ChildRuns` today exposes blocking `invoke` plus non-blocking `startGroup`/`awaitGroup` keyed idempotently by parent+toolCall (`runtime/src/child-runs.ts`).

Rika facts this plan replaces (verified): role toolkits assemble 0–14 tools per profile and pin every schema into the executable (`baton-route.ts:263-346, 603-626`); Code Mode is a fresh-per-invocation QuickJS capability sandbox; Agent manifests currently pin `skills: []` (`baton-route.ts:294`), so execution-time skill wiring is new work; the transcript presentation model is a closed Block union (ToolCall/SubagentCard/AuthorizationCard/Diff/... in `transcript-presentation-model.ts`) that this plan extends with one Cell block.

## Concept and ownership map

### Baton keeps both execution styles (explicit commitment)

`@batonfx/repl` is purely additive, like `providers`, `mcp`, or `skills`. Nothing in Baton's existing surface is deprecated or removed by this migration:

- Ordinary typed `Tool.make` tools, Toolkits, `ToolExecutor` routes, approvals, and permissions remain first-class for every Baton application.
- Agent Programs, `ProgramHost`, capability sandboxes, and `code_mode` remain the right answer where exact replay and capability-only authority matter.
- Blocking `ChildRuns.invoke` and exact child groups remain the durable parent-continuation boundary.
- The loop already supports mixed toolkits, so one Agent may advertise the `typescript` cell tool **and** ordinary typed tools together; hosts choose per Agent definition. Nested durable operations, history paging, and the inbox are generic Runtime features usable by tool-based agents too.

Rika's narrow tool surface is a **Rika product decision**, gated by the Phase 5 eval — not a Baton framework direction. The `typescript` cell owns the programmatic environment; `run_child` and `run_child_group` are the only native control operations because Baton must own their durable continuation. Other Baton hosts keep the broader framework unchanged.

### Ownership test

One rule decides placement: **if any Baton host building an agent product would implement it the same way, it goes in Baton.** Rika keeps only what is genuinely product-specific: its capability surface, its policy, its presentation, its stores.

### Baton owns (framework, generic)

- The one Effect AI tool schema and its exclusive execution envelope; tool-call identity, progress bounds, interruption, deadline, unknown-outcome handling (existing).
- **`@batonfx/repl`** — one package, the complete generic kernel (following the `@batonfx/skills` pattern: one capability package, adapters inside, not a package per variant):
  - root export: cell protocol Schemas (`CellResult`/`CellFailure`/`CellEvent`), `KernelProfile`, snapshot-store port, host-binding registry, and the `Tool` construction — no process dependencies, so projection/decoding consumers and test hosts import contracts without worker code;
  - `@batonfx/repl/bun` subpath: the full Bun worker implementation — worker-per-Session pool with generation/lease, replMode transform + `vm` context evaluation, console capture and output bounds, the watchdog escalation ladder (AbortSignal → vm timeout/SIGINT → kill+epoch), the three-tier snapshot/restore engine (v8 values → function-source re-eval → manifest of drops) with restore-then-rebootstrap-then-notify ordering, recorded-import replay, and `@effect/platform` BunWorker transport. Every agent product on Bun needs exactly this; none of it is Rika-shaped. Rika supplies only configuration: data root, workspace cwd, bindings, limits.
  - There is deliberately **one kernel implementation**. Baton targets Bun (`engines` already requires it); a Python or Node kernel is not a goal, and the contract does not pre-abstract for hypothetical languages — if one is ever justified, it becomes a sibling adapter behind the same cell contract then.
  - The **host-binding seam** lives in the root export: a generic registry by which a host mounts named, Schema-typed modules into the kernel namespace (Rika mounts `rika.*`; another host mounts its own). The deadlock-free reply rule lives here, once.
- **Continual harness (generic engine)** — Prime proves this is host-independent agent infrastructure, and any Baton host wants it: entry kinds (prompt note/memory/skill/subagent spec), versioned entries with before/after snapshots, refinement events, rollback proposals, scope merging, bounded prompt-overview formatting, and content-addressed snapshot pinning into executable registrations. Rika supplies the stores' locations, its scope policy (Thread/Workspace/global), and the `/refine` product flow.
- Generic nested durable host operations under `ToolContext` (persisted certainty, digest checks, duplicate-return, approval suspension) — used by cell host-bindings and by ordinary tools alike.
- Root-pinned recursive tree policy, blocking singleton and atomic exact-group child admission, per-parent lifetime quota enforcement, and structured child correlation in tree events.
- Read-only Session history paging/search over exact entries and compaction checkpoints — the generic "context as data" surface any host binds into its kernel.
- **Addressable agent messaging (first-class, Baton-owned).** Baton already has the foundation — branded `Address`, a `Message` envelope with `to`/`from`/`inReplyTo`/`correlationId`/`idempotencyKey`, `Runtime.send`, `AddressBinding`, and a reserved `send` driver-operation kind — but the durable-driver docs state plainly that "addressed messaging is not wired". This migration wires it, because agent-to-agent communication is host-independent infrastructure every Baton product needs:
  - **Directory:** every Run (root and child) is addressable by a stable Address derived from authoritative identity, plus an optional host-assigned friendly name scoped to its parent. Sessions are addressable so messages can cross Rika Threads.
  - **Durable mailbox:** per-address inbox with idempotent admission (message id + idempotency key), host-derived sender identity that cell code cannot forge, ordering, and pending/size/rate bounds. Delivery is acknowledged **atomically by steering consumption at the turn boundary** — the steering row is marked consumed in the same commit that records the model operation, so there is no separate ack step and no crash window between "model saw it" and "host acked it". An explicit ack would add a second commit point and weaken the guarantee; steering consumption is the ack.
  - **Delivery:** to an active Run only at a safe boundary (the same turn-boundary rule steering already uses — never mid-turn), and pending delivery to the target's next Run when it is idle or terminal. Delivery survives Server restart.
  - **Durable send:** the reserved `send` driver operation becomes a real intercepted durable operation with exact certainty, so a send from inside an execution is never silently duplicated or lost.
  - **Authorization:** relationship-scoped by default (parent ↔ direct child, sibling ↔ sibling within a parent) with an explicit host policy seam for cross-session addressing; scope is enforced by Baton from authoritative identity, never from IDs supplied by model code.
  - **Discovery:** list reachable addresses for the current Run under that policy.

  Any future Rika messaging surface delegates mailbox, ordering, durability, and authorization to Baton rather than combining them with child admission.

- Skill-source remains Baton's existing seam (`SkillSource`, `@batonfx/skills`); executable TypeScript-backed skill packages extend that seam generically (import-name metadata, environment digest), with Rika owning only discovery locations and precedence.

### Rika owns (product)

- **`@rika/kernel`** (thin): composes `@batonfx/repl/bun` with Rika's data root, workspace, limits, trust mode, and mounted bindings; doctor/install UX.
- The `rika.*` binding surface and its Schema contracts — the product capability menu: workspace search/replace, processes, web, media, threads, context, harness, and goals. (The mounting mechanism is Baton's; the modules and their semantics are Rika's.)
- Kernel-profile registration content for Rika executables (Bun version, runtime digest, skills digest, workspace, trust mode).
- Harness store locations, Rika's scope policy, refine UX, and audit presentation.
- Skill discovery locations and precedence (global/Workspace), prompt metadata assembly.
- All projections and terminal presentation: the new Cell block, existing SubagentCard/Diff/Process/Image/Approval blocks, recovery cards.
- Workspace trust posture and prompts.

### Explicit non-ownership

- The kernel never owns provider calls, Baton Session history, the Run ledger, child truth, cancellation truth, credentials, or projection state. Kernel variables are working memory, not durable authority.
- The TUI never owns a kernel or child lifecycle.
- `@batonfx/core`/`runtime` never import Bun-specific process code; the `@batonfx/repl/bun` subpath is the only module with process dependencies, and the package is optional.
- Baton never owns Rika's capability semantics, trust policy, store locations, or presentation.

## The programming model (what the model sees)

One tool:

```ts
typescript({ code: string }) // ≤ 64 KiB source
```

The cell is ordinary TypeScript with REPL semantics: top-level `await`, `const`/`let`/`function`/`class` persist across cells, `import`/`require` resolve against the workspace, `Bun.$`/`Bun.spawn` run project commands in their native environments, and exceptions come back as observations, not run failures.

Bootstrapped persistent bindings (host proxies, re-bound on every worker start, never snapshot-restored):

```text
rika.workspace   search, read, replace, write   (typed, diff/display-emitting)
rika.processes   start, status, stop            (long-running, streamed)
rika.web         search, readPage               (credentialed, host-side)
rika.media       attach                          (images into model context)
rika.threads     search, read                    (cross-Thread retrieval)
rika.context     current, historyPage, searchHistory, compactions
rika.harness     snapshot, createMemory/Skill/Subagent/PromptNote, update*, delete*, recordRefinement, rollback
rika.artifacts   put, get                        (large values out of context)
context          current Thread/Turn/Workspace/references/trust labels (value)
```

Direct `Bun.file`/`fetch`/`Bun.$` remain available — this is a trusted local environment with the user's OS authority, exactly like Prime. The `rika.*` wrappers exist where the host owns authoritative state, credentials, durability, interruption, or rich presentation — not to gate the filesystem.

### Context as data (the RLM property)

```ts
const page = await rika.context.historyPage({ limit: 200 })
const failures = page.entries.filter((entry) => entry.kind === "ToolResult" && entry.failed)

const checkpoint = (await rika.context.compactions()).at(-1)
const preCompaction = await rika.context.historyPage({ before: checkpoint?.firstRetainedEntry, limit: 500 })
```

Backed by Baton's exact `SessionStore` path — including entries behind compaction checkpoints — read-only, paged, and bounded. Only what the model prints re-enters its token window. Cross-Thread history goes through `rika.threads`. The kernel never mutates canonical history.

### Recursive agents (real Baton Child Runs)

```json
{
  "members": [
    {
      "key": "provider-review",
      "selection": "Review",
      "label": "Provider reviewer",
      "prompt": "Review the provider boundary"
    }
  ],
  "concurrency": 1
}
```

`run_child_group` admits the exact group atomically and blocks the model tool operation until every member settles. Baton derives parent, root, depth, policy, and tool-call identity from `ToolContext`; each child is a normal durable Run with its own Session and lazy kernel. The root is depth zero. `maxDepth` bounds child edges, while `maxSubagents` is each parent's lifetime direct-child quota. Replay returns the same children before charging quota, terminal children do not refund slots, and each eligible child independently receives the same allowance. Child cards render from structured Baton child-tree events.

### Continual harness

Rika owns a versioned store with Prime's proven shape: four kinds (prompt note, memory, skill, subagent spec) + refinement events; entries carry id/title/content/path/scope/reference/arguments/version; local (Thread), Workspace, and global scopes; every edit records before/after for rollback.

Authority and timing:

1. Cells and `/refine` propose edits through `rika.harness.*` host requests (validated, audited).
2. Applied edits produce a new content-addressed harness snapshot.
3. The snapshot is pinned in the executable registrations of the **next** Execution; a running model turn never has its system prompt silently rewritten. (Prime applies mid-session in a disconnected critical section; Rika's Baton-pinned variant is stricter and replays exactly.)
4. The system prompt carries only the compact overview (bounded entries per kind and bounded content); full entries are read on demand via `rika.harness.snapshot()`, while delegation uses Baton's pinned child selections.
5. Rollback is a first-class operation using recorded before/after snapshots.

### Skills

Instruction-only skills keep the current global/Workspace discovery and lazy `SKILL.md` bodies. TypeScript-backed skills are workspace/global packages importable by name inside the kernel — inspectable, callable, optionally CLI-exposed — with a locked content-addressed environment identity; changing the skill set starts a new kernel epoch with an explicit notice. MCP servers surface as `rika.mcp.<server>` programmatic proxies over Baton's MCP services, not as provider tools.

## Kernel contract

### Worker topology

One Bun worker process per Baton Session (Thread root or child), owned by a Server-scoped pool acquired once at the composition root (a Thread must reuse its kernel on a later Turn; Server shutdown closes the pool; a generation/lease permits one live owner per Session).

Protocol: JSONL over stdio (`execute`, `interrupt`, `snapshot`, `shutdown` in; `output`, `display`, `hostRequest`, `result`, `snapshot` out). Two invariants proven in the tracer:

- Cells are exclusive per Session and run in authored order via a promise-chain queue.
- The worker read loop is **never** blocked behind an executing cell, so `hostResponse` messages can settle a promise the active cell is awaiting. This is Prime's control-channel rule restated for stdio.

### Cell execution

```ts
const js = transpiler.transformSync(code) // replMode: hoists decls, wraps TLA, { value } result
const evaluated = vm.runInContext(js, context, {
  filename: `rika-cell-${cellId}.ts`,
  importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
})
```

The context carries the standard globals plus `require` (workspace-rooted), `rika`, and `context`. `console` is a per-cell capture that streams bounded stdout/stderr events. The terminal result carries status, formatted value (`Bun.inspect`, bounded), duration, truncation facts, and the kernel epoch. A thrown error is a `CellFailed` domain result with the traceback — model input, not a framework failure.

`Bun.Transpiler` strips types without typechecking; a type error the model cares about surfaces by running `bun tsc`/project checks in a cell, as with any REPL. `replMode` is used exactly as `bun repl -e` uses it; its transform contract is vendored-tested upstream. A pinned Bun version is part of the kernel profile; a Bun upgrade is an explicit profile change and new epoch.

### Persistence and recovery (honest contract)

- **Durable truth:** Baton operations, events, Session entries, children. Never the worker.
- **Best-effort state:** on successful cell completion (debounced) and graceful shutdown, the worker snapshots the vm context per variable with `v8.serialize`, skipping functions, modules, live handles, and oversized values, writing an atomic owner-only snapshot + manifest under the canonical data root keyed by Profile/Session/epoch. Restore on worker start replays serializable values, then re-runs the bootstrap so `rika`/`context`/skill handles are live, then reports `StateRestored { names } / StateLost { droppedNames, reason }` to the model — Prime's exact restore-then-rebootstrap-then-notify order.
- Functions and classes are not snapshot-restorable (v8 structured clone cannot serialize them). The prompt teaches the model to persist reusable procedures as harness skills or workspace files, not as ephemeral closures it expects to survive a crash. This is a real semantic difference from dill (which can serialize many functions) and is stated, not hidden.
- Snapshots are trusted-local artifacts: owner-only permissions, manifest-authenticated, never loaded from a repository, restore failure is non-fatal and reported.
- **Never replay a committed or uncertain cell.** Server death during a cell → Baton `OperationUnknown`/needs-resolution → Rika recovery card → explicit user resolution; the resumed model receives `CellOutcomeUnknown` plus kernel status. Kernel restart is a separate product operation that never resolves a Baton operation.

### Interruption

- Cancellation aborts the cell's AbortSignal; Effect-based and event-loop work interrupts cleanly; owned Child Runs cancel through Baton.
- A synchronous busy loop cannot be interrupted in place. After a bounded grace the user chooses **wait** or **kill worker**; kill starts a new epoch, restores best-effort state, and reports the loss. This is the honest Bun equivalent of Prime's busy-kernel wait/kill choice (`ipython.ts:150-161`) with a weaker in-place story than SIGINT, accepted.

### Output and backpressure

Byte/event caps applied at ingestion per channel (stdout, stderr, result, display), truncation markers with dropped counts, spill of large results to `ToolOutputStore`/artifacts, no unbounded progress queues, no base64 image replay in snapshots.

## Nested durable host operations

A `rika.*` call that crosses an authoritative or external boundary is not an invisible callback. Baton's generic nested-operation executor (new, runtime-owned, REPL-agnostic) persists request/running/succeeded/failed/unknown keyed by outer operation + host-assigned ordinal + kind + payload digest before the Rika handler crosses the boundary; duplicates return the recorded outcome; divergent payloads under the same identity fail typed; approval-requiring operations suspend exactly as today's `write` tool does; unknown non-idempotent outcomes park for explicit resolution. Pure in-worker computation creates no nested operations. This preserves edit/web/process/child-call-granular certainty and approval instead of making a cell one opaque side effect.

## Trust and security decision

The kernel runs with the Rika Server user's OS permissions. It is a lifecycle boundary, not a sandbox — the same posture as Prime and consistent with Rika's implemented open-filesystem tradeoff. Consequences accepted explicitly:

- Operation-level read/write/shell permission categories cannot be represented as security controls against arbitrary TypeScript and are deleted rather than left as misleading UI. Approvals survive where they attach to `rika.*` nested operations.
- Specialist profiles still narrow prompts, models, budgets, admitted children, and host modules — but are no longer OS capability sandboxes. If per-role filesystem/process isolation ever becomes a requirement, the correct alternative is the capability-only Agent Program design, and this migration stops.
- Credentials stay host-side; workspace-local skills/extensions require explicit trust before import; untrusted fetched/file content stays labeled data; users needing a real boundary sandbox the whole Server.

## TUI preservation

One new semantic block, everything else unchanged.

**Cell block** (added to the transcript Block union): collapsed → status marker, `ts` label (or `$` visual language when the cell is a single `Bun.$`/process call), first meaningful line, line counts, duration, truncation; expanded → highlighted source, streamed stdout/stderr, result, collapsed traceback, restore/loss/epoch notices. Diffs from `rika.workspace.replace` render the existing diff presentation; images via `rika.media.attach` render the existing image block; processes render the existing process rows. Baton-native child calls render SubagentCards at their actual parent Run level, with descendants nested under the child that invoked them. Approval and recovery cards extend the existing authorization presentation. Projection stays in `@rika/baton-execution` folding Baton events into semantic units; OpenTUI renders units; live and reloaded paths share the fold; checkpoint version bumps.

## Package and source impact

**Baton (next release):**

- New optional `@batonfx/repl`: root export carries cell/`KernelProfile`/event Schemas, snapshot-store port, host-binding registry, the one Tool, a test worker, docs (no process deps); the `@batonfx/repl/bun` subpath carries the full Bun kernel — worker pool + lease, replMode/vm evaluation, output capture/bounds, watchdog escalation, three-tier snapshot/restore + import replay, `@effect/platform` BunWorker transport. The only module with process dependencies.
- New `@batonfx/harness` (or a `core` module if small enough): generic continual-harness engine — entry kinds, versions, before/after snapshots, refinement events, rollback, scope merge, prompt-overview formatting, content-addressed snapshot registration codec.
- `@batonfx/core`: nested-operation port on `ToolContext`/`ToolExecutor` only.
- `@batonfx/runtime`: nested-operation executor + stores; root-pinned recursive child policy; blocking singleton and exact-group admission with structured origin correlation; Session history paging/search; (later) durable family inbox. Memory + all-SQL parity; replace the greenfield SQL baseline rather than shimming.
- `@batonfx/skills`: executable TypeScript-backed skill package metadata (import name, environment digest) extending the existing `SkillSource` seam.

**Rika (after pinning released Baton):**

- New thin `@rika/kernel`: composes `@batonfx/repl/bun` with Rika data root, workspace, limits, trust mode, mounted `rika.*` bindings; doctor probes.
- `@rika/baton-execution`: `typescript` in conversational manifests (Title stays tool-free), with Baton's Execution Host dynamically supplying `run_child` and `run_child_group` while recursive policy permits them; kernel-profile + harness-snapshot registrations; the `rika.*` binding implementations over existing Effect services; cell/recovery projections; delete broad role-toolkit assembly and Code Mode composition after cutover.
- `@rika/coding-tools`: keep the bounded Effect operations and presentation results as `rika.*` backends and the direct human shell; delete model-facing `Tool.make` declarations and catalogs after cutover.
- `@rika/extensions`: skill discovery locations/precedence, harness store locations and scope policy, refine UX.
- `@rika/transcript` / `product-store` / `terminal`: Cell block, checkpoint version, recovery cards.

## Additional required deliverables

These are part of the same shipment, not follow-on work.

### A. Real-TUI acceptance on a live cheap model

Every phase gate includes driving the **real** Rika TUI, not only scripted in-process tests. The harness has OpenRouter with DeepSeek configured for cheap live execution; use that route for interactive acceptance.

Must be demonstrated live and after reload, with recorded evidence (pilotty snapshots + agent-tty recordings):

- cell rows: running/complete/failed, collapsed and expanded, streamed stdout/stderr, bounded output, tracebacks
- file diffs from `rika.workspace.replace` rendering in the existing diff presentation
- process rows and long-running command output
- image attachments
- subagent cards: native blocking singleton and group admission, live status transitions, expand/collapse, nested child activity, nested-child-of-child, exactly-once rendering, cancellation
- agent messaging surfaced in the transcript (parent↔child, sibling↔sibling, cross-Thread)
- approval and recovery cards, kernel restart notices, state-restored/state-lost notices
- compaction, Thread reload, and Server restart producing identical presentation

A phase is not complete until this evidence exists.

### B. Diátaxis documentation for both repositories

Both Baton and Rika get documentation organized on Diátaxis lines — tutorials (learning), how-to guides (task), reference (information), explanation (understanding) — without violating either repo's existing doc-ownership rules (`docs/features/*` remains the owning contract per capability in Rika; Baton keeps `docs/features/*` likewise). Diátaxis is the organizing structure and navigation, not a second source of truth: reference material is generated from or pinned to executable contracts, and no claim gets two authoritative homes.

Required coverage: the cell programming model, `rika.*` bindings, context-as-data, skills, MCP, prompts, the continual harness, agent messaging, goals, recovery semantics, and the trust model.

### C. Extensibility parity with Prime's continual harness

Users keep and extend: skills (instruction-only and executable TypeScript packages), MCP servers, prompts/guidance, and extensions — all still discoverable and exposed to the model progressively.

Additionally, **every Rika session is itself a continual harness**: the agent may create, update, reuse, and roll back its own memories, skills, prompt notes, and subagent specs within a Thread (local scope), promote them to Workspace or global scope, and have them pinned per Execution. Session-local creation must be as easy as Prime's `rlm.harness.*` — the point is an environment that accumulates capability as it works.

### D. Goal feature in Rika (Prime-style)

Rika gains a persistent Goal: a durable objective that survives Turns and Server restart, with status (active/paused/complete/errored), optional token and wall-clock budget, usage accounting, and continuation prompting so the agent keeps pursuing it across Turns until completion or user change.

- Ownership: Rika owns Goal product state, UX, and lifecycle; Baton owns continuation budgets and safe re-entry (never a second agent loop).
- Model surface: `rika.goal.get/create/complete` bindings mirroring Prime's `goal` skill; the agent must explicitly complete a goal rather than implying completion.
- **TUI:** top-left corner shows the active goal with elapsed time — `Goal 32s`, `Goal 2 days` — styled to match the existing bottom-left status line but with a **distinct animated icon** (its own frame set, not the tool/status spinner frames). It appears only when a goal is active, respects responsive layout, and is covered by TUI tests and live acceptance.

### E. Idle CPU and memory correctness (bug + regression gate)

Observed defect: the Rika Server sits near 100% CPU while idle. This must be diagnosed and fixed as part of this work, not deferred.

- Find the actual cause with evidence (profile the idle Server and TUI; inspect polling loops, unbounded `Effect.forever`/`Schedule` loops, socket read loops, renderer animation ticks, watchers, and any busy-wait in transport or projection). Do not guess.
- Fix at the owning boundary using Effect scheduling primitives; no spin loops, no zero-delay timers, no unconditional per-frame re-render when nothing changed.
- Animation (including the new goal icon) must not cause continuous redraws when idle: frames advance only while something is actually animating, and stop entirely when idle.
- Add a **performance regression gate**: automated proc tests asserting bounded idle CPU and steady-state memory for the Server, and for the TUI attached-but-idle, with generous ceilings and no wall-clock flakiness. Include a kernel worker sitting idle.
- Kernel workers must not add idle cost: no polling between cells, idle eviction honored, no leaked timers on cell completion.

## Migration sequence

**Phase 0 — hardened tracer + baseline.** Freeze a comparative task set on the current many-tool route. Grow the proven prototype into: crash-during-cell → OperationUnknown; kill-during-busy-loop → epoch restore with StateLost; snapshot restore across Server restart; output flood bounds; packaged-binary run on every target. Exit: tracer passes packaged, or stop.

**Phase 1 — `@batonfx/repl` + core port.** Contracts, tool, direct `Agent.stream` proof with the test worker and a real Bun worker: state across cells, exclusivity, authored order, error recovery, bounds, interruption, restore manifests, resource release.

**Phase 2 — runtime primitives.** Nested operations (fault-injected across memory + all SQL backends), blocking singleton and grouped children, tree policy, history paging, hosted tool proof through SQLite Runtime with `replayPolicy: "never"` cells.

**Phase 3 — Rika vertical slice.** `@rika/kernel` + host router + profile/harness registrations + cell projection + recovery/restart controls. Root and one child profile use the persistent cell and Baton-native child control behind a dev flag. Exit: scripted `*.tui.test.ts` + Pilotty show state reuse across Turns, an edit diff, an image, parallel children, cancellation, reload, restart notice.

**Phase 4 — context, harness, skills, messaging.** History paging + cross-Thread APIs in the kernel; harness store/snapshot pinning/refine/rollback; TS-backed skills + MCP proxies; durable inbox + message presentation; doctor.

**Phase 5 — comparative eval.** Frozen baseline vs the cell-first candidate, identical models/prompts/budgets, multiple seeds, end-state scoring: repo discovery/edit, multi-file refactor + test repair, long output, web research, images, cross-Thread + post-compaction recovery, parallel/nested children, restarts mid-cell, prompt injection, dangerous commands. Cut over only if durability/cancellation/TUI contracts all pass, task quality does not meaningfully regress, action-failure and context overhead improve or hold, and packaging is green. Otherwise fix the programming model or stop.

**Phase 6 — clean break.** Delete broad role toolkits, obsolete model-facing tool declarations, Code Mode + QuickJS package, name-specific projection branches, unenforceable permission config, and Rika-owned child admission; retain only the cell and Baton-native blocking child tools. Update CONTEXT/feature docs/graph/tests. No permanent dual production path.

**Phase 7 — release.** Baton focused tests + check + package → publish → pin in Rika → remove aliases → Rika unit/TUI/proc + check + per-target package + release-smoke → Pilotty + Agent TTY evidence for cell, diff, error, image, cancel/kill-restore, compaction, children, Server-restart flows.

## Verification contracts

- A recursively eligible provider sees exactly `typescript`, `run_child`, and `run_child_group`; a depth-limited conversational leaf sees only `typescript`; Title sees none: scripted request capture.
- Declarations persist across cells and Turns but not across Sessions: real-worker + SQLite integration.
- Cells exclusive and authored-order; host replies never deadlock an executing cell: concurrency tests + delayed-reply test.
- Nested host effects keep exact certainty/approval: fault injection at every journal boundary, duplicate/digest tests, memory + all-SQL parity.
- Cell exception is recoverable model input: two-turn self-correction script.
- Output floods bounded with spill and dropped counts: real flood test.
- Busy-loop requires explicit kill; kill restores state best-effort and reports losses; async work interrupts cleanly: proc tests.
- Server death mid-cell → OperationUnknown, never replay; recovery card resolution round-trips: SQLite reopen tests.
- Snapshot restore honest: serializable/function/handle/corrupt cases produce correct manifests and notices; snapshots never load from repositories.
- Children unforgeable, idempotent, durable, and rendered once, live and reloaded: runtime store contracts + `*.tui.test.ts` + screenshots.
- History paging exact incl. pre-compaction entries; kernel never mutates Session: integration + negative tests.
- Harness snapshot pinned per Execution, applied only at turn boundaries, rollback restores before-state: store + registration + reconstruction tests.
- Kernel profile changes (Bun version, skills, runtime digest) fail reconstruction and require explicit new epoch: registration tests.
- Workers, pipes, temp files, snapshots released on success/failure/cancel/shutdown: scoped proc tests.
- Packaged product provisions and runs offline per target: release smoke.

## Stop conditions

Stop and report rather than paper over: host replies to executing cells cannot be made deadlock-free; a supported target cannot run the worker reliably packaged; recovery requires replaying uncertain cell code; kernel state gets described as durable beyond the tested class; children bypass Baton admission/policy/events/cancellation; preserving subagent cards requires parsing cell source or opaque IDs; the eval shows an unrecovered quality regression; the design needs a permanent broad many-tool fallback.

## Final acceptance

- Recursively eligible conversational requests advertise only `typescript`, `run_child`, and `run_child_group`; depth-limited leaves advertise only `typescript`; Title advertises none.
- Variables, functions, and imports persist across cells, Rika Turns, and compaction in a live Server; restart restores serializable state or reports exact losses; uncertain cells are never replayed.
- Session history, compaction checkpoints, cross-Thread transcripts, references, and the harness are queryable as data from cells with bounded results.
- Child Runs use Baton-native blocking control, resume the same parent Run, and retain Rika's nested subagent presentation live and after reload.
- Harness refinements are versioned, scoped, pinned per Execution, rollback-able, and visible in the TUI.
- `rika.*` capabilities stay Schema-validated, Effect-interruptible, credential-free in the kernel, and nested-operation-journaled.
- The TUI renders cells, output, errors, diffs, images, processes, messages, children, approvals, and recovery coherently live and reloaded.
- The product states plainly that the kernel has the local user's authority and is not sandboxed.
- QuickJS Code Mode and the many-tool production path are deleted; Baton and Rika gates, packaging, release smoke, and Pilotty/Agent TTY evidence pass.

## Publishing Baton 0.20.0

Done. Baton `main` and `release` were fast-forwarded to `997b243`, tagged `v0.20.0`, and the release
workflow published all thirteen `@batonfx` packages to npm with provenance. Rika names `0.20.0` for
each of them, and both the vendored tarballs and the `overrides` block that existed only to pin them
to each other are gone.

The publish gate also requires the tagged commit to be an ancestor of `origin/release`, not only
`origin/main`, which is worth knowing before the next release.
