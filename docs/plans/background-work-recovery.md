# Background work and deployment recovery: diagnosis and plan

Diagnostic date: 2026-09-06. The incident evidence below was collected read-only. Implementation and release follow-up are recorded at the end.

## Outcome

The reported subagents failed for two distinct reasons: Rika rejected executor redispatch after reconnect, and Generalist resumed memory operations in the wrong order. A separate production log proves a successfully completed native operation was discarded by the replacement API because its in-memory waiter was gone. Background commands additionally have real stdin hangs, replay projection defects, and no automatic terminal-state delivery when the agent does not poll.

Fix recovery before increasing background concurrency. Keep Generalist as execution authority, the Executor as process owner, and Rika projections as disposable read state.

## Evidence and incident timeline

- Latest published CLI: [v0.12.10](https://github.com/In-Time-Tec/rika/releases/tag/v0.12.10), published September 5 at 17:22:48 MDT (23:22:48 UTC), consuming Generalist 0.61.1.
- Production API deployment `3c86841f-a9e9-45a8-b641-c86ef16456c5` was created at 17:42:53 MDT and became successful at 17:43:50. It replaced `1fea009e-70c6-4123-8cf5-d2556de51348`.
- Local evidence: `~/.config/rika/diagnostics/client-2026-09-05T23-19-17-644Z-57000.open.jsonl`, explicitly reporting CLI 0.12.10. Other live client logs report 0.12.9; installing a new release did not upgrade already-running processes.
- At 17:44:18.369 MDT, child `fanout_5e90fa05bdeb3c2f0b3e318135b867b0766be985e414a4fc_0` began bash operation `call_XgL5vOnEkCBn81HbmatWfvWN`.
- At 17:44:21.721, Runner sockets closed. The old API logged `execution-projection-watch.reconnecting`, with `WatchTurnFailure: runtime store released`, at 17:44:22.004, then exited with code 130. This is deployment shutdown evidence, not proof of an unrelated crash.
- Runner sockets reconnected at 17:44:22.826–22.890. The command returned a successful native outcome at 17:44:22.960, after 4,590 ms.
- The new API logged `native-operation.result-unmatched` at 17:44:23.443 for that exact operation, attempt 1, machine `d479997bae3c3344bd1d1bfee3dd7cb3e2906e12dc653e4f547b5d715e66aa12`, assignment `62a45cab-f807-4c62-afbb-c6498d4d63de`, outcome `Success`.
- Authenticated read-only Thread preview for `4572f49e-d486-4570-9f0a-5cfd20bad999` (Friendly Greeting), Turn `a5616a4a-ca56-4878-9152-374d4e434196`, records a two-member group with **two failures**:
  - Background command presentation: `Executor dispatch fence is no longer current`.
  - Background completion lifecycle: `Pending operation fanout_5e90fa05bdeb3c2f0b3e318135b867b0766be985e414a4fc_1:memory:remember:3:0 does not match requested operation fanout_5e90fa05bdeb3c2f0b3e318135b867b0766be985e414a4fc_1:memory:recall:0`.
- The parent later delegated to a replacement singleton, which completed. Its final response explicitly says automatic completion for unpolled commands was **not** implemented.
- The same preview still contains background-running rows in completed Turns. The original command contains `rg` without a path; its last projected process observation is `running: true`, elapsed 143,059 ms. A later child command also remains running in the projection after its child completes. These are persisted read-model observations, not proof the OS processes remain alive now.

These observations establish the result-loss sequence and exact user-visible errors. The precise failed SQL predicate for the fencing incident, and whether memory retention physically ran before shutdown, were not retrieved. Those details must not be presented as proven. No direct reads of Generalist-owned database tables were made.

## 1. Repair Rika executor recovery

### Source defects

1. `packages/product-store/src/hosted/assignment-store/assignment-fencing.ts:33–51` advances the lease epoch on reconnect without replacing the Executor generation/process. `packages/product-store/src/hosted/execution/operation-dispatch.ts:146–152` nevertheless requires the dispatched operation's old lease epoch to equal the current epoch for redispatch. This rejects the ordinary same-Executor recovery sequence. The observed fencing error is emitted by `apps/api/src/executor/lifecycle-store.ts:196–214`; other authorization predicates can also produce it.
2. `apps/api/src/executor/native-operation-endpoint.ts:249–256` logs and ignores results when its process-local pending map has no entry. Reconnection only reattaches entries already in that map (`:280–306`). Restart empties it. The production unmatched result demonstrates this path, rather than merely suggesting it.
3. Durable native-operation replay records already exist in `packages/product-store/src/hosted/execution/operation-lifecycle.ts`, but `replayQueue` has no production caller. Recovery must not depend solely on reconstructing an in-memory waiter after a higher-level claim expires.
4. `apps/api/src/runner/gateway-messages.ts:65–79` acknowledges reconnect before registering the new socket. Register first so immediate replies cannot race an absent session.
5. `native-operation-endpoint.ts:127–141` deletes pending state on send failure. The initiating call receives the send error; another already-waiting caller can lose its replay entry and remain waiting until deadline. Do not describe every send failure as an indefinitely hanging initiating call.

### Smallest repair

- Distinguish the current transport lease from the stable side-effect identity. Under a valid current lease and unchanged assignment generation, Executor identity, process incarnation, request digest and operation identity, recover an existing dispatch through the existing receipt/deduplication path.
- Preserve all current authorization and generation fences. Never blindly rerun work on a replacement process, remove lease validation globally, or turn an unknown side effect into an automatic retry.
- Reconstruct/reconcile outstanding dispatches using existing Rika native-operation persistence on reconnect, and ingest authorized terminal receipts even when the API waiter was lost. Persist before notifying waiting Generalist operations. Do not invent a second Run store.
- Make live delivery and restart recovery use the same acceptance rules and terminal result path. Keep transiently disconnected entries replayable, or explicitly settle their waiters; do not silently delete the only recovery index.
- Record structured rejection reasons (old lease versus different Executor versus revoked capability) without tokens. Include Thread, Run, operation, attempt, generation, and deployment identity on recoverable failures and unmatched results.

### Decisive tests

Use PostgreSQL-backed tests and a genuinely fresh API/gateway instance, not just another socket attached to the same instance:

- Replace API after dispatch, during execution, after Runner completion but before API persistence, and after persistence but before acknowledgement.
- Reconnect same Runner with a new lease epoch; accept its retained result without executing the command twice.
- Repeat with changed generation/process incarnation, revoked admission, and mismatched digest; reject stale authority and surface an explicit interrupted/unknown result.
- Deliver a result immediately after reconnect acknowledgement; force one send failure; verify bounded recovery and no orphan waiter.
- Repeat the real two-child scenario and prove both parent and child terminal projections settle.

## 2. Fix Generalist memory restart ordering upstream

Generalist `v0.61.1` and inspected upstream `main` were identical during this investigation.

- [Agent memory boundaries](https://github.com/In-Time-Tec/generalist/blob/v0.61.1/packages/generalist/src/core/agent/run.ts#L243-L301) construct the exact `memory:recall:0` and `memory:remember:<turn>:<terminal>` identities in the incident.
- [Initial prompt loading](https://github.com/In-Time-Tec/generalist/blob/v0.61.1/packages/generalist/src/core/agent/run.ts#L383-L394) can call recall on ordinary checkpoint restart despite a pending remember operation.
- [Durable pending scheduling](https://github.com/In-Time-Tec/generalist/blob/v0.61.1/packages/generalist/src/core/durable/driver/schedule.ts#L78-L100) correctly rejects the mismatched same-kind operation with `DriverStateInvalid`.

Repair the Agent continuation so a restored pending memory operation is reconstructed with its original identity and ordering. Pending recall must resume recall; pending turn retention must resume that exact retention before proceeding. Merely skipping recall may be insufficient if turn/session continuation does not reconstruct turn 3 correctly. Do not weaken the mismatch invariant or rename operation kinds to bypass it.

Add real-Agent restart tests at the journal boundary for initial recall, nonterminal remember, and terminal remember, both before and after outcome commit. Verify committed work replays without redispatch, uncommitted pure operations recover under the same key, prompts do not gain duplicate recalled context, and the child/parent eventually settle. Include PostgreSQL runtime coverage matching Rika's deployment boundary. Publish an upstream patch and consume the released version only as a separately authorized release step.

## 3. Finish background-command lifecycle and UI

### Existing local work is not the release

The dirty working tree already includes stdin EOF handling, completion-event correlation, guards against replay reverting terminal status, a static `⇢` background icon, and removal of detached metadata. These were present before this investigation. Their earlier agent's test claims were observed in its transcript, not independently rerun here. Preserve and review them rather than duplicating or reverting them.

The release's process registry does not close stdin explicitly. A noninteractive command such as `rg` without a path can wait on an input pipe nobody can write. The current local `stdin: "ignore"` change addresses this class of actual hangs; it does not solve all stale background state.

### Missing lifecycle contract

`packages/execution/src/tool/process-registry.ts` learns process exit locally, but its public surface is start/poll/cancel. Current instructions explicitly require `shell_command_status` and say completion is not pushed. Consequently, a completed start tool can leave its displayed process running forever unless some later status observation reaches the projection.

- Publish a terminal **process observation** independently of model polling. Correlate it with the original start operation, Run, assignment generation and process incarnation—not a small process ID alone, since registry IDs restart at 1.
- Persist/acknowledge terminal observations and replay them after API disconnect. Reuse the repaired native receipt transport and existing Generalist lifecycle/Program authority where applicable. A terminal observation is not a second result for the already-completed bash call.
- Do not consume the agent's unread output when updating the UI. Separate terminal status observation from destructive output polling; make retention/eviction behavior explicit.
- Keep projections updating when the parent finishes or the TUI is disconnected. If the Executor dies and outcome cannot be recovered, show interrupted/unknown, not success or indefinitely pending. A genuinely live long-running server stays background-running; no arbitrary timeout should fabricate failure.
- Preserve monotonic terminal state across duplicate, out-of-order, resumed, and completion-without-start events. Scope process-check correlation across Turns/children carefully.
- Single command row: foreground spinner while awaited; static `⇢` while running in background; normal success/failure/cancelled icons once terminal. No detached placeholder/subrow. Use “background command” in user-facing help/details/group labels. Mixed foreground/background groups should not hide active foreground work behind the background icon.

Tests: no-poll exit 0 and nonzero exit, real stdin reader, cancellation, API disconnect during exit, Executor loss, parent completion before exit, output preservation, process-ID reuse, replay after terminal, and mixed groups. Exercise the actual TUI application and inspect captures for foreground, background, terminal, and disconnected states. Do not count renderer snapshots alone as lifecycle verification.

## 4. Let the agent start work and decide when to wait

### Children: supported upstream already

Generalist 0.61.1 provides [start_child_group and await_child_group](https://github.com/In-Time-Tec/generalist/blob/v0.61.1/packages/generalist/src/runtime/child/group.ts#L124-L181). Start returns durable receipts immediately, including for a one-member group; await suspends durably only when requested. `run_child` and `run_child_group` deliberately block for results.

Rika currently tells independent work to use blocking `run_child_group` (`packages/execution/src/agent-instructions.ts:26–31`). Its dedicated child projection names only recognize `run_child` and `run_child_group` (`projection/values.ts:2–6`). Changing the prompt alone is insufficient for a good UI.

- Verify the admitted model toolkit exposes start/await in the actual production registration, then make nonblocking start the delegation default when the parent has independent work.
- Retain blocking calls for genuine dependencies. Guidance: start work; continue independent investigation/implementation; await only when its information is needed. Do not force polling loops or require the user to continue.
- Project start receipts into persistent child/group cards, bind children by durable identity, and correlate later awaits with the same cards. A successful start is not successful child completion.
- Use existing child settlement observations for UI updates. Make completed-but-unread results visible to the agent through a defined status/inbox mechanism at a safe model boundary; results must remain retrievable through explicit wait/inspection. Do not append a second provider tool result or pretend child output is a user message.
- Keep the minimum API: a one-member group already supports singleton start/wait. Dedicated singleton aliases are optional ergonomics, not a prerequisite.

Prove with a scripted model that the parent completes another reasoning/model/tool step before a held-open child resolves, and that an explicit await genuinely waits and survives restart.

### Ordinary tools: add a protocol-safe upstream start/await contract

Generalist's [tool scheduler](https://github.com/In-Time-Tec/generalist/blob/v0.61.1/packages/generalist/src/core/agent/tools/scheduler.ts#L83-L108) waits for each authored stage. Rika also currently serializes native calls (`tool/registry.ts`, maxConcurrency 1). Parallel execution within a tool batch is not the same as allowing another model turn.

Do not remove the tool-result barrier. Instead represent independently running work with existing Generalist durable Run/Program machinery:

1. Start/admit work and return a durable handle promptly as the start call's complete result.
2. Let the model continue with that receipt, or explicitly await/inspect/cancel the handle.
3. Execute under the original tool authority, placement, approval, replay and conflict policy. Arbitrary concurrent edits to the same files must not become safe merely because a background flag exists.
4. Publish terminal observations to projections and make results retrievable, without a late result for an already-resolved provider call.

Start with shell commands and children, which already have separable lifecycles. Generalize through existing Program operations or child Runs, not new Rika background-job tables or untracked fibers. Preserve output limits and existing child/concurrency bounds. Automatic notifications should be deduplicated and should not create repeated paid model turns after the user considers work finished.

### Completion and cancellation policy to encode

Recommended defaults: background work survives API/TUI transport loss; awaited work is not silently cancelled when a wait times out; explicit cancellation cancels the requested work and records its outcome. Before finalizing a requested task, the agent must collect/cancel task-critical children, or explicitly report intentionally continuing work. Long-lived requested services may remain running. Encode parent-cancellation/child-cancellation semantics explicitly and test them; do not assume Effect scope cleanup supplies durable product policy.

## Delivery order and acceptance gate

1. Rika same-Executor lease recovery and durable receipt ingestion, with the production-shaped restart regression.
2. Generalist memory continuation fix and upstream restart regressions; consume its released patch.
3. Review/preserve existing local shell/UI fixes; add automatic, durable terminal process observations and real TUI coverage.
4. Enable nonblocking child start/explicit await and corresponding cards/instructions.
5. Generalist generic background tool admission/await using existing execution authority, followed by Rika integration.

Steps 1 and 2 can be developed independently. Step 3's receipt transport builds on step 1. Do not ship broader background concurrency until both recovery fixes pass. Verify the combined result through a packaged CLI against an isolated API/PostgreSQL stack with process replacement, then the complete repository checks, unit, process and TUI suites. Production fault injection, deployment, publishing and pushes require separate explicit authorization.

Release gate: two children plus a background command can cross API replacement; parent reasoning continues when independent, explicit wait blocks when needed, no side effect repeats, no terminal result is lost, all cards/command rows settle correctly without agent polling, and stale authority remains rejected. Include old-client/new-API skew in validation because this incident had both 0.12.9 and 0.12.10 clients alive.

## Remaining uncertainty

This was source/log/transcript diagnosis, not a fault-injection reproduction. The authenticated preview is a persisted read model limited to the last four nonqueued Turns, not an arbitrary Run journal export. Exact fence rejection predicates and memory interruption commit timing remain unproven. The unrelated older Greeting Thread was still listed running despite a settled three-child group; include it in the read-only recovery audit rather than automatically retrying or cancelling it. No existing Thread state was repaired in this investigation.

## Implementation and release follow-up

The user subsequently authorized implementation, verification, pushing, publishing and deployment. Rika implementation stays in the primary agent; the separately owned Generalist repository release is handled in its existing thread.

- Native dispatch recovery now renews only the transport epoch under unchanged, current Executor authority. Runner reconnect reconstructs the durable request and accepts matching retained outcomes in a fresh gateway, without replacing the original result on duplicate delivery.
- Process exit is a separately persisted observation, not a second tool result. Runner and Orb retain unacknowledged observations, replay under fresh access, and remove them after acknowledgement. Observation does not consume output, and terminal metadata is frozen for idempotent replay. Atomic Orb session-file writes are serialized.
- Additive migration `0044-process-observations.sql` stores the observations. Transcript writes and Thread protocol snapshot/patch publication apply the same identity-scoped overlay. Reconnect reads durable projections instead of potentially stale interactive-session views. This prevents cached updates from resurrecting a completed process.
- The shell row uses a static `⇢` for background execution, normal terminal icons on completion, and no detached placeholder. Noninteractive stdin receives EOF.
- Generalist 0.61.2 fixes the pending remember/recall continuation and automatically exposes child start/await under its existing capacity/depth policy. Rika must consume the released package; static registration against 0.61.1 is unsafe and was removed.
- Parent success or failure is not child cancellation. Child cards consume actual child lifecycle events. Turn inspection and projection remain active while admitted children still need execution or approval, even if the root model has finished. Explicit cancellation remains Generalist's authority.
- Independent native shell work uses `bash` with model-facing `timeout_ms: 0`. Independent read/edit or other authorized work can run in a narrowly scoped Agent child through `start_child_group`, with `await_child_group` when its result is needed. Direct tool calls retain the provider result barrier.

Generalist's generic Program start/inspect/await/cancel tools are **not** an automatic native-tool adapter. The current public Program form requires JavaScript and a production CodeExecutor. Rika has no such executor and does not install a test executor or a new sandbox. Exact single-native-tool Program admission without an Agent or CodeExecutor remains an upstream capability gap, outside this release.

Verification includes PostgreSQL fresh-gateway recovery, authority fencing, early/late/duplicate process observations, and stale snapshot/patch replay; a real local process crossing a simulated Runner socket loss, replay under a new lease, acknowledgement removal and preserved unread output; concurrent atomic session saves; child lifecycle/replay and scripted nonblocking parent execution; and actual OpenTUI interaction and inspected captures. These tests do not retroactively recover already-failed Runs or prove recovery after permanent Executor/process loss. Old CLI processes must be restarted on the new release to emit automatic process observations.
