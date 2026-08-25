# Hosted agent-loop repair plan

## Outcome

Rika must behave as one hosted coding-agent system with two explicit execution targets:

- A local Thread uses the Runner rooted in the checkout that launched the TUI. The Runner is ready before input is enabled, so local work never enters a workspace-preparation state.
- An Orb Thread uses one generation-fenced E2B Executor. The UI shows workspace preparation only while a durable, unexpired preparation attempt exists for that Orb generation.
- The API owns identity, command admission, ordering, placement, encrypted model credentials, and disposable projections.
- TenetKit alone owns Run admission, execution, cancellation, history, and terminal state.
- An Executor owns workspace, process, and tool side effects only while its assignment fence is current.
- The TUI sends commands and renders typed server state. Disconnecting or quitting it cannot change execution state.

The implementation is complete only when the automated and recorded checks in `VERIFICATION.md` pass through the real local and E2B interfaces.

## What led to this work

The reported symptoms are consequences of interacting design defects rather than one isolated failure:

- Local Turns fall through a generic activity mapper to `workspace-preparing`, even though local execution has no preparation record.
- The hosted Thread WebSocket delivers most state as responses to inbound frames, while the TUI performs a full attachment every 500 milliseconds to simulate push delivery.
- A failed mutation recursively reconnects and retries while holding the single command-admission permit. Later submissions wait behind an operation whose admission outcome is unknown.
- Rika transitions a Turn to running and persists an outbox row before calling TenetKit, then a worker renews its product claim while waiting for start. A lost result leaves Rika with a second lifecycle to recover alongside TenetKit's durable idempotent Runtime.
- Cancellation can time out and force the product Turn to `cancelled` while TenetKit may still be running. A later durable assistant event then contradicts the fabricated product terminal state.
- Orb preparation is fenced by assignment generation and lease epoch, but it has no durable deadline that a database worker can expire. A lost Executor can therefore leave a truthful historical `preparing` row looking like current progress forever.
- Runner registration, assignment admission, Turn admission, remote-cell admission, and operation dispatch repeat overlapping readiness checks. More checks did not produce more safety because they do not share one readiness fact.
- Development startup requires production integrations even when testing a projectless Runner or blank Orb. That prevents the real hosted path from being exercised cheaply and continuously.

The earliest bad decision is duplicated lifecycle authority. Polling loops, watchdogs, forced settlements, and retries above it attempt to reconcile facts that should never have had two owners. The repair therefore starts by assigning one owner to each fact and deleting compensating paths after their replacements work. A short database lease may still renew while one live worker owns a bounded external call; that protects single ownership rather than inventing another lifecycle.

## Decisions and reasoning

### Keep model execution and credentials on the API

The API already stores provider credentials encrypted and TenetKit already runs there. Moving model credentials to a Runner or Orb would increase the secret-bearing surface and make reconnect recovery depend on an Executor. The API will resolve an opaque owner-scoped credential identity only while constructing the model resource. Executor registrations and operation payloads remain secret-free.

This matches the desired Amp-like control-plane model: clients authenticate to a hosted service, while tools execute in the selected environment. It also preserves the server-owned OpenAI OAuth work already on `main`.

### Use real PostgreSQL for development

The hosted design depends on concurrent connections, transactions, row locking, worker claims, and cross-replica notification. PGlite or an embedded compatibility layer cannot prove those semantics. Alchemy will run a pinned PostgreSQL 17 Alpine container with a named volume and a bounded readiness check.

The cost is requiring Docker. That is an honest prerequisite for reproducing the deployed architecture and is simpler than maintaining a second development database behavior.

### Use Alchemy v2 as the one local infrastructure entrypoint

Root `bun run dev` will invoke the current Alchemy v2 stack. Alchemy will own Docker resources and foreground development processes, including teardown and input-driven restarts. This replaces undocumented manual ordering without introducing a custom supervisor.

Alchemy's Docker container health status is not a dependency output. A finite readiness command will therefore verify PostgreSQL before migrations and API startup. Long-running Caddy, cloudflared, API, and web processes use `Command.Dev`; no background shell process, polling supervisor, `nohup`, or tmux service is added.

### Keep the interactive TUI as a separate command

Infrastructure and a foreground interactive terminal have different lifecycles. `bun run dev` will make the hosted system ready; `bun --cwd apps/rika start` will launch the TUI in the terminal used for interaction or recording. Hiding both behind one process would complicate input, restart, and teardown behavior.

### Seed through real application boundaries

The development seed runs only when both `NODE_ENV=development` and `RIKA_DEV_SEED=1` are set. It will:

- sign up the fixed development user through Better Auth so password hashing and account rows are real;
- mark only that exact seed user verified with one development-only SQL update because Better Auth has no local email-delivery round trip;
- create the development organization through an authenticated Better Auth operation when absent;
- call the product ownership operation to materialize Personal and Organization Owners;
- store the Amp-provided OpenRouter key through `HostedProviderCredentials.put` for each owner.

The seed runs before the API reports ready and is idempotent. There is no public seed route, login bypass, direct fake password hash, or production fallback. Browser automation and the TUI authenticate the seeded account through the ordinary Better Auth email/password flow and then use the same session and device authorization boundaries as any other account. Development-only fixed credentials are an input to the seed, not an unauthenticated HTTP capability.

### Make development integrations an explicit capability set

Production remains strict: configured E2B, repository publication, GitHub identity, and mail integrations must be complete. Development composes only capabilities that are present:

- Runner is always real.
- Orb is unavailable when all three E2B controller values (`E2B_API_KEY`, `E2B_APP_ID`, and `E2B_DEPLOYMENT_ID`) are absent.
- A partial three-value E2B controller tuple is a startup error. When it is complete, Alchemy hashes the exact local Executor image definition, reuses only a ready build attested against that digest, or builds and attests a new template. The generated immutable template and build IDs are then passed to the API; developers do not duplicate them in local configuration.
- Repository checkout and publication are unavailable without a GitHub App.
- Development uses password login and a no-op mail sender without requiring GitHub OAuth or Resend.
- Every hosted model role and mode resolves to `RIKA_DEV_MODEL`, whose default is the pinned free tool-capable `minimax/minimax-m2.7:free`, using the same encrypted opaque credential identity as production. OpenRouter's `openrouter/free` randomly changes the model behind consecutive turns; that is useful for exploration but makes agent-loop failures irreproducible. The pinned default was selected from OpenRouter's live model capability catalog and verified with real required function-calling requests; unlike the other available free candidates tested, it returned the requested tool name and schema-valid arguments. `RIKA_DEV_MODEL` remains the explicit escape hatch when the free catalog changes.

The application edge chooses concrete capabilities. Core callers receive typed unavailable results rather than fake credentials, fake provider identifiers, or conditionals spread throughout the codebase.

### Test blank Orbs before repository Orbs

A projectless blank Orb proves E2B creation, bootstrap, transport, preparation, model execution, and tool dispatch without copying the production GitHub App key. Repository checkout and publication are a separate integration gate because they have different credentials and failure modes.

### Expose only the Executor route to E2B

An E2B Executor must reach a public WebSocket endpoint from outside the laptop or Amp orb. A Cloudflare quick tunnel will target a dedicated Caddy listener that accepts exactly `/api/v1/executors` and returns 404 for every other path. The full development proxy, deterministic development account, auth routes, and seed behavior will not be exposed through that tunnel.

The restricted listener starts first. Cloudflared then emits and validates one HTTPS quick-tunnel URL. The dependent API starts with the corresponding immutable WSS Executor URL. If the URL changes, Alchemy restarts the API. One narrow signal-forwarding wrapper may discard cloudflared's localhost diagnostic URL and print only a validated `https://*.trycloudflare.com` value because `Command.Dev.url` scans output for only five seconds; it will not supervise, retry, or retain state.

Development checkpoint storage uses MinIO with generated access credentials, a named volume, and an idempotently created private bucket. The E2B checkpoint adapter will set S3 `forcePathStyle` only when a custom endpoint is configured. Generated database, auth, encryption, and object-store secrets remain redacted Alchemy outputs, are written only to one exact ignored state path when a process environment file is unavoidable, and use owner-only permissions without shell interpolation.

### Map URL schemes instead of forcing TLS

The API will derive WebSocket URLs by mapping `http:` to `ws:` and `https:` to `wss:`. This permits plain local Caddy or direct development HTTP while preserving TLS in production. The rule will have one pure owner used by Thread, Runner, and Executor ticket issuance.

### Give placement readiness one owner

Runner registration and assignment admission will establish a current fenced connection before the TUI enables submission. Local execution has no workspace-preparation row. A disconnected Runner makes the Thread visibly wait for its local workspace; it does not become Orb preparation and does not move automatically.

Creating an Orb Thread persists only a pending assignment; it does not call E2B. Once prompt admission durably creates an executable Turn, the Turn worker claims it and remote-cell admission starts Executor provisioning. The assignment transaction persists its generation, provisioning lifecycle, and bootstrap deadline before the E2B call, so the UI can project that bounded state as workspace preparation while the sandbox starts. The Executor then persists the finer preparation attempt and phase before setup work. A database compare-and-set expiry operation fails overdue attempts. Completion from an expired attempt or stale generation cannot make the workspace ready. Retry or replacement increments the relevant attempt or generation and fences old work.

Operation dispatch still validates the current assignment generation and lease because that independently prevents stale side effects. It will not rerun provisioning or preparation.

### Stage deterministic TenetKit admission before activation

Command admission will allocate and persist immutable Turn input, one FIFO ordinal, `turnId`, and the active/queued position in one product transaction. Once placement is ready, the worker resolves the model route and executable registrations exactly once and persists that complete nonsecret prepared TenetKit admission envelope before making any TenetKit call. The top-level identity will be:

- `sessionId = threadId`
- `runId = turnId`
- `idempotencyKey = turnId`

The worker calls the released staged TenetKit admission operation, which stores the root Run as queued but ineligible for model or tool execution. Exact retries return the same admission; divergent payload or Run identity collisions remain typed conflicts rather than being flattened to generic unavailability. Rika persists the admission receipt before it may request activation.

Product activation and cancellation serialize with one database compare-and-set. If cancellation wins before `activation_requested_at`, Rika never calls activate and cancels any staged Run without allowing execution. If activation wins, Rika persists `activation_requested_at` before calling TenetKit. TenetKit's own store transaction then orders activate versus cancel. A cancellation that reaches an inactive Run first terminally cancels it, and later activation cannot produce a model or tool attempt.

A lost staged-admission receipt does not make a cancelled Turn unrecoverable. Recovery replays the exact deterministic admission even when the product Turn is already cancelled, persists the authoritative Run link returned by TenetKit, applies Runtime cancellation, and only then removes the outbox. It does not require the Orb to be currently ready: readiness controls new executable work, while this recovery is settling an already admitted identity. This closes the crash window where `admit` committed, cancellation won, and the API died before saving the receipt without adding a second admission status.

PostgreSQL owns admission-claim time. A live worker renews its short token-fenced lease while it prepares the workspace, admits the Run, and requests activation. Renewal failure interrupts that worker before it may persist another transition; a replacement can reclaim only after database expiry. This is required because E2B creation may legitimately exceed one fixed lease, and allowing a healthy claim to expire can issue overlapping sandbox creates. Recovery retries the exact persisted prepared envelope and preserves typed `idempotency-conflict`, `run-id-conflict`, `invalid`, and `unavailable` outcomes. There is no product `attempted_at` guess: only TenetKit activation or Run evidence proves execution was attempted.

### Let TenetKit alone settle activated execution

A small terminal reconciler reads released TenetKit Runtime snapshots for deterministic activated Run IDs and compare-and-sets only the matching nonterminal Turn to the proven status. The Thread notification wakes clients, and the existing database-fenced FIFO worker can claim the next queued Turn only after its query observes no active Turn. Cancellation returns `requested` or `already-terminal`; it never reports `cancelled` merely because a wait elapsed. Only proven terminal Run state advances the queue after activation was requested.

Transcript projection may replay rich TenetKit history from a cursor, but projection health cannot cancel execution or invent terminal state. Projection failure remains visible and retryable, and a terminal Turn remains eligible for projection until its matching terminal checkpoint is stored. The old Root Turn start/recovery path, heartbeat claims, forced ten-second cancellation settlement, projection watchdog cancellation, and duplicate lifecycle methods will be removed after the new path passes recovery tests.

### Declare replay safety at the concrete executor boundary

A remote TypeScript cell has two different failure boundaries that must not be conflated. Losing the API process does not lose the Runner or Orb process, while losing the executor process can lose a locally running JavaScript fiber. The API therefore cannot turn either transport loss into cancellation or fabricate a tool result.

TenetKit previously recorded every Agent tool operation with replay policy `never`, including a Rika remote cell whose gateway already deduplicates dispatch by stable operation key and attempt. After an API crash, TenetKit consequently changed the outer tool operation to `unknown` and blocked the Run before a replacement Rika process could attach to the surviving executor operation. Keeping the operation alive only in Rika would create a second agent-loop owner; blindly rerunning TypeScript would duplicate side effects.

TenetKit 0.38.3 supplies the required boundary through the optional synchronous `ToolExecutor.replayPolicy(request)` selector. Rika pins `tenetkit` and `@tenetkit/pg` to that release together; no schema migration is required.

The durable boundary expresses the real guarantee:

- TenetKit's `ToolExecutor` selects replay policy for the concrete request before journaling. The default remains `never`; a durable remote executor may select `provider-idempotent` only when it forwards the exact stable `ToolContext.operationKey` to a provider that deduplicates that key.
- Rika's local/direct TypeScript executor remains `never`. Rika's hosted Runner and Orb route selects `provider-idempotent` because both gateways persist one operation identity before dispatch and never send a second execution for the same identity.
- On API recovery, TenetKit changes the abandoned retry-safe operation back to requested and re-enters the Rika `ToolExecutor` with the same operation key. It does not append `OperationUnknown` or begin another Agent turn.
- The replacement Rika process reconstructs the binding registry and per-call `ToolContext`, `NestedOperations`, Session, and approval authority from that new authoritative execution context. It attaches those volatile capabilities to the existing durable executor operation rather than redispatching code.
- Runner and Orb processes keep active cells and pending binding calls outside a physical WebSocket scope. A binding send that crosses a disconnected socket remains pending until reconnect or the cell deadline. Reattachment asks the executor to replay lifecycle frames and pending bindings; call identity and digest deduplicate repeated delivery.
- `admittedAt` and `deadlineAt` are first-admission operational metadata, not operation identity. The first durable executor row owns both values. Re-entry may regenerate timestamps, but both gateways adopt the persisted values before waiting or dispatching, so recovery neither conflicts nor extends the original deadline.
- A Runner or Orb process restart cannot resume an in-memory JavaScript fiber. Its persisted running cell state is therefore executor-authored uncertainty, not permission to run the code again. The executor reports that uncertainty through the existing terminal contract, after which Rika and TenetKit expose the real failed/unknown outcome without inventing success or cancellation.

This adds no Rika retry queue and no second durable operation ledger. TenetKit owns whether the Agent operation may be re-entered; the executor's existing receipt store owns whether the external operation was accepted, is still live, completed, or became unknown; Rika only joins those two authorities by stable identity.

### Serialize commands by stable identity, not by one client semaphore

Each submission has a stable `submitCommandId`. Each cancellation has its own stable `cancelCommandId` and identifies `targetCommandId`. PostgreSQL serializes their effect on the target identity:

- A cancellation tombstone committed first prevents a later delayed submission from being admitted.
- A submission committed first creates the Turn, after which cancellation targets that Turn.
- A disconnected client queries or resends the exact same command identity and payload until it receives the authoritative result.

There is no retry under a new command identity or changed payload and no global client permit held across network recovery. The TUI keeps the exact durable command pending across reconnect, resends it with a fresh transport request identity, and does not report cancellation before durable acknowledgement.

Before a Turn frame exists, Ctrl+C targets the exact optimistic submission, Thread, and durable submit command. The hosted session keeps only an in-memory submission-to-command rendezvous long enough for the interrupted submit fiber to publish its command identity; cancellation races that rendezvous with session close and fails a wrong-Thread target immediately. A Turn arriving concurrently does not clear the cancellation latch or retarget the command. This is correlation, not a second lifecycle store: PostgreSQL still decides whether submission or cancellation won, and a second Ctrl+C remains the explicit quit gesture.

### Transfer admitted command ownership to the server

The reported permanent `Sending` state exposed a second ownership bug: the WebSocket fiber admitted a command and then also applied it. PostgreSQL could prove that the command existed, but an API process or socket failure after admission removed the only fiber responsible for finishing it. Client reconnect logic was being used as a server job scheduler.

Admission now commits the immutable command, actor attribution, expected Thread version, and unique reserved Thread version, then returns `CommandAdmitted`. That frame means the server durably owns completion even if the client, socket, or admitting API replica disappears. A process-scoped worker claims admitted commands with `FOR UPDATE SKIP LOCKED`, reauthorizes the stored actor at the stored admission time, renews a short fenced claim while applying the operation, and atomically records its result, interactive events, snapshot, and cursor. PostgreSQL is the lease clock, so API clock skew cannot steal or extend a claim. The protocol-state row serializes claims only within one Thread; unrelated Threads remain claimable by other workers. Another worker reclaims expired claims. Transient infrastructure unavailability releases the claim for retry; deterministic invalid, forbidden, missing, stale, and conflicting outcomes complete as durable rejections.

The client does not confuse UI correlation with durable identity. `submissionId` identifies the optimistic composer row and may restart at `submission-1` in every TUI process. `commandId` is a random `submit:<UUID>` that never repeats across reopened sessions. `SubmissionAdmitted` carries the UI correlation value, while cancellation before Turn allocation targets the durable submit command. This directly removes the collision that made the first submission in a reopened TUI remain at `Sending`.

Prompt submission and cancellation stop showing transport progress when `CommandAdmitted` arrives because ownership has transferred. A later application failure is pushed as `SubmissionRejected` or `ExecutionControlFailed`; it is not hidden in a response on the old socket. Other mutations may poll, but they resend the exact already-built command until its terminal result and never rebuild it with a newer expected version.

Thread creation uses its durable command ID as the deterministic Thread ID. The initial Thread, workspace, and pending assignment transaction is serialized on that identity and exact retries return the same target without reprovisioning; incompatible reuse conflicts. The CreateThread command is then admitted and completed by the same server worker as every other mutation, so a lost creation response or worker crash does not require more client traffic to finish.

Ordinary commands apply in reserved Thread-version order. The one deliberate exception is a `Cancel` targeting an earlier admitted `SubmitPrompt`: it may overtake only that exact prompt so cancellation can win while prompt admission is blocked. This exception means those two completions can still occur out of order. Durable events therefore carry the current authoritative protocol version at completion rather than an older command reservation. Snapshot writes replace only when their cursor is not older. The client also advances authority with max semantics, so a delayed completion cannot regress either Thread version or event cursor.

### Keep one schema-defined HTTP control plane and one WebSocket Thread transport

All ordinary Rika HTTP operations, including `/api/account` and `/api/v1`, are declared with Effect 4's released `effect/unstable/httpapi` contracts and implemented with `HttpApiBuilder`. Route contracts and controllers are split by the capability that owns them: public health, identity, Runners, recovery, publication, models, environment, and audit. The root API only assembles those groups and their authorization layer; it does not repeat an endpoint-by-endpoint path table. `@rika/identity` owns the account response schema. Better Auth's own `/api/auth` surface and standards metadata remain a supplemental HTTP adapter because they return Better Auth `Response` values rather than Rika API contracts.

Thread interaction uses one authenticated WebSocket from ticket redemption through detach. A coding-agent client sends submissions, cancellations, acknowledgements, and attachment cursors while the server independently pushes snapshots and events; SSE would still require a second mutation channel and two reconnect state machines. Executor and Runner relays also remain WebSockets because tool calls are bidirectional. There is no SSE endpoint and no polling status side channel.

### Replace pseudo-push with one scoped outbound WebSocket stream

Each server connection owns a bounded inbound command queue, a bounded encoded-byte outbound sink, and one live attachment. It installs a generation-counted wake subscription before reading a durable protocol baseline. Attachment sends a saved full snapshot at cursor H and every contiguous event after H through the captured head T, paging until T is represented. It then drains `(T,currentHead]` until the observed wake generation and durable event cursor are both current. A Boolean that can be cleared is insufficient because publication can race with clearing.

PostgreSQL triggers issue `NOTIFY(threadId)` in the same transaction as protocol events, event-backed snapshots, Turn status transitions, and workspace placement transitions. Every API replica owns one supervised `LISTEN` connection and preserves the payload: a notification wakes only sockets attached to that Thread. The attachment captures its Thread generation before reading durable state, so publication racing the read cannot be missed. Listener reconnection wakes all attached cursors once, and one replica-wide thirty-second sweep repairs a commit whose best-effort notification was lost without giving every socket a two-second polling loop or adding a durable notification log.

Thread sockets never participate in authority-session polling. While unattached, their outbound side is dormant and inbound attach or command frames wake the connection; once attached, transactional notification plus cursor replay drives delivery. Runner and Executor authority sessions retain their separate connection-authority supervision because assignment fencing is a different contract. This avoids disguising a per-socket timer as WebSocket push.

TenetKit's operation row is the sole recovery-resolution authority. The recovery API calls `Runtime.resolveOperation` and derives `retrying`, `accepted`, or `aborted` directly from TenetKit's persisted resolution. Rika does not write a second resolution state, idempotency key, payload, or timestamp, so loss after TenetKit commits is an exact Runtime retry rather than a cross-store repair problem.

The event cursor orders durable interactive events. Every full transcript view comes from the protocol snapshot durably pinned to the cursor and Thread version carried by its frame; the server never labels a separately read application projection with protocol state it may not represent. Current workspace placement may be overlaid because it is explicitly non-event state. A same-cursor frame replaces the prior full snapshot without claiming another event happened. Per-connection outbound processing is serial, and the client rejects cursor or Thread-version regression, so a refresh cannot overtake newer state on one socket.

Compaction may legitimately remove the next event required by a client that never established an acknowledgement row. Outbound replay validates contiguity rather than silently skipping the gap. If the required event no longer exists, it loads and sends a newer durable full snapshot as a reset point, then emits only the contiguous events after that snapshot cursor. Compaction therefore changes the replay baseline, never the meaning of a cursor.

The connection closes a slow consumer with a resumable overload reason before its bounded queue or byte budget is exceeded. The client owns one socket, one local cursor, and stable command identities. The 500 millisecond attachment loop, independent attachment fallback, recursive mutation retry, and competing `ExecutorStatus`/`WorkspaceStatus` projections are deleted after the typed snapshot/live feed is authoritative.

The snapshot exposes one typed placement state rather than inferring preparation from Turn activity:

- Runner: `disconnected | ready`
- Orb: `unassigned | preparing(attempt, deadline, phase) | ready | failed`

## Implementation sequence

### Reproducible development foundation

- Add Alchemy v2 and the root `alchemy.run.ts` stack.
- Ignore Alchemy local state before the first run and keep generated credentials in ignored files with restrictive permissions.
- Add pinned PostgreSQL, network, volume, readiness, migrations, local Caddy, API, and web resources.
- Add MinIO and bucket initialization, plus restricted Caddy Executor ingress and cloudflared when the three-value E2B controller tuple exists. Generate and attest the exact development template/build from the current image source before API startup.
- Add `.amp/services.yaml` for the hosted development portal and update orb setup/resume so Docker is installed and its daemon is supervised by an Amp orb service rather than an unsupervised background shell.
- Split production and development configuration at the composition edge.
- Add seed-before-serve and development OpenRouter model routing.
- Prove that starting the stack twice preserves data and repeats migration and seed safely.
- Gate deterministic seed execution explicitly with `RIKA_DEV_SEED=1` in nonproduction. Alchemy sets it; ordinary development and every production process that omit it cannot create the fixed account or credential.

### Causal diagnostics and reproduction

- Emit structured transitions for command admission, Turn identity, deterministic Run identity, assignment generation, preparation attempt/deadline, and connection cursor.
- Add one read-only operator query or view joining stable identities. Do not add a mutable diagnostic stage table or include prompts and secrets.
- Reproduce local first-send, disconnect during start, cancellation receipt loss, second-send ordering, Orb provision response loss, and preparation expiry before replacing behavior.

### Placement and preparation cutover

- Remove local preparation mapping and records.
- Require Runner connection readiness before input becomes available.
- Add Orb preparation deadlines, expiry compare-and-set, attempt fencing, and explicit failure projection.
- Before creating an E2B sandbox, inventory the exact app, deployment, assignment generation, template, and build. Adopt one matching sandbox and terminate deterministic duplicates so process death after provider creation but before result persistence cannot create another workspace.
- Keep dispatch-time assignment fencing and remove duplicate preparation checks from Turn and remote-cell admission.

### Lifecycle cutover

- Add persisted prepared Runtime envelopes, deterministic staged admission receipts, and `activation_requested_at`.
- Add PostgreSQL-clock renewable admission claims, typed staged TenetKit admission, and activation/cancellation serialization.
- Add minimal terminal reconciliation from TenetKit evidence.
- Close admission during migration and either prove every old replica stopped before changing data or persist a lifecycle epoch checked by every claim, prepare, activation, and completion transition. Process shutdown alone is not a fence.
- Cancel legacy sessions and known title Runs with a bounded wait.
- Mark only proven settled legacy work interrupted. Leave unresolved Threads blocked and operator-visible rather than silently restarting them.
- Start the new workers, reopen settled Threads, and delete the old lifecycle code.
- Opt only the durable hosted remote-cell route into TenetKit's per-request `provider-idempotent` tool policy.
- Reattach replacement API processes to durable dispatched Runner and Orb operations, rebuild binding authority from the re-entered Tool context, and replay pending binding calls without rerunning code.
- Prove API WebSocket loss during a non-replayable local side effect completes once when the executor survives and becomes explicit executor-authored uncertainty when the executor process does not.

### Live transport cutover

- Add the server outbound sink and atomic baseline/catch-up operation.
- Add transaction-coupled PostgreSQL notification, one supervised listener per replica, local generation wakeups, and the convergence sweep.
- Run the new feed in passive fingerprint comparison while polling remains the only client applicator.
- Cut the client to the live feed after no divergence under concurrent publication and reconnect tests.
- Delete polling, recursive retry, independent snapshot fallback, competing untyped statuses, and obsolete protocol APIs. Keep event-backed snapshots transactional with event append, and permit explicit same-cursor replacement only for current materialized projection or placement state.

### Final verification and deletion

- Run focused tests during each ownership change.
- Run all deterministic unit, process, and TUI suites.
- Run the complete local stack through the seeded account and free OpenRouter route.
- Run a real projectless E2B Orb through preparation, model response, and filesystem tool execution.
- Record both real TUI flows as required by `VERIFICATION.md` and inspect the recordings.
- Audit environment, wire payloads, and logs for secrets.
- Remove temporary fault-injection controls, debug files, obsolete compatibility paths, and stale documentation.

## Risks introduced by the repair

- A lost PostgreSQL notification could delay delivery. Transactional triggers eliminate the commit-before-notify gap for owned state, while the durable event cursor and low-frequency replica sweep recover listener loss without making notification authoritative.
- An admission or activation result can still be lost. The persisted prepared envelope, deterministic identity, staged TenetKit contract, and runtime inspection make recovery converge; external tool effects remain `accepted`, `dispatched`, `completed`, or `unknown`, never falsely exactly-once.
- A quick tunnel URL can change. Alchemy input dependency restarts the API with the new immutable URL; current Executor generations fence old connections.
- A free OpenRouter route can be rate-limited or removed from the catalog. It proves external integration only; deterministic assertions use a scripted model, while the development default pins one currently available tool-capable model instead of introducing random routing into every diagnosis.
- E2B or Cloudflare can be unavailable. Orb preparation reaches an explicit deadline-bound failure while local Runner development remains available.
- Clean-break migration can strand ambiguous legacy work. Blocking those Threads is safer than fabricating terminal state or launching duplicate Runs.

## Completion condition

There is no remaining code path in which Rika and TenetKit independently settle the same activated Turn, no local state maps to Orb preparation, no client mutation retries forever while blocking later commands, and no active transport depends on periodic full attachment. Every required automated check, machine-verifiable distributed invariant, and both inspected screen recordings in `VERIFICATION.md` must pass before this plan is called complete.
