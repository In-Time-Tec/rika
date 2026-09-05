# Rika latency code audit

## Scope and evidence discipline

Static audit of checkout `37d8f906f740bc306037916411ee2272017901a1`, plus the deterministic verification below. Line references are to that checkout, not a claim about the deployed binary. Read the root `AGENTS.md`, `PRODUCT.md`, `CONTEXT.md`, and applicable `apps/rika`, `packages/execution`, `packages/terminal`, `packages/product`, and `packages/product-store` agent instructions. There was no existing `docs/performance` directory or docs-specific AGENTS.md.

**No live tmux, PTY, hosted account, provider, deployment, or production database interactions were performed. No product code was changed.** Parent-owned live interaction evidence should be attached separately, identifying binary/build, placement, connection state, and workload.

Terminology in this report:

- **Code evidence**: observed control flow, constants, and contracts; not elapsed latency.
- **Measured evidence**: only the local test result in Verification. No startup, network, model TTFT, or user-perceived latency distributions were measured here.
- **Hypothesis**: a plausible source of latency that needs a span or controlled experiment.
- **Target**: a proposed aggressive engineering budget, not an existing guarantee.

Rika API owns product command order, Threads, queue state, and assignment. Generalist owns Runs, claims, agent/model/tool execution, steering consumption, and cancellation. Runner executes workspace tools, not the agent loop (`AGENTS.md:53–65`, `packages/execution/AGENTS.md:3–7`). Optimizations must not introduce a competing execution protocol.

## Executive findings

1. **First draw is intentionally decoupled from readiness already.** Hosted initialization waits for first draw; typing can therefore look ready before sending is permitted. Measure first draw, usable composer, authenticated attachment, and concrete Runner readiness separately. Do not call the existing UI-first path a blocking-auth renderer bug.
2. **The first usable local send still crosses a long dependency chain:** checkout preparation → create ticket → create Thread → interactive ticket/socket/attachment → placement → Runner start/readiness. Some local and account work can plausibly overlap; Thread identity, authorization, and fencing dependencies cannot simply be removed.
3. **Submit acknowledgment is already admission-first; queue and steer completion differ.** Submit returns on `CommandAdmitted`; most controls wait for `CommandAccepted`. Neither acknowledgment proves model start or steering consumption.
4. **Thread attachment has real serialized replay/hydration work.** API attachment completes replay before replying; client receive processing waits for the attachment commit. Historical transcript backfill, in contrast, is background and generation-cancelled already. Its automatic all-page loading can still compete with foreground work.
5. **Healthy workers are notification-driven, not necessarily 30-second polling loops.** A shared 30-second fallback and claim/retry leases can produce bad tails after notification loss or failures. Runner admission has a genuine one-second poll gap. Measure wakeup origin and claim eligibility before blaming the model.
6. **Cold queue submission performs execution preparation before the durable queue decision.** Model-route resolution and tool/capability admission can delay an apparently simple follow-up even when it will not run yet. Transactional admission also includes Generalist staging; profile lock hold times before changing semantics.

## Critical-path trace

### 1. CLI startup, first draw, and first send

| Boundary | Specific code evidence | Latency interpretation |
| --- | --- | --- |
| Parse → dispatch | `apps/rika/src/client/process.ts:297–307`; `apps/rika/src/command/root/rika.ts:89–158` | Parsing selects composition. CLI guidance explicitly forbids SQL/Generalist/provider/OpenTUI initialization before operation selection. |
| Interactive imports | `apps/rika/src/client/process.ts:116–135` | Runner, hosted CLI, and interactive controller imports already run at concurrency 3. Do not propose parallelizing these as new work. |
| Logging | `apps/rika/src/client/process.ts:151–165` | Persistent logging starts after first draw in a fork. It is not an intentional pre-draw disk barrier. |
| Renderer → initialization | `apps/rika/src/hosted/interactive-controller.ts:107–145,262–270` | UI and initialization race structurally; initialization waits for `firstDraw`, then selects the profile and constructs cached checkout preparation. |
| New local Thread | `apps/rika/src/hosted/interactive-controller.ts:146–192,205–223` | Runner checkout preparation precedes authenticated create-ticket issuance and `threads.create`. `--last` first lists Threads. Orb creation instead prepares/uploads a workspace seed before its ticket. |
| Checkout identity | `apps/rika/src/runner/checkout.ts:33–51` | realpath → git root → realpath → git metadata fan-out → common-directory realpath. Distinguish sequential identity dependencies from the existing metadata fan-out. |
| Interactive connection | `apps/rika/src/hosted/interactive-session/connection.ts:83–97,280–305` | New interactive ticket precedes socket connection and attachment. Creation uses its own ThreadClient connection; this is not one fused create-and-attach handshake. |
| Runner placement gate | `apps/rika/src/hosted/interactive-controller.ts:29–48,224–260` | Runner starts only after Runner placement appears. Session readiness is published before Runner completes, but exposed connectivity remains `connecting` until concrete Runner readiness. |
| Early user input | `apps/rika/src/hosted/interactive-controller.ts:62–95`; `apps/rika/test/hosted/interactive-controller.tui.test.ts:10–94` | Deferred session operations wait for initialization. The TUI test explicitly keeps Enter inert while connecting, retaining the draft; initial CLI prompt waits and sends once connected. A visible draft is not a sent prompt. |
| Rendering updates | `apps/rika/src/interactive/process/lifecycle/loop.ts:150–169` | Normal updates coalesce through a 16 ms timer; immediate updates bypass it. This is an intentional frame-scale delay, not evidence for multi-second startup. |

**H1 (high priority):** a warm-auth local launch pays avoidable sequential round trips and delayed Runner registration. Instrument checkout/profile/auth/ticket/create/attach/Runner spans individually. Test safe overlap of independent local checkout and authentication work, then earlier Runner registration after identity is known. Preserve first-draw-first behavior and never start a Runner for Orb-only placement.

For noninteractive follow-up, `apps/rika/src/command/root/noninteractive.ts:154` defines `run`; `apps/rika/src/hosted/thread-client.ts:285–314` connects, **attaches first**, then submits using the snapshot version. Thus `rika run --thread ...` does not currently skip attachment overhead. The root `--no-tui` operation instead starts a headless Runner (`apps/rika/src/client/process.ts:206–254`); it is not a synonym for sending a prompt.

### 2. Send → API admission → Generalist → Runner → visible output

1. TUI consumes typed pending actions and delegates to the terminal-session adapter (`apps/rika/src/interactive/process/runtime/pending-action.ts:20–48,59–89`). Hosted submit assigns a stable command/submission identity, translates attachments, and calls `mutate(..., true)` (`apps/rika/src/hosted/interactive-session/commands.ts:218–290`).
2. The physical command reader waits for one outcome; if it is `CommandAdmitted` and `completeOnAdmission` is false, it waits for a second (`apps/rika/src/hosted/interactive-session/connection.ts:124–147`). Therefore submit completion is an admission receipt, not execution readiness.
3. API authorizes, resolves admitted workspace information, stores the command, wakes the worker, and returns `CommandAdmitted` (`apps/api/src/hosted/thread/protocol.ts:272–277,355–395`). Admission is durable before asynchronous application.
4. Command worker claims commands and launches bounded active work (`apps/api/src/hosted/thread/command-worker.ts:34–63`). Application routes `SubmitPrompt` to authorized prompt admission (`apps/api/src/hosted/thread/command-application.ts:218–243,372–394`).
5. Prompt application serially resolves the model route, checks worker readiness, fetches execution context, prepares execution, then calls transactional `applyPrompt` (`apps/api/src/hosted/product.ts:142–189`). The first prompt can also request a title Run.
6. Generalist preparation admits remote tools (or captures local MCP), then capabilities, then configuration (`packages/execution/src/engine/runtime.ts:94–127`). Runtime root admission and optional title admission are sequential (`:175–196`). Root activation happens first; ancillary activation work then uses concurrency 2 (`:207–255`). Title-model work is not proof of a serial title-before-answer provider call.
7. Turn worker requests activation, invokes `activateTurn` or inspects activation state, and completes activation (`apps/api/src/hosted/thread/turn-worker.ts:35–43,66–84`). Rika's PostgreSQL adapter hands off to released Generalist `RuntimeWorker.layer` and forks `.run` (`packages/execution/src/postgres.ts:92–99,149–166`). The API configuration supplies Generalist concurrency 8, lease 30 s, fallback 30 s, cancellation interval 1 s (`apps/api/src/hosted/application.ts:58,229–232`). Internal Generalist scheduler timings were not measured or inferred from uninspected dependency internals.
8. Native tools route through stable remote operation identities (`packages/execution/src/routing/route-tools.ts:27–45,180–200`) to API executor gateway and the concrete Runner. Runner control/admission polling is distinct from Generalist claiming; no model loop runs inside Runner.
9. Projection worker recovers execution observations (`apps/api/src/hosted/execution/projection-worker.ts:34–89`), API Thread protocol transports changes, client validates and publishes projections (`apps/rika/src/hosted/interactive-session.ts:94–158`), and the TUI draws them. Measure durable projection latency separately from transient model preview and actual first visible response text.

**H2:** model-route/tool/capability preparation and transactional staging are larger contributors than provider TTFT on cold first send. Falsify with provider-free scripted model runs and API spans; avoid assuming every `yield*` is expensive I/O.

### 3. Queue and steer: different clocks and guarantees

- Enter during active work still submits `SubmitPrompt`. Server queue occupancy chooses accepted versus queued (`packages/product-store/src/hosted/thread-protocol/command-application.ts:213–266`). API queue capacity is 32 (`apps/api/src/hosted/product.ts:184`). Preparation occurs **before** this queue decision. `applyPrompt` holds product transaction locks (`:70–95`) and executes the supplied Generalist staging effect (`:265–277`). **H3:** slow staging increases same-Thread lock contention and queue acknowledgment-to-visibility latency; record lock wait and hold time, not just total SQL time.
- Queue wait due to an intentionally active preceding Turn is not scheduler latency. Measure: key → provisional item, key → durable admission, admission → durable queued item, prior Turn eligible/terminal → next activation/model start.
- Edit/dequeue/steer commands use the default completion-wait path (`apps/rika/src/hosted/interactive-session/commands.ts:293–326`). Unknown command outcome retries retain identity and sleep 250 ms; connection failures wait for reconnection (`:94–126`). This is failure/reconciliation behavior, not a mandatory healthy-send sleep.
- Product controls prepare durable steering admissions (`packages/product/src/operation/interactive/turn/control.ts:70–124`). Root owner calls `backend.steerTurn` and reconciles its result (`packages/product/src/thread/queue/root-owner.ts:296–324,388–401`); the execution adapter calls Generalist `runtime.steer` with run ID and idempotency key (`packages/execution/src/engine/runtime.ts:285–288`).
- **Steering receipt is not consumption.** Pending steering has explicit consumed/discarded dispositions (`packages/product/src/execution/session/pending-steering.ts:16–33`). Generalist decides the execution boundary where it applies. Measure key → receipt and receipt → consumed event separately; do not promise interruption of an in-flight provider call.
- Recovery can intentionally retry steering (`packages/product/src/operation/interactive/turn/observation.ts:281–344`). Preserve uncertain-outcome reconciliation, queued source ownership, and request identity when making controls faster.

### 4. Thread switch and hydration

**Actual foreground serialization:**

- Selection holds a one-permit semaphore across connection wait, attach, validation, reconciliation, projection publication, acknowledgment, and completion (`apps/rika/src/hosted/interactive-session.ts:46,183–295`). Supersession tokens protect against late selections (`:296–325`).
- API attachment authorizes and initializes, materializes a snapshot if needed, then completes replay before building `ThreadAttached` (`apps/api/src/hosted/thread/protocol-connection.ts:160–195,242–305`). Replay pages are sequential batches of 1,000 through a fixed cursor (`:198–239`); snapshot conflicts loop and retry. Presence refresh/list also precede the response.
- Client's single receive loop calls `input.receive`, then on attachment waits for `waiter.processed` (`apps/rika/src/hosted/interactive-session/connection.ts:235–245`). This is a real head-of-line gate protecting cursor/order semantics. A costly synchronous projection/renderer callback can delay later command outcomes on that socket.
- Re-selection to another Thread requests cursor `0`, while same-Thread refresh uses current delivered/checkpoint cursors (`apps/rika/src/hosted/interactive-session.ts:213–217`). A cursor map alone is not a complete reusable per-Thread view cache.

**Already background (do not misdiagnose):**

`apps/rika/src/hosted/interactive-session/history.ts:30–35,56–74,89–103` publishes the current snapshot, schedules historical loading, automatically loads all older pages serially with a 30 s per-page timeout, and races work against generation changes. Old responses cannot replace a newly selected Thread. History never advances durable acknowledgments (`:11`). It is not an explicit await-all-history-before-attach barrier.

**H4 (high priority):** large replay or automatic history backfill consumes socket/API/CPU/render bandwidth and makes switching or steering feel blocked. Benchmark 0/1k/10k/100k units, snapshot hit/miss, many small pages, and rapid A→B→C switches while model events arrive. Count bytes/pages, projection CPU, event-loop lag, time under selection permit, and first usable viewport. Consider demand-driven history, a bounded recent-Thread view cache, and a validated recent-window attachment protocol, not removing consistency checks.

## Polling, timeouts, and tail-risk inventory

| Evidence | Value/behavior | Correct interpretation / experiment |
| --- | --- | --- |
| `apps/rika/src/runner/service.ts:113–142` | Poll admissions, then sleep 1 s | Genuine periodic admission gap; under ideal independent arrival phase, adds 0–1 s wait (analytical, not measured). Test push/long-poll admission with reconnect fallback. |
| `apps/rika/src/runner/service.ts:283,297` | Additional 1 s lifecycle waits | Attribute by branch; do not add every literal sleep to every prompt. |
| `apps/api/src/executor/runtime-service.ts:87,267` | 1 s recovery cycle / 100 ms retry | Measure assignment readiness and reconnect branch participation. |
| `apps/api/src/executor/gateway/sessions.ts:45` | 100 ms await-session retry | Can quantize connection discovery; replace with scoped notification only if fencing remains intact. |
| `apps/api/src/executor/gateway/rpc/workspace.ts:92–101` | 30 s connect timeout, then 30 s response timeout | Failure bounds can stack; not fixed successful-request waits. |
| `apps/rika/src/hosted/http/client.ts:40` | 30 s HTTP timeout | Failure tail, not evidence of normal HTTP latency. |
| `apps/rika/src/hosted/interactive-session/connection.ts:124–174` | Deferred command/attach response waits without a local explicit timeout in these blocks | Open-but-stalled socket may strand foreground work; investigate transport-level closure/liveness before claiming it is globally unbounded. Use deadline + unknown outcome, never fresh-identity blind resend. |
| `apps/api/src/hosted/worker-runtime.ts:258–277` | Notification queue raced with fallback timer | Healthy notify path does not wait the fallback. Tag starting/notification/completion/fallback wakeups and listener status. |
| `apps/api/src/hosted/application.ts:58,278–280,326–328` | Turn lease 120 s; command claim 10 s; both concurrency 32; fallback 30 s | Defaults of 1 in worker modules are overridden in production composition. Failure recovery can wait claim expiry plus scan opportunity. |
| `apps/api/src/hosted/thread/command-application.ts:399–453` | Claim renewal; unavailable admission deadline handling | Preserve retry safety. `apps/api/test/hosted/thread/command-worker.test.ts:41–101` explicitly tests lease retention and deadline rejection. |
| `packages/execution/src/tool/process-registry.ts:244–257` | Waits for process exit up to requested poll interval | An exit-aware wait, not a blind sleep. Shell/tool waiting is user/model workload, not first-message startup by itself. |

**H5:** missed notifications, expired claims, or Runner registration timing create second-scale stair steps and rare 30-second tails. Inject delayed/lost notifications and reconnects with a fake clock before changing global timers. Reducing every timeout would primarily make failures faster, not healthy sends faster.

## CLI and TUI command inventory

This inventories operation names, not every flag. CLI root registration is authoritative at `apps/rika/src/command/root/rika.ts:136–156`; leaf modules below define arguments and flags. There is **no CLI cancel, queue, or steer subcommand**.

| Surface / source | Commands |
| --- | --- |
| Root `rika.ts:43–134` | Default interactive prompt, workspace/mode configuration; `--no-tui` headless Runner, remote-thread-creation allow/deny flags; `update`, `version`, standard help/version parsing |
| `root/noninteractive.ts:154`; `product/review.ts:5` | `run --thread <id> <prompt>` (including JSONL parsing options); `review` |
| `product/thread.ts:11–143` | `thread new` (Orb), `continue <id>` / `continue --last`, `service start/stop`, `portal`, `recovery inspect/retry/accept/abort`, `sync` |
| `product/auth.ts:5–38` | `auth login/status/logout/devices/revoke-device` |
| `product/organization.ts:4–15`; `project.ts:4–16` | `org list/personal/use/invite`; `project list/create/use` |
| `product/secret.ts:10–47`; `credential.ts:9–32`; `provider.ts:6–25` | `secret set/revoke`; `credential set/list/rotate/revoke`; `provider login/status/logout` |
| `product/diagnostics.ts:11–39`; `debug.ts:96` | `diagnostics path/status/export/performance`; `debug` |
| `product/local.ts:5–27` | `doctor`; `config list/keymap/edit`; `tools list/show` (four native tools, not MCP tools) |
| `product/local.ts:30–53` | `skills list/add/inspect/remove`; `extensions list/enable/disable/rollback` |
| `product/local.ts:55–95` | `mcp list/doctor/add/remove/enable/disable/oauth-login/oauth-logout/oauth-status` |

All `product/...` paths in this table are under `apps/rika/src/command/`.

TUI inventory (context-sensitive; do not equate palette text with CLI commands):

- Palette: new, new in Orb, switch, change mode, show context and usage, toggle fast mode, set max subagents, set max depth, quit (`packages/terminal/src/presentation/terminal/command-palette.ts:20–45`).
- Composer: Enter submit/queue; Shift+Enter/Ctrl+J multiline; Ctrl+S while busy with an active Turn and draft steers; Ctrl+Enter while busy interrupts and sends (`packages/terminal/src/state/reducer/keyboard.ts:149–151,224–245`; `keyboard-picker.ts:119–120`). Ctrl+S/Ctrl+M when idle opens mode selection (`keyboard-picker.ts:108`).
- Queue: select with arrows; Escape deselect; Ctrl+E edit; Enter steer selected queued Turn into active Turn; Backspace dequeue. Provisional items cannot be mutated (`keyboard.ts:81–145`).
- Thread navigation: Ctrl+T/Alt+W switcher; Ctrl+backslash Thread sidebar (`keyboard-prelude.ts:98–110`). Context Ctrl+Y; file mention `@`; Ctrl+O picker path; Alt+T workspace files and Alt+S sidebar view (`keyboard.ts:15`; `keyboard-picker.ts:85–122`).
- Lifecycle: active Ctrl+C durably cancels, second force-quits; idle Ctrl+C opens exit menu (`AGENTS.md:49`). Authorization approve/deny and new/select actions are typed adapter operations (`apps/rika/src/interactive/process/runtime/pending-action.ts:20–48`). Hosted shell action explicitly returns unsupported (`apps/rika/src/hosted/interactive-session/commands.ts:291`).

## Instrumentation and aggressive performance targets

Existing hooks: `packages/product/src/hosted/observability.ts:3–45` names process/first-draw/connection/ticket/socket/attach sub-stages, admission, turn/run claims, model start/terminal, tools, and terminal. Summaries currently request p50/p90/p99 (`:92–115`), not p95. Correlation annotations deliberately filter IDs (`:135–155`). `process_start` is emitted **inside dispatch** (`apps/rika/src/client/process.ts:99`), so it excludes executable load/import/parse time; measure OS spawn separately. Model terminal duration is not first-token latency.

Proposed service-level budgets, **unmeasured targets** for a warm authenticated Runner, healthy API/DB, ≤50 ms client/API RTT, no provider delay unless explicitly stated:

| Metric (explicit start → end) | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| Packaged OS spawn → first draw (cold process) | 100 ms | 200 ms | 350 ms |
| Spawn → send-enabled local Thread (warm auth/checkout) | 300 ms | 700 ms | 1 s |
| Key → local send/queue/steer feedback frame | 16 ms | 32 ms | 50 ms |
| Key → durable command admission | 60 ms | 150 ms | 250 ms |
| Admission → durable queue/control projection visible | 75 ms | 150 ms | 300 ms |
| Eligible accepted Turn → provider request start, excluding provider work | 75 ms | 200 ms | 400 ms |
| Prior Turn releases queue → next provider request start | 75 ms | 200 ms | 400 ms |
| Steering key → durable receipt | 75 ms | 150 ms | 300 ms |
| Generalist eligible steering boundary → consumed projection | 50 ms | 100 ms | 200 ms |
| Cached Thread selection → correct usable viewport | 16 ms | 50 ms | 100 ms |
| Uncached recent-window attachment → usable viewport | 100 ms | 250 ms | 500 ms |
| Provider first text received → first visible text | 16 ms | 50 ms | 100 ms |

Separate cold auth/device consent, token refresh, cold Orb seed/upload/provisioning, Runner reconnect, long transcript, and provider route cohorts. Orb has no defensible absolute provisioning budget from this audit: establish its baseline, then target ≥50% reduction in Rika-owned overhead, with immediate truthful progress feedback. For scripted zero-delay provider tests, target warm key → first visible response p95 ≤500 ms. For real providers, publish actual TTFT and Rika overhead separately, not an invented universal model SLA.

Add spans for key receipt, provisional feedback, command send/admit/apply, DB lock wait/hold, worker wake/claim, execution preparation, assignment ready, provider first byte/text, durable event persistence, receive/decode/project/draw, switch token/permit wait, history pages/bytes, and steering consumed/discarded. Join trace IDs with Thread/Turn/Run/command/submission/steering/assignment-generation identities in logs; keep high-cardinality IDs out of metric labels. Never record prompt bodies, tool output, credentials, or raw checkout paths. Add p95, counts, error/unknown-outcome rate, and cold/warm cohort dimensions with bounded cardinality.

Use monotonic local durations; cross-process timestamps need clock-offset treatment or causal span correlation. Record both end-to-end distributions and per-stage distributions—summing independent p95 values is not an end-to-end p95. Include queue eligibility timestamps so intended queue waiting is not misclassified.

## Phased implementation plan (future work, not changes in this audit)

### Phase 0 — Baseline and causal attribution

Owners: CLI/TUI + API + execution adapter. Add the missing spans and a provider-free latency harness first. Use packaged binaries as well as source mode; baseline ≥100 samples per principal warm/cold cohort, enough repeated samples for credible tails, and disclose sample size/host/load. Preserve parent-owned live terminal control. Export redacted traces and latency histograms, not screenshots alone.

Exit: each slow first-send/switch sample has a complete causal timeline; first draw and readiness are independently visible; healthy paths distinguish notify from fallback; no secret-bearing telemetry. Confirm/falsify H1–H5 before choosing invasive work.

### Phase 1 — Foreground responsiveness and bounded background work

Owners: CLI + terminal. Keep optimistic/local feedback within one frame without implying durable success. Bound/deprioritize automatic historical backfill; avoid full historical re-projection on every publication where safely incremental. Coalesce redundant selection requests and test generation cancellation; evaluate a bounded recent-Thread presentation cache. Keep mutations pinned to validated selected authority, never a cached/stale Thread. Overlap independent auth/checkout tasks only after proving no placement or credential race.

Exit: feedback p95 ≤32 ms, cached switch p95 ≤50 ms, history errors do not block composer or replace the selected Thread; memory bounded across 100 switches. Existing reconnect/order/queue tests stay green.

### Phase 2 — Remove admission and assignment round trips

Owners: API + Runner + product-store + execution boundary. Evaluate create-and-attach/ticket reuse only with audience, expiry, principal, and replay validation preserved. Replace one-second Runner polling with event-driven or long-poll admission plus recovery fallback. Profile route/preparation and transaction staging; move/cache only immutable, correctly keyed execution pins. Consider lightweight durable pending submission followed by preparation at promotion **only if** route/capability pinning, queue ordering, cancellation-before-apply, and idempotency semantics are explicitly maintained.

Exit: warm readiness p95 ≤700 ms, admission p95 ≤150 ms, eligible activation p95 ≤200 ms under concurrent Threads; zero duplicate native side effects in reconnect/failure tests. Any database changes require a separate reviewed migration plan, not this documentation task.

### Phase 3 — Worker/replay tail hardening

Owners: API + Generalist adapter. Instrument lost/coalesced notifications, capacity, claim expiry, and stale leases. Tune fallback/claim settings from failure experiments rather than shrinking all timeouts. Introduce bounded command/attach liveness deadlines with explicit unknown-outcome recovery. Optimize snapshot checkpoint frequency and bounded recent replay; do not remove the attachment processed barrier without an equivalent ordering proof. Negotiate any Generalist scheduler/steering improvement through released APIs/upstream, not raw Generalist table access.

Exit: healthy workloads never depend on fallback for progress; injected wakeup loss is detected and recovers within a declared tested bound; stale generations cannot execute; large replay does not starve commands. Meet p99 budgets or document cohort-specific exceptions with evidence.

### Phase 4 — Regression gates and rollout

Owners: CI + release + performance. Gate deterministic frame/operation counts and fake-clock delays in unit/TUI suites; run packaged process benchmarks on fixed hardware separately to reduce noisy CI failures. Alert on >10% sustained regression with absolute-budget breaches; maintain errors/retries/CPU/RSS/DB-QPS alongside latency. Feature-flag protocol/backfill/admission changes, canary by placement, and retain a rollback path that does not strand admitted commands.

## Relevant tests and gaps

| Existing evidence | What it protects / what it does not prove |
| --- | --- |
| `apps/rika/test/command/root/rika.test.ts`; `noninteractive.test.ts` | Entry-point isolation and noninteractive parsing; not packaged startup timing. |
| `apps/rika/test/hosted/interactive-controller.test.ts`; `interactive-controller/startup.fixture.ts:98–103,135–138,175–179` | First draw versus held profile/credentials, deferred startup, placement and Runner lifecycle; fixtures are imported tests, not standalone Vitest projects. |
| `apps/rika/test/hosted/interactive-controller.tui.test.ts:10–94` | Real TUI draft inert while connecting; initial prompt sent once connected. |
| `apps/rika/test/hosted/interactive-session.test.ts` and `interactive-session/{thread-selection,history,protocol-ordering,mutation-retry,submission-cancellation,reconnect-policy}.fixture.ts` | Late selection frames, durable queue edits, automatic old-page loading, reconnect ordering, identity/retry/cancellation. History tests explicitly cover stale responses and non-progressing pages. |
| `apps/rika/test/interactive/controller/{turn-submission,thread-selection,feed,palette}.tui.test.ts`; `thread-selection/steering.fixture.ts` | Mirrored real app behavior; extend these rather than substituting pure reducer tests for interaction. |
| `apps/rika/test/runner/{service,checkout,receipt-store}.test.ts`; `apps/api/test/runner/{gateway,executor}.test.ts` | Runner admission/checkouts/receipts and hosted execution boundary; not end-to-end provider latency. |
| `apps/api/test/hosted/thread/command-worker.test.ts:41–101` | Retry lease retention and admission deadline; explicitly relevant to failure tails. |
| `packages/product/test/operation/interactive/turn/{control,observation}.test.ts`; `packages/product/test/thread/queue/pending-policy.test.ts`; `packages/execution/test/projection/steering.test.ts` | Queue policy, control/observation, steering projection contracts. |
| `packages/execution/test/projection/semantic/response.test.ts:46` | Compact response hydration through Runtime API, not a benchmark of long Thread attach. |
| `apps/rika/test/platform/{performance,application-performance}.test.ts` | Footprint parsing/process discovery/observation evaluation/redaction; **not** first-message latency benchmarks. |

Missing explicit performance coverage: RTT-injected cold/warm handshake counts; zero-provider first-response budget; simultaneous history backfill and steer; queue eligibility-to-activation latency; 100k-unit rapid switches; open-but-stalled socket; missed worker notifications; route preparation while same-Thread lock is contended; concurrent Threads at worker/DB capacity; title Run impact on root request start. Add fake-clock tests for timers and deterministic scripted models for UI; use separately authorized process environments for PostgreSQL/packaged behavior. No provider/network calls in TUI app tests (`apps/rika/AGENTS.md`).

## Verification performed

Bun `1.4.0`; local command:

```sh
bun --bun vitest run --project unit \
  apps/rika/test/command/root/rika.test.ts \
  apps/rika/test/command/root/noninteractive.test.ts \
  apps/rika/test/hosted/interactive-controller.test.ts \
  apps/rika/test/hosted/interactive-session.test.ts \
  apps/rika/test/runner/service.test.ts \
  apps/rika/test/platform/application-performance.test.ts
```

Result: **6 files passed, 84 tests passed**, exit 0. Vitest reported **1.11 s** suite duration (test work 986 ms). This is verification of deterministic behavior, **not measured product latency**. No TUI/proc suite, live tmux, provider call, full check, build, or benchmark was run. Source inspection and reference validation accompany this doc-only change; all proposed optimizations remain future work.
