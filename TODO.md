# Rika V2 TODO

Status values: `pending`, `in-progress`, `blocked`, `complete`, `excluded`.

This file is the execution ledger. Update it in the same change that changes implementation status. Detailed product coverage lives in `docs/features/FEATURES.md`.

## Phase 0: 0; Phase 1: 3; Phase 2: 0; Phase 3: 2; Phase 4: 2; Phase 5: 1; Phase 6: 0; Phase 7: 0; Phase 8: 3; Phase 9: 1; Phase 10: 1; Phase 11: 4.

- [x] Rename `/projects/rika` to `/projects/rika-old` without altering its dirty worktree.
- [x] Create `/projects/Rika`.
- [x] Write the initial `PLAN.md`.
- [x] Write the initial `TODO.md`.
- [x] Define canonical vocabulary in `CONTEXT.md`.
- [x] Create the specification index in `SPEC.md`.
- [x] Create a first-class feature inventory.
- [x] Record initial architecture decisions.
- [x] Initialize Git after the foundational files exist.
- [x] Capture the v1 commit and dirty-worktree reference in `docs/reference/V1_BASELINE.md`.
- [x] Run the first oracle architecture review.
- [x] Resolve every specification-level critical/high finding from the first oracle review.

## Phase 1: Dependency and API Proof

- [x] Verify installed/local-overlay metadata and package exports for all Baton packages; registry publication is not claimed.
- [x] Verify installed/local-overlay metadata and package exports for `@relayfx/sdk`; registry publication is not claimed.
- [x] Reproduce and document the `@relayfx/sdk@0.0.50` undeclared MySQL import failure.
- [ ] Release Relay with clean dialect subpaths or complete runtime dependency declarations.
- [x] Implement and locally verify the upstream Relay SQLite/package correction.
- [x] Install dependencies without file, link, or workspace references.
- [x] Inspect installed Effect CLI `Command`, `Flag`, `Argument`, `CliError`, and `CliOutput` source.
- [x] Inspect installed Effect platform Bun runtime and terminal services.
- [x] Inspect installed Effect SQL SQLite APIs and migration support.
- [x] Inspect installed Effect WebSocket client/server/channel APIs.
- [x] Inspect installed Effect Stream cursor and backpressure APIs.
- [x] Inspect installed Effect Cluster and Workflow APIs used by Relay.
- [x] Create the Relay capability matrix with public operation names and semantics.
- [x] Create the Baton-to-Relay execution event coverage matrix.
- [x] Specify and prove Relay and Rika migration loading and ordering.
- [x] Compile and run the Baton clean packed external-consumer smoke program.
- [x] Compile and run the Relay embedded SQLite clean packed external-consumer smoke program.
- [x] Compile and run the Relay packed-tarball SQLite external-consumer smoke program.
- [x] Document missing or unsupported Relay capabilities.
- [ ] Submit and release required upstream Relay changes.
- [ ] Run the dependency/API oracle review.

## Phase 2: Repository Foundation

- [x] Create root `package.json` and exact dependency catalog.
- [x] Create `bun.lock` from registry dependencies.
- [x] Add Turbo task graph.
- [x] Add root TypeScript configuration.
- [x] Add Oxlint configuration.
- [x] Add Prettier configuration.
- [x] Add documentation consistency checks.
- [x] Add initial dependency boundary checks.
- [x] Add package build/typecheck/test scripts.
- [x] Add CI workflow.
- [x] Make the current foundation gates pass.

## Phase 3: Effect CLI

- [x] Implement root command with `Command.make`.
- [x] Export leaf command values, root `command` and `run`, and app-entrypoint-only `main`.
- [x] Implement version command.
- [x] Implement interactive default action.
- [x] Implement `run` and `-x` execute surfaces.
- [x] Represent stream JSON flags in the parser contract.
- [x] Represent the thread command tree.
- [x] Represent the config command tree.
- [x] Represent the MCP command tree.
- [x] Represent the skill command tree.
- [x] Represent the tool command tree.
- [x] Represent the review command.
- [x] Represent the doctor command.
- [x] Add parser/help/error tests for every command branch.
- [x] Prove help/version without infrastructure startup.
- [x] Prove all parse errors and flag relationships without infrastructure startup.
- [ ] Implement product behavior behind the parsed command contracts.
- [x] Implement product behavior for durable Thread metadata command contracts.
- [ ] Run the Effect CLI oracle review.

## Phase 4: Relay and Baton Runtime

- [ ] [#105 Epic: adopt one interface-driven Relay runtime](https://github.com/dallenpyrah/rika/issues/105)
  - [ ] [#106 Persist immutable execution route pins](https://github.com/dallenpyrah/rika/issues/106)
  - [ ] [#107 Collapse Rika onto one Relay runtime backend](https://github.com/dallenpyrah/rika/issues/107)
  - [ ] [#108 Reconcile execution failures from canonical Relay state](https://github.com/dallenpyrah/rika/issues/108)
  - [ ] [#109 Replace PID-directory ownership with a kernel-released lock](https://github.com/dallenpyrah/rika/issues/109)
  - [ ] [#110 Make TUI shutdown join the runtime lifecycle](https://github.com/dallenpyrah/rika/issues/110)
  - [ ] [#111 Adopt the unified Relay release and prove packaged recovery](https://github.com/dallenpyrah/rika/issues/111)
  - [ ] Upstream dependency: [Relay #182](https://github.com/In-Time-Tec/relayfx/issues/182), released by [Relay #188](https://github.com/In-Time-Tec/relayfx/issues/188).
- [x] Define the Rika execution backend contract.
- [x] Compose Relay embedded SQLite through `@relayfx/sdk` exports only.
- [x] Register deterministic model layers through Baton/Effect AI package APIs.
- [x] Replace provider-name routing and legacy model/mode configuration with protocol-discriminated Gateways, exact model variants, complete main/Oracle mode routes, content-addressed registrations, immutable Relay revision pins, and role-specific typed compaction. Published Baton 0.4.3 cannot safely provide pre-output availability-only candidate fallback; ADR 0013 records that limit.
- [x] Materialize persisted fan-out overrides into deterministic child-specific Relay definitions and prove concurrent main and Oracle provider execution natively.
- [x] Implement thread-to-execution mapping.
- [x] Map each Rika Thread to one stable Relay Session id.
- [x] Map each Rika Turn to one deterministic top-level Relay Execution id.
- [x] Persist normal busy-time input as Pending Turns rather than Baton follow-up input.
- [x] Project Pending Turns once by durable Turn ID in a composer-joined queue panel with image summaries, steering selection, and dequeue controls.
- [x] Implement cursor-based event projection.
- [x] Implement execution start.
- [x] Implement cancellation. Native Relay SQLite coverage proves an in-flight model execution reaches one durable cancelled result through the public backend.
- [x] Prove current Relay boundary-checked cancellation semantics and record the mid-turn interruption gap.
- [x] Implement runtime inspection and steering adapters against the current Relay contract.
- [x] Implement the runtime permission adapter against the current Relay contract.
- [x] Implement restart and replay.
- [x] Implement pending/accepted execution reconciliation at startup.
- [x] Prove one complete deterministic model-backed execution.
- [x] Prove process restart and reopen.
- [x] Run the runtime oracle review. The 2026-07-13 review found that mode-specific backend construction and Relay's separate runner, fan-out, and Workflow SQLite helpers multiply independent clients against one file.
- [ ] Release a Relay composition that shares one SQLite client across the runner, Child Run fan-out host, Workflow host, and Client.
- [ ] Replace mode-specific backend layers with one process-lifetime runtime graph and persist each Turn's selected route before Relay acceptance.
- [ ] Replace cooperative PID-directory ownership with a proven kernel-released cross-platform lock and acquire it before Relay migration or runtime layer construction.
- [ ] Prove runtime cardinality, two-process exclusion, `SIGKILL` release, legacy-owner upgrade behavior, and acceptance-to-projection kill points from ADR 0012.
- [x] Make parsed product-only commands Relay-lazy and reject execution-capable commands while the Relay lease is held.

## Phase 5: OpenTUI

- [x] Connect prompt submission to durable Turn execution and terminal result projection.
- [x] Port the initial Rika v1 color and spacing tokens.
- [x] Port the pure view-state model for transcript, palette, mode, input, history, and queue actions.
- [x] Port the initial input editor behavior.
- [x] Port the initial transcript rendering.
- [x] Port tool and diff cards.
- [x] Group read/search, shell, edit/diff, and generic activity with complete expanded details and workspace-safe clickable editor paths.
- [x] Port the initial mode picker.
- [x] Port the initial command palette.
- [x] Port thread sidebar.
- [x] Render changed files as a complete nested tree in a full-height right sidebar with panel-bounded scrolling, colored line counts, and editor-opening file clicks.
- [x] Keep the mode selector grouped with the narrowed composer, refresh changed files while open, and switch mutually exclusively between changed files (`Opt+S`) and the Workspace file tree (`Opt+T`).
- [x] Bound subprocess output while draining, release terminal process entries, and stop loader animation from rebuilding the complete transcript.
- [x] Keep generic and child waits non-actionable, preserve permission request kinds, and reconcile exhausted Relay 0.0.50 follows through parent terminal state.
- [x] Implement measured transcript follow/detach behavior, footer cutout spacing, and phase-driven streaming/waiting dither loader.
- [x] Port image attachment rendering.
- [x] Preserve collapsed text paste through transcript, persistence, and model-input boundaries without leaking composer attachment tokens; click and repeated-paste expansion restore exact editable text.
- [x] Preserve structured image attachments through clipboard insertion, composer history, durable queued Turns, replay, and ordered Relay/Baton model input.
- [x] Preserve typed terminal image paste bytes, keep composer image attachments structured through prompt-part construction, and align recognized path formats with materialization.
- [x] Add child-agent and workflow activity views as presentation adapters, with frozen visual evidence and Relay-backed restart harnesses.
- [x] Remove all Rivet-specific status and recovery UI.
- [x] Remove semantic-search activity.
- [x] Remove ast-grep-outline activity.
- [x] Add character-frame tests.
- [x] Add deterministic screenshot capture workflow.
- [ ] Run the TUI oracle review.
- [x] Join tracked interactive fibers before resuming shutdown so scoped runtime and lease finalizers run in order.
- [x] Await delayed TUI initialization during shutdown, destroy a late renderer, and prevent post-close watcher or session work before lease finalization.

## Phase 6: Tools

- [x] File finder.
- [x] Grep/content search.
- [x] File read.
- [x] Media view.
- [x] Patch application.
- [x] File create.
- [x] File edit.
- [x] Shell command.
- [x] Shell command status.
- [x] Git inspection.
- [x] Web search through the Parallel Search API.
- [x] Web page reading through the Parallel Extract API.
- [x] Thread find.
- [x] Thread read.
- [x] Oracle.
- [x] Librarian.
- [x] Painter.
- [x] Task/subagent tool.
- [x] Tool list/show commands.
- [x] Permission metadata and test layer for the initial local tool family.
- [x] Register the initial Effect AI toolkit with the Baton agent and Relay durable ToolRuntime.
- [x] Deterministic transcript tests for every tool family.

## Phase 7: Context and Extensions

- [x] Hierarchical `AGENTS.md` resolution.
- [x] `AGENT.md` and `CLAUDE.md` fallbacks.
- [x] Referenced guidance files and globs.
- [x] File mentions.
- [x] Thread mentions.
- [x] Image mentions.
- [x] Automatic compaction.
- [x] Context usage analysis.
- [x] Skill discovery and lazy activation.
- [x] Skill-bundled MCP configuration for activated skill resources.
- [x] MCP local command transport.
- [x] MCP remote transport.
- [x] MCP OAuth with Baton lifecycle, local callback hosting, and protected local credentials.
- [x] Workspace MCP approval and persisted trust decisions.
- [x] TypeScript plugin loading.
- [x] Plugin tool-call hooks.
- [x] Custom agent profile registration.
- [x] Custom mode registration.
- [x] Plugin diagnostics and reload.
- [x] Pin plugin source hash, config fingerprint, generation, and tool-schema digest per execution.
- [x] Pin MCP command fingerprint and effective cwd for approvals.

## Phase 8: Amp Personal Feature Parity

- [ ] Complete every included row in `docs/features/FEATURES.md`.
- [x] Verify command palette coverage.
- [x] Verify keymap coverage.
- [x] Restore visible file mention completion, Ctrl+S route selection, and shortcuts help with packaged interaction evidence.
- [x] Verify thread lifecycle coverage.
- [x] Verify queueing, steering, and interruption. Queue promotion, active-execution steering injection, and native interruption flows pass.
- [x] Verify shell and incognito-shell prompts. Operation, real shell runtime, native OpenTUI permission/rendering, product SQLite persistence, denial, and busy queue behavior pass.
- [x] Verify execute and JSONL modes. Packaged plain-text and streaming JSON output flows pass against the extracted artifact; local stream-input tests prove ordered string/prompt-object JSONL and malformed-input rejection. Plain stdin prompting and image JSONL remain pending.
- [x] Verify review command and JSON output. Packaged text and JSON review flows pass against the extracted artifact.
- [x] Verify automatic compaction.
- [x] Verify cost and context displays.
- [x] Verify notification behavior.
- [x] Add and interactively verify wrapped auto-growth and mouse drag resizing in the OpenTUI composer.
- [ ] Run the feature parity oracle review.

## Phase 9: Durable Multi-Agent

- [x] Upstream Relay parallel child-run support if absent. Linked Relay `d43e19c`; release verification remains required.
- [x] Upstream Relay durable join support if absent. Linked Relay `d43e19c`; release verification remains required.
- [x] Implement parallel Task runs.
- [x] Implement automatic subagent runs.
- [x] Expose model-facing subagent spawn tools on the parent agent. Enabled Relay `spawn_child_run` plus per-profile `transfer_to_*` handoff tools on the top-level agent only; native turn proves durable Oracle spawn and parent resume on 2026-07-11.
- [x] Implement parallel review checks.
- [x] Implement parent-child event projection.
- [x] Implement child cancellation.
- [x] Implement parent cancellation.
- [x] Implement partial failure policy.
- [x] Implement bounded concurrency.
- [x] Prove kill/restart with active children. Verified through `ProductAgent.Service`, `RelayExecutionBackend.layerFromClient`, and the public linked Relay SQLite child-fan-out host on 2026-07-10.
- [x] Prove no duplicate visible side effects. The process-death harness verifies unique child projections and one visible effect per fan-out child after recovery.
- [ ] Run the multi-agent oracle review.

## Phase 10: Dynamic Workflows

- [x] Specify versioned workflow definitions.
- [x] Specify sequence operation.
- [x] Specify parallel operation.
- [x] Specify conditional branch operation.
- [x] Specify durable join policies.
- [x] Specify approval and timer waits.
- [x] Specify retry, budget, cancellation, and compensation.
- [x] Compile workflow definitions to Relay operations.
- [x] Implement the closed typed dynamic workflow extension, including tool execution and structured completion operations.
- [x] Implement investigate/implement/review/fix/verify workflow.
- [x] Implement parallel research/synthesis workflow.
- [x] Prove workflow kill/restart recovery. Native process harness verifies delivery and research-synthesis child-handler boundaries, SQLite reopen, pinned revision/digest, repeated definition registration, and one visible effect per operation.
- [ ] Run the workflow oracle review.
  - [x] Expose only delivery and research-synthesis through typed CLI start/inspect operations; narrow generic approval and branch claims.

## Phase 11: Packaging and Final Verification

- [x] Package macOS arm64. Archive checksum, inventory, clean-home install, and local runtime verified on 2026-07-10.
- [x] Package macOS x64. Archive checksum and inventory verified on 2026-07-10; native runtime remains a release-proof CI requirement.
- [x] Package Linux x64. Archive checksum and inventory verified on 2026-07-10; native runtime remains a release-proof CI requirement.
- [x] Package Linux arm64. Archive checksum and inventory verified on 2026-07-10; native runtime remains a release-proof CI requirement.
- [x] Exclude Windows explicitly until OpenTUI support is proven. Packaging rejects Windows and the construction test prevents support claims.
- [x] Install the host archive into a clean temporary home and remove it after verification.
- [x] Install and uninstall the host archive in user-local paths with an owned command symlink. Isolated packaging coverage verifies PATH-name version, help, noninteractive execution, reinstall, foreign-command protection, and idempotent uninstall without touching user state or configuration.
- [x] Run a real packaged coding flow against a fixture repository through Baton's TestModel.
- [x] Run all repository gates after establishing the first-party coverage floor.
- [x] Run all process-death durability flows. Packaged SIGINT/SIGTERM, process reopen, cancellation, idempotent start, cursor replay, active-child recovery, and delivery/research workflow-boundary SIGKILL recovery pass.
- [x] Run all currently implemented visual parity flows through the native OpenTUI renderer and frozen screenshot/character-frame baselines.
- [x] Replace monochrome visual PPM evidence with deterministic OpenTUI foreground/background captures and frozen cell-style JSON; add synthetic scenarios for Markdown, complex diffs, tool states, queue, permission, thread/sidebar, and narrow overlays without claiming external parity.
- [x] Reach and maintain at least 95% statements, branches, functions, and lines coverage over first-party app and package source. Latest retained global report: 98.17% statements, 95.77% branches, 96.20% functions, and 98.41% lines.
- [x] Build packaged CLI E2E tests for help, parsing, execute, JSONL, threads, tools, extensions, failures, signals, and restart. Verified from the extracted release artifact with isolated temporary homes/workspaces on 2026-07-10; help/parser failures also prove Relay infrastructure is not started.
- [x] Build real OpenTUI E2E tests that drive the native renderer through keyboard input, resize, streaming, overlays, queueing, interruption, and teardown. Native renderer coverage remains in `packages/tui/test/*.native.test.ts`; a packaged native-PTY E2E additionally proves welcome/composer rendering, keyboard submission, SIGINT exit, terminal-mode activation sequences, and restored termios state on macOS arm64.
- [x] Build deterministic fake-model harness scenarios for text streaming, reasoning, tool calls, malformed calls, approvals, steering, retries, compaction, and budgets.
  - Verified with real Baton TestModel and Relay SQLite on 2026-07-11: grouped text streaming and usage replay, distinct reasoning projection/replay through Baton aaba07e, read-file tool execution, unknown and malformed tool rejection, active-execution steering accepted and injected exactly once into the next eligible model request through Relay adc73d4 plus the issue #126 correction, transient model retry, token-budget exhaustion before a second request, cancellation, idempotent start, cursor replay, Approved/Denied/Always permission restart, forced automatic compaction, one durable checkpoint across backend reopen, compacted next-request context, and context-budget projection.
- [x] Build deterministic fake-model multi-agent scenarios for parallel children, partial failure, joins, cancellation, and parent resume. The Rika-level public-API harness covers bounded parallel dispatch, all four join policies, partial failures, idempotent cancellation, SIGKILL/restart recovery, parent inspection resume, ordered projection, and visible-effect deduplication.
- [x] Build deterministic fake-model long-workflow scenarios with kill/restart injection at every implemented durable boundary. Native Relay SQLite SIGKILL harnesses pass for delivery and research-synthesis child-handler boundaries with pinned definitions and deduplicated visible effects; approval/timer waits remain outside this claim.
- [ ] Build opt-in live-model smoke and eval suites using the local Vibe proxy Effect Config.
- [ ] Capture redacted transcripts and tool-call evidence for the pending live agent suite. Packaged config/keymap/doctor tests already prove configured secrets are not disclosed, but no live-model evidence is claimed.
- [x] Confirm excluded dependencies and features are absent from release archive inventories and packaged tool/UI surfaces.
- [ ] Run repeated final oracle reviews until no critical/high findings remain.
- [x] Record local residual risks and release evidence in `docs/reference/RELEASE_EVIDENCE.md`; publication and native-host CI release evidence remain out of scope.

PLEASE MAKE SURE AT THE END YOU PUBLISH CHANGES TO BATON AND RELAY, INSTALL RIKA TO MY MACHINE, AND MAKE SURE THEY DEPEND ON PUBLISHED PACKAGES THE LINK IS/WAS ONLY FOR DEV.

## Remaining Unchecked by Phase

- [x] Integrate interactive Thread continuation and monotonic durable execution terminal projection.

Phase 0: 0; Phase 1: 3; Phase 2: 0; Phase 3: 2; Phase 4: 2; Phase 5: 1; Phase 6: 0; Phase 7: 0; Phase 8: 3; Phase 9: 1; Phase 10: 1; Phase 11: 4.

## Relay 0.2.0 upgrade and resident-model refactor (2026-07-12)

Plan of record: the audit at the relay session scratchpad (WI-1..WI-8); Relay 0.2.0 carries the resident-model, durable fan-out, workflow, cancellation propagation, and SQLite idempotent-start surfaces.

- [x] WI-1 Pin @relayfx/sdk 0.2.0 and consume its public Client, fan-out, and workflow surfaces directly.
- [x] WI-2 Resumable streams replace the start race + 2s/250ms watchdog, the 25ms follow poll, and the 10ms child-result poll; fixtures script streams instead of stream exhaustion.
- [x] WI-3 `rika-thread` entity kind + `ensureThreadHost`: `packages/runtime/src/thread-host.ts` registers the host agent (`inbox_enabled`, wait/send permissions, deterministic `rika/thread-host` model) and the `rika-thread` kind (drain all, state disabled, continue-as-new 32 < host max wait turns); entities are created named per ThreadId through the awaited `getOrCreateEntity` parked-start result fixed in Relay 0.2.1.
- [x] WI-4 Pending-turn promotion through the durable inbox: submit while busy sends `{kind: "pending-turn", thread_id, turn_id}` with idempotency key `rika:turn:<turnId>`; the parked host wakes on `wait_for_messages`, calls `promote_turn`, and the registered promoter runs `TurnRepository.claimNextQueued`, which stays the exactly-once arbiter. Steering remains `client.steer`. Completion re-notification uses time-scoped keys `rika:nudge:<threadId>:<now>` because a deduplicated same-key nudge would never wake the host again. Notifies remain serialized behind the park-before-send guard for relayfx#180.
- [x] WI-5 `Operation.reconcile` shrunk: when the backend exposes the host contract, startup registers the promoter, re-ensures the host entity per non-terminal thread, and sends one time-scoped nudge; the queued-turn drain sweep now runs only on the legacy fallback path. Deviations kept intentionally: the Run-mode synchronous drain loop and the `queueDrain` semaphore stay (single-process dispatch ordering for interactive callbacks is not the host's job).
- [x] WI-6 Drop `Thread.sessionId` via migration `6_drop_thread_session_id` with a seeded v5 upgrade test.
- [ ] WI-7 Presence viewer indicator (`pending`, optional).
- [x] WI-8 Documentation for WI-3..WI-5: spec 05 (Thread Host), spec 08 (promotion mechanics), ADR 0011 (thread host entity), CONTEXT.md vocabulary.
- [x] Restore fan-out/workflow + suspended-wait-resume + cancel natives on Relay 0.2.0; delete the compatibility seam and capability gates.
- [x] Pin published Baton 0.4.3 and Relay 0.2.13, simplify `web_search` to a homogeneous non-empty array schema, reconcile deterministic starts after Relay persists a terminal execution, preserve opaque Relay failure detail beyond 1,000 execution events, validate actionable waits against current Relay state, reject inert child fan-outs, keep deterministic test-model selection fixed across TUI reasoning modes, route every child compaction policy through an isolated durable Session, and clear terminal TUI working state without duplicate generic failures. The generic known-tool malformed-argument recovery seam remains blocked upstream in Effect AI 4.0.0-beta.93.
