# Rika Maximum-Stress Autoresearch

## Mission

Stress every supported Rika product capability to its measured limit. Make the packaged Rika CLI and TUI fast, correct, polished, observable, and reliable through long real coding sessions and extreme failure conditions.

Repeatedly exercise complete Rika product flows under increasing load, long duration, concurrency, restart, cancellation, malformed input, resource pressure, and failure injection. Measure what Rika users experience, inspect correlated logs and durable state, improve diagnostics when evidence is missing, and find the owning cause of every slowdown or failure.

Rika stress testing will expose product defects and downstream framework design problems. Catalog each finding in the owning Rika, Baton, or Relay repository. Dispatch isolated fixer subagents in repository worktrees, merge verified fixes directly into that repository's `main`, release and repin framework fixes when needed, close the issue with proof, and rerun the original Rika workload. The main autoresearch loop remains focused on discovering the next Rika failure while fixers clear the issue queue.

## User-Visible Problems to Start From

- The TUI becomes slower as a session grows.
- Input, scrolling, streaming, overlays, and commands can lag or fail.
- Work may continue in the backend while the client becomes unresponsive or loses useful state.
- Rendering, event projection, transport, persistence, logging, and runtime composition may each contribute.
- Rika may be compensating for missing or awkward Baton or Relay APIs with expensive, duplicated, or fragile product code.
- Baton may amplify context, tools, events, retries, streaming, or model failures under long agent loops.
- Relay may degrade or violate durable invariants under high event counts, fan-out, contention, replay, restart, and slow consumers.
- Existing issues may describe incomplete, stale, overlapping, or incorrectly owned work.

Treat these as symptoms, not proven causes.

## Required Outcomes

1. Reproducible saturation baselines for the packaged Rika product.
2. A complete Rika workload matrix covering every supported feature and failure boundary, with load ramped until a limit, invariant failure, or justified host-safety ceiling is reached.
3. Logs and measurements that can locate stalls and failures without logging prompts, tool payloads, secrets, or high-volume content.
4. An Effect-native first-principles catalog that states the correct design, invariant, resource owner, public interface, failure model, concurrency policy, and repository owner for every finding.
5. Evidence-backed fixes in Rika, Baton, or Relay for every confirmed defect or design problem found.
6. Every issue that was open at the starting snapshot, plus every newly discovered issue, updated and closed with evidence or left open only for a documented external blocker that this agent cannot remove.
7. Before-and-after evidence showing whether each accepted change improved latency, throughput, memory, CPU use, command success, durable correctness, framework ergonomics, and visual correctness.
8. Final released Baton and Relay packages consumed by Rika without local links or product-local copies of framework behavior.
9. Final packaged Rika stress runs that pass at the highest safe tested scale.

## Non-Negotiable Ownership

- Rika owns product policy, coding tools, repository behavior, Resident Rika Service composition, client transport, product projections, CLI/TUI presentation, and user-facing recovery.
- Baton owns the non-durable agent loop, model/tool protocol, permissions seams, compaction, prompt construction, model-visible failures, and agent events.
- Relay owns durable executions, child runs, fan-out, waits, joins, cancellation, replay, workflow state, and terminal propagation.
- OpenTUI stays inside the Rika TUI adapter.
- Effect owns effects, resources, concurrency, scheduling, platform I/O, logging, and typed failures wherever its installed API supports the capability.

Fix behavior at its owner. Do not add a Rika cache, polling loop, retry, event translation, local durable state machine, deep import, or compatibility wrapper merely to avoid an upstream issue. Do not edit the read-only `repos/baton`, `repos/relay`, or `repos/effect` submodules. Use the actual Baton and Relay source repositories or clean external clones for upstream implementation. Rika consumes released Baton and Relay packages; framework fixes are incomplete until they are verified in their own repositories, released through the supported workflow, pinned in Rika, and proved through the packaged product.

## Evidence Rules

- Measure before changing code.
- “Maximum stress” means geometric load ramps and long-soak runs until the system reaches a reproducible capacity limit, violates an invariant, exceeds an explicit latency or memory budget, or reaches a documented host-safety ceiling. It does not mean exhausting the machine blindly.
- Start at normal usage, then increase one independent variable at a time. After single-axis limits are known, combine the highest realistic dimensions to expose interactions.
- Reproduce a failure at least twice when safe. Intermittent failures require enough repeated runs to estimate frequency.
- Keep terminal dimensions, fixture, model script, workspace, hardware, build, and capture method fixed for before-and-after comparisons.
- Use medians and tail values, not one favorable run. Record sample count, p50, p95, maximum, and failures where the sample size supports them.
- Separate model/provider latency from Rika, Baton, Relay, process, SQL, filesystem, transport, and renderer time.
- Profile the packaged Rika application, including its use of Baton and Relay through their public APIs, not isolated framework capabilities without a Rika-driven reason. Add focused framework reproductions or microbenchmarks only after a Rika failure names that boundary.
- Do not claim a speedup from fewer logs, hidden errors, skipped work, reduced durability, weaker rendering, smaller workloads, or disabled features.
- A test timeout is not a performance budget. Establish observed baselines, define a justified target, then preserve it with low-noise regression evidence.
- Keep raw evidence under `artifacts/` with a manifest containing revision, dirty-state digest, package versions, OS, architecture, Bun version, terminal dimensions, workload, run count, and commands.
- Never overwrite prior evidence needed for comparison.

## Performance Signals

Record at least:

- process startup to first usable composer;
- key input to visible character;
- command invocation to visible result or error;
- execution event receipt to projected state and rendered frame;
- scroll and resize responsiveness during active streaming;
- frame request count, full transcript rebuild count, and coalesced/dropped redundant updates;
- event replay duration by event count and transcript size;
- resident connection, request, response, reconnect, and resubscribe duration;
- tool request, approval, start, terminal result, and visible projection duration;
- CPU time, peak and steady-state RSS, event-loop stalls, output volume, log volume, and SQLite activity where available;
- command/tool success rate, duplicate visible events, dropped events, queue overflow, reconnect count, and terminal-state convergence;
- shutdown duration and whether terminal modes, fibers, sockets, clients, and renderers are released exactly once.

Prefer supported profilers and runtime counters. Instrument safe stage durations only when current evidence cannot separate boundaries. Remove noisy temporary probes after the permanent observability is sufficient.

## Maximum-Stress Matrix

Run the packaged Rika binary with isolated `HOME`, Rika data, Relay data, diagnostics, and fixture workspace. Use deterministic models, clocks, ids, tools, and failures first, then live providers only when credentials are valid and nondeterminism is useful. A focused Baton or Relay harness is allowed only to reduce a Rika-observed failure to the owning public framework contract.

At minimum cover:

| Surface                              | Required saturation axes                                                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rika TUI input                       | fastest supported key and paste rates; multiline drafts; history; images; mentions; mouse; composer resize; repeated commands                                                                                   |
| Rika rendering                       | transcript length from empty to capacity; huge Markdown, reasoning, tool groups, diffs, child activity, queue, overlays, sidebars, selections, narrow/wide/resized terminals                                    |
| Rika live product                    | long streams; tiny and huge deltas; tool bursts; permissions; steering; queued Turns; multiple clients; slow client; reconnect; resident replacement                                                            |
| Rika tools and extensions            | every built-in tool, shell mode, plugin, skill, MCP transport, image path, command, error, denial, cancellation, malformed input, large result, and workspace boundary                                          |
| Rika agent loop through Baton        | model turns, context growth, compaction cycles, tool count, parallel calls, streaming parts, malformed calls, retries, provider failures, permissions, steering, cancellation, cache reuse, and output spilling |
| Rika durable execution through Relay | Turns, events per Execution, concurrent Threads, child fan-out, joins, waits, Workflows, messages, retries, cancellation trees, replay cursors, idempotent starts, and terminal propagation                     |
| Rika and Relay persistence           | database size, concurrent Rika clients, migration, restart at every durable boundary, abrupt kill, invalid state, reconciliation, and recovery time                                                             |
| Transport and backpressure           | frame size/count, subscription count, queue depth, slow/stalled consumers, disconnect storms, heartbeat failure, duplicate delivery, cursor catch-up, and bounded memory                                        |
| Lifecycle and resources              | repeated start/stop, initialization failure, SIGINT/SIGTERM/SIGKILL, leaked fibers/listeners/sockets/files, finalizer failure, and long soak with stable idle resources                                         |
| Rika framework boundary              | public exports, Layers, configuration, typed errors, testing layers, observability, upgrades, and every place Rika duplicates or understands Baton/Relay internals                                              |

For every axis, use a progression such as `1, 10, 100, 1,000, 10,000, ...` where valid. Record the largest passing point, first failing point, failure shape, recovery behavior, and resource curve. Add cross-product runs for the highest-risk combinations. Use bounded host controls so a failed test cannot consume all disk, memory, processes, or network indefinitely.

Compare Rika and installed Amp at identical dimensions for shared visual and interaction paths. Amp is the visual baseline, not a source-code dependency. Do not claim parity from synthetic frames alone.

## Continuous Orchestration Model

The main autoresearch agent is the coordinator and sole owner of the Rika stress loop. It must keep testing Rika rather than disappearing into framework implementation.

```text
Rika stress run
      │
      ▼
Observed failure ──▶ evidence + owner + GitHub issue
                              │
                              ▼
                     isolated fixer subagent
                     in owner-repo worktree
                              │
                              ▼
                     review + owner tests
                              │
                              ▼
                     merge directly to main
                              │
                              ▼
              release framework package if needed
                              │
                              ▼
                 repin/rebuild packaged Rika
                              │
                              ▼
                   rerun original Rika stress case
                              │
                              ▼
                    close issue with evidence
```

- Keep one coordinator-owned issue ledger and merge queue across all three repositories.
- Spawn one fixer subagent per independent issue. Give it the reproduction, evidence paths, first-principles design, owner, exact worktree, acceptance checks, and non-goals.
- Create a dedicated branch and worktree in the owning repository for every fixer. Never use the read-only Rika submodules as write targets.
- Allow parallel research and fixes only when worktrees and ownership are disjoint. Serialize overlapping changes and every merge to `main`.
- Fixers implement and verify. They do not redefine ownership or quietly add a Rika workaround; the coordinator decides those from the evidence and Effect research.
- Require an independent review subagent or Oracle to inspect each completed worktree against the issue and repository architecture before merge.
- Merge verified worktrees directly into the owning repository's `main` without a GitHub pull request. Use ordinary non-history-rewriting merges, preserve reviewable commits, rerun required checks, and push the verified `main` through the repository's normal protected remote workflow.
- After merge, rerun that repository's required gates on `main`. For Baton or Relay, publish through the repository's release workflow, restore Rika to registry dependencies, repin the released version, and rerun the packaged Rika reproduction.
- Remove the worktree and branch only after merge and integration proof. Never delete another agent's active worktree or unmerged work.
- Close the issue only after owner-repository proof and, when the issue affects Rika, final packaged Rika proof. If verification fails, return it to the queue with the new evidence.
- Continue discovering Rika issues while independent fixers run. Apply backpressure: do not spawn more fixer agents than can be reviewed, merged, and integrated safely.

## Required Autoresearch Loop

### 1. Establish a clean, reviewable baseline

- Read `AGENTS.md`, `CONTEXT.md`, `SPEC.md`, `PLAN.md`, `TODO.md`, `docs/features/FEATURES.md`, `docs/spec/11-tui.md`, `docs/spec/15-testing.md`, and `docs/spec/16-observability.md`.
- Preserve unrelated worktree changes. Record the starting revision and dirty paths; never revert work you did not create.
- Run `bun run upstream:status` and record the installed Baton, Relay, Effect, OpenTUI, and Bun versions.
- Snapshot every open issue, label, milestone, linked pull request, release, and relevant closed duplicate in `dallenpyrah/rika`, `In-Time-Tec/batonfx`, and `In-Time-Tec/relayfx`. Record the issue number, current claim, acceptance criteria, dependencies, likely owner, and whether the report can be proved through Rika.
- Turn the snapshot into one dependency-ordered issue queue. Correct labels, ownership, title, description, reproduction, and acceptance criteria before implementation when they are stale or unclear.
- Build and install the packaged Rika binary through the repository-supported path.
- Load and follow `debugging-rika`, `testing-with-pilotty`, and `testing-with-agent-tty` before using those workflows.

### 2. Capture the baseline

- Define deterministic scripts for every stress-matrix row and fixed terminal sizes including `50x10`, `80x24`, and `120x32`.
- Use Pilotty for fast repeated interaction and semantic snapshots.
- Use agent-tty for Ghostty-backed final screenshots, recordings, and reviewer-facing evidence.
- Build a focused clean external-consumer Baton or Relay reproduction only when a Rika-observed failure must be isolated from product code. Exercise only public exports and the released package contract Rika uses.
- Ramp each independent axis to its first failure or safety ceiling, then run long soaks and high-risk combined loads. Run enough repetitions to expose growth over time and tail latency. Do not use blind sleeps; wait for observable state with bounded deadlines.
- Capture diagnostics, terminal snapshots, recordings, process metrics, durable state summaries, filesystem outcomes, and command exit results.
- Produce one baseline report ranking correctness failures, capacity limits, bottlenecks, framework usability problems, and existing issues by impact and confidence.

### 3. Diagnose the next highest-impact issue or finding

- Start with `rika diagnostics status`, `rika diagnostics path`, and a private diagnostics export.
- For Baton and Relay harness failures, begin with their public error, event, logging, tracing, metrics, test, and durable inspection interfaces. A framework that requires consumers to read private tables or source to diagnose normal failure needs an upstream interface issue.
- Correlate the newest client and resident JSONL logs by process, connection, request, Thread, Turn, Execution, event, and tool-call identifiers.
- Trace the last fast boundary and the first slow, missing, duplicated, failed, or unrecovered boundary.
- Inspect the implementation only after the observed boundary narrows the owner.
- For complex cross-module behavior, use code search agents in parallel. For a subtle design or fix, ask Oracle to challenge the diagnosis and proposed correction.
- State facts, conclusions, assumptions, and missing evidence separately.

### 4. Improve observability when diagnosis is blocked

Add the smallest permanent signal that would have made the failure clear:

- stable named events and safe correlation identifiers;
- start/end duration pairs around meaningful boundaries;
- queue depth, event count, frame/update count, payload byte count, and state-transition metadata;
- typed failure kind and recovery outcome;
- aggregate or sampled hot-path metrics instead of one log per render delta, keypress, token, or row.

Logging must be Effect-native, lazy, bounded, non-blocking with an explicit policy, and cheap enough not to become the problem being measured. Preserve the security rules in `docs/spec/16-observability.md`: never log prompts, model bodies, tool arguments/results, shell text/output, arbitrary error strings, headers, credentials, or secrets. Prove log rotation, flush, abrupt-exit behavior, and private permissions when changed.

Rerun the reproduction after adding diagnostics. Observability work is incomplete until it identifies the boundary or disproves the current theory.

### 5. Derive the Effect-native fix and owner from first principles

- For Effect-related behavior, inspect current `repos/effect` patterns first, then the pinned installed source, types, tests, and exports in `node_modules` for compile-time truth.
- For Baton or Relay behavior, inspect current read-only upstream source first, then the installed pinned package for the contract Rika actually compiles against.
- Check OpenTUI's installed source and tests before working around renderer behavior.
- Start from the required invariant and public consumer journey, not the current implementation or a suggested patch. Decide where state lives, who owns the resource, which service or Layer provides it, how scopes end, how interruption propagates, how errors remain typed, how concurrency and buffering are bounded, how replay/idempotency work, and how a consumer proves the result.
- Search Effect for the existing data type, service, Layer pattern, Scope pattern, concurrency primitive, Stream/Channel/Sink operator, Schedule, SQL integration, logging/tracing/metrics interface, test service, and platform boundary before creating anything local.
- Record each accepted principle in an Effect-native practices catalog. Each entry must include: observed problem; invariant; authoritative Effect source and pinned API evidence; correct Effect-native pattern; anti-pattern being removed; owner (`Rika`, `Baton`, `Relay`, `Effect`, `OpenTUI`, or external); public contract change; migration/release path; tests; and downstream code that becomes unnecessary.
- Put product-only interaction and policy in Rika. Put reusable agent-loop behavior in Baton. Put reusable durable execution and recovery behavior in Relay. If Rika must understand framework internals to use or diagnose a normal path, improve the framework interface instead.
- Prefer deleting repeated work, reducing invalidation, bounding retained state, coalescing updates, incremental projection, indexed lookup, shared runtime resources, structured concurrency, and correct ownership over adding caches or debounce delays.
- Check that an optimization preserves ordering, durable replay, actionable events, terminal convergence, visual output, selection, and accessibility.

### 6. Maintain and close the complete GitHub issue inventory

The issue queue includes every issue open at the starting snapshot and every finding discovered during Rika stress testing in:

- `dallenpyrah/rika`
- `In-Time-Tec/batonfx`
- `In-Time-Tec/relayfx`

The coordinator does not turn unrelated Baton or Relay issues into a separate framework stress campaign. It dispatches those existing issues to framework fixer subagents using their own reproductions and acceptance criteria, while the coordinator continues the Rika stress loop. New Baton and Relay issues must come from concrete Rika evidence or a focused reduction of that evidence.

For every queue item:

1. Search open and closed issues first:
   - `gh issue list --repo dallenpyrah/rika --state all --search '<terms>'`
   - `gh issue list --repo In-Time-Tec/batonfx --state all --search '<terms>'`
   - `gh issue list --repo In-Time-Tec/relayfx --state all --search '<terms>'`
2. Reproduce or disprove the current report. Update the existing issue with safe findings, corrected ownership, dependencies, the first-principles design, planned acceptance checks, and progress. Do not leave stale descriptions to mislead later work.
3. If no issue exists, create one in the owning repository. The issue must include:
   - observed user or framework-consumer impact;
   - minimal reproduction using the public released API;
   - affected and tested versions;
   - expected and actual behavior;
   - logs, timings, or durable-state evidence with secrets and content removed;
   - why the concern belongs upstream;
   - the public contract or design improvement requested;
   - acceptance checks and compatibility concerns;
   - the Rika or downstream workaround or duplication it would remove, if any.
4. Link duplicates instead of creating a second issue.
5. Do not file speculative cleanup ideas. A design issue must show concrete downstream complexity, cost, failure risk, or missing capability.
6. Do not paste private diagnostics, prompts, model output, credentials, local absolute paths, or user data into GitHub.
7. Dispatch the resolution to an isolated fixer subagent in the owning repository. For Baton or Relay, use their real source repository or a clean clone, never Rika's read-only submodule.
8. Close the issue only when one of these outcomes is proved and recorded:
   - **Fixed:** regression tests pass in the owner; full owner gates pass; the change is merged; framework changes are released; Rika consumes the release when affected; and the original reproduction passes.
   - **Duplicate:** the main issue is linked and contains the complete acceptance criteria and evidence.
   - **Not reproducible:** tested versions, exact attempts, and evidence are recorded, and Oracle agrees that no remaining claim is actionable.
   - **Invalid or out of scope:** the owning contract and reason are clear, the correct destination is linked when one exists, and no user-facing failure is being hidden.
9. Never close an issue merely because code was written, a local test passed, it is old, or it is inconvenient. Reopen it if release or packaged-consumer verification disproves the resolution.

Maintain this table in the research record:

| Issue | Starting state | Owner | Reproduction | First-principles design | Dependencies | Fix/release | Consumer proof | Final state |
| ----- | -------------- | ----- | ------------ | ----------------------- | ------------ | ----------- | -------------- | ----------- |

Creating, correcting, commenting on, labeling, and closing Rika, Baton, and Relay issues is part of this mandate. Verified fixes are merged directly from their worktrees into the owning repository's `main`; do not open GitHub pull requests for this loop. Use each repository's required checks and release workflow. Do not rewrite history, bypass protections, expose secrets, or make an unreviewed breaking release.

### 7. Implement and verify the fix

- The coordinator prepares the issue, ownership decision, Effect research, and acceptance contract, then delegates implementation to one fixer subagent with a dedicated worktree.
- Update the owning spec before changing public behavior or contracts. Amend an ADR for a stable architecture decision.
- Use Effect-native APIs and local module patterns. Do not introduce `async`, `await`, raw `Promise`, direct timers, unscoped resources, unbounded queues, detached fibers, broad error erasure, or raw platform APIs when Effect owns the concern.
- Add a regression test that fails for the observed reason. Add a benchmark or deterministic performance check only when it is stable enough for automation.
- Keep visual output unchanged unless the evidence proves a visual bug; then update the approved visual evidence intentionally.
- Run the narrowest useful tests first, then the affected package suite, packaged workflow, and complete gates when the blast radius requires them.
- Review the changed code for unnecessary renders, repeated parsing/formatting, full-history copies, quadratic scans, synchronous hot-path I/O, duplicated subscriptions, leaked listeners/fibers, unbounded retention, SQL polling, retry storms, event amplification, and per-request runtime construction.
- Have a separate reviewer inspect the worktree. Resolve every high-confidence finding, rerun checks, merge the reviewable commits directly into the owner repository's `main`, and verify `main` before integration.

### 8. Repeat the exact workload

- For a Baton or Relay fix, publish the verified `main` version through its normal release process and repin Rika to that released package. Never leave Rika depending on a worktree, source checkout, local tarball, or unpublished version.
- Rebuild and reinstall the packaged Rika binary.
- Use a fresh isolated state directory and the same workload and capture settings.
- Compare before and after with all samples, including failures and regressions.
- Keep a change only when it fixes correctness or provides a repeatable performance gain without violating ownership or durability.
- If the theory is disproved, preserve the evidence, remove temporary instrumentation, return the issue to the queue, and investigate the next boundary.

### 9. Continue by impact

Rank the next iteration by:

1. data loss, incorrect execution, or unrecoverable command failure;
2. TUI freeze, terminal corruption, resident failure, or lost connection;
3. input, scroll, render, replay, or command tail latency;
4. unbounded CPU, memory, event, queue, log, or database growth;
5. visual mismatch or interaction defect;
6. unnecessary downstream complexity caused by Baton or Relay contracts.

Do not spend time on tiny microbenchmark gains while a long-session failure remains.

## Required Research Record

Keep an append-only record under `artifacts/autoresearch/` with:

- baseline and final environment manifests;
- workload definitions and exact commands;
- raw and summarized timings;
- semantic snapshots, screenshots, and recordings;
- redacted relevant log excerpts and correlation map;
- problem catalog with reproduction rate, owner, severity, status, and evidence paths;
- Effect-native practices catalog with source evidence, invariant, owner, public contract, and downstream code removed;
- change ledger with hypothesis, fixer agent, repository, branch, worktree, commits, reviewer, merge, release, tests, before/after result, and decision to keep or revert only your own change;
- complete Rika/Baton/Relay issue catalog with GitHub URLs and final states;
- remaining risks, blockers, and the exact next experiment.

Update `TODO.md` and `docs/features/FEATURES.md` only when their owned status actually changes. Do not turn `TASK.md` into the run log.

## Verification Gates

Use focused checks during each loop. Before final sign-off run:

- Run every changed Baton or Relay repository's own required focused and full gates before and after merging its fixer worktree into `main`.
- Prove every released framework fix first through a clean public-package consumer, then through the original packaged Rika workload.
- Run Rika's gates below against registry dependencies only.

```bash
bun run docs:check
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run test:agent-harness
bun run test:e2e
bun run build
bun run package:construct:test
bun run package:smoke
```

Also complete:

- the full maximum-stress matrix against the packaged Rika binary;
- Pilotty semantic runs at fixed dimensions;
- agent-tty snapshots, PNGs, and a long-session recording;
- an installed Amp comparison for shared visual flows;
- kill/restart and reconnect checks for every touched durable or transport boundary;
- final diagnostics review showing no unexplained errors, queue overflow, repeated reconnect, leaked work, or missing terminal state;
- an Oracle review of all merged diffs, performance evidence, Effect-native catalog, issue states, and residual risks.

## Completion Gate

Stop only when all are true:

- The baseline and final packaged runs are directly comparable and retained.
- Every Rika stress workload reaches a documented passing capacity and completes its soak, or has a documented external blocker.
- No reproduced Rika-owned correctness bug remains unresolved in the evaluated paths.
- Long-session input, scroll, streaming, command, replay, reconnect, and shutdown remain responsive under the largest recorded workload.
- CPU, memory, queue, event, log, and database growth are bounded or explicitly justified by retained user-visible state.
- Every accepted optimization has repeatable before-and-after evidence and a regression check appropriate to its risk.
- Visual behavior matches the TUI contract and Amp baseline for shared surfaces.
- Diagnostics can identify each important boundary and recovery result without unsafe or high-volume content.
- Every Rika finding is assigned to Rika, Baton, Relay, Effect, OpenTUI, or another external owner from first principles.
- Every Rika, Baton, or Relay issue in the autoresearch queue is closed with a proved fixed, duplicate, not-reproducible, or invalid/out-of-scope resolution. A blocked issue remains open and prevents full completion.
- Every fixer worktree was independently reviewed, merged directly into the owning repository's `main`, verified on `main`, and safely removed after integration.
- Every merged Baton or Relay fix is released and consumed through Rika's registry-only dependency path.
- Rika contains no new upstream workaround unless the upstream gap is documented, the workaround is bounded and tested, and its removal condition is recorded.
- All required verification gates pass.
- Oracle explicitly signs off on correctness, performance evidence, ownership, and remaining risks.

If blocked, keep the issue open and leave a resumable record containing the exact failing command, safe error evidence, affected Rika workload, owner, repository, branch/worktree state, last completed step, issue links, and next experiment. Lack of time is not evidence that the system is complete.
