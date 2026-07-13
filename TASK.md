# Peach Efficiency Evaluation

## Mandate

Repeatedly drive the packaged Rika TUI in isolated temporary directories and have it build a complete Effect API for processing and managing orders at a local grocery market. Prompt Rika to use subagents and exercise the full coding-agent workflow: research, architecture, implementation, tests, documentation, verification, recovery, and review.

Do not stop at the first successful run. Repeat the same evaluation, measure each run, inspect every visible and durable failure, fix defects in their owning repository, publish framework fixes when required, repin Rika to published packages, and rerun until no visible bugs remain.

## Required Evaluation Loop

1. Create a fresh isolated temporary workspace, HOME, Rika database, and Relay database.
2. Run the packaged `rika` binary through the TUI acceptance harnesses at fixed terminal dimensions.
3. Ask Rika to design and build the complete grocery-order Effect API and to use subagents wherever useful.
4. Capture semantic snapshots, screenshots, recordings, event streams, database state, wall-clock duration, tool counts, model turns, child runs, failures, retries, cache reads, cache writes, and resulting repository state.
5. Catalog every failure with its exact location, reproduction evidence, user impact, recovery behavior, and owner: Rika, Relay, Baton, provider, dependency, model behavior, generated project, or evaluation harness.
6. Before fixing each product defect:
   - ground the plan in authoritative source research through Librarian;
   - compare relevant approaches in OpenCode, OpenAI Codex CLI, Claude Code, and Pi;
   - adapt the best applicable mechanism to Effect-native Baton, Relay, and Rika ownership boundaries;
   - ask Oracle for a concrete implementation plan.
7. Implement the smallest correct fix in the owning repository, add a regression test, and verify it locally.
8. Ask Oracle to review the implementation against its plan and the framework's intended architecture.
9. Iterate implementation and review until Oracle signs off on the issue.
10. Publish upstream package fixes when required, consume only published Baton and Relay versions in Rika, rebuild the packaged binary, and rerun the same evaluation from a fresh temporary directory.
11. Continue until the final Oracle reviews the complete evidence and signs off on the original mandate.

## Peach Efficiency

Peach efficiency means:

- Relay, Baton, and Rika do not obstruct the coding agent.
- Ordinary model and tool failures remain recoverable, observable inputs to the agent loop rather than terminal dead ends.
- Child failures always reach a terminal durable state and never leave a parent parked indefinitely.
- There are no implicit tool-turn or subagent-count limits; explicit consumer policy remains possible.
- Prompt prefixes, tool schemas, project instructions, and other stable inputs maximize provider prompt-cache reuse.
- Volatile context is appended late and does not unnecessarily invalidate stable cache prefixes.
- Large canonical tool results remain durable and retrievable while bounded projections enter model context.
- Subagent isolation reduces parent-context growth without hiding errors or losing inspectable results.
- Every run is timed and compared, with bottlenecks attributed to model latency, tool latency, framework overhead, process startup, persistence, context growth, or inefficient tooling.
- Tooling is improved where evidence shows meaningful gains, including faster search, narrower reads, parallel independent work, and fewer unnecessary model round trips.
- The generated project is complete, correct, tested, documented, and reviewable rather than merely present.
- No visible bugs remain in the evaluated path.

## Engineering Standard

Leave Rika, Relay, and Baton better than they were found, but make only evidence-backed improvements. During each investigation, identify opportunities to simplify ownership, reduce indirection, improve naming, strengthen single responsibility, remove shallow abstractions, deepen useful modules, improve Effect-native composition, add typed errors, improve logging and observability, and strengthen tests. Do not perform speculative cleanup or unrelated refactors. Every change must protect an observed invariant, remove demonstrated complexity, or close a verified coverage gap.

Respect framework ownership:

- Baton owns the non-durable model/tool loop, provider protocol, model-visible tool failures, and prompt/cache construction.
- Relay owns durable execution, child runs, fan-out, waits, joins, cancellation, replay, and terminal propagation.
- Rika owns product policy, coding tools, repository behavior, CLI/TUI presentation, and user-facing recovery controls.

Use fresh child contexts by default, explicit forks only when inherited conversation is required, durable artifacts for large outputs, and one writer per workspace unless writers use isolated worktrees.

## Completion Gate

Completion requires all of the following:

- Multiple comparable fresh-workspace evaluation runs are recorded.
- The final grocery-order API run completes through the packaged TUI.
- The final generated project passes its own verification.
- Every observed failure is cataloged and resolved, explicitly classified as expected model behavior with proven recovery, or documented as an external residual risk.
- All Rika verification gates pass.
- Every upstream fix is released and Rika uses the published version without local development links.
- Oracle has reviewed every defect plan, reviewed every implementation, and signed off after required iterations.
- A final Oracle reviews the complete original mandate, implementation history, measurements, evidence, and residual risks and explicitly signs off that the work is complete.

## Evaluation Record

| Run | Workspace                      | Result                                                                             | Classification                                                                                           | Evidence                                                                                          |
| --- | ------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | `/tmp/rika-peach-run-1.zqCGIc` | Provider authentication failed under an isolated HOME                              | Harness configuration                                                                                    | Run database and prompt                                                                           |
| 2   | `/tmp/rika-peach-run-2.obfNXH` | `web_search.searchQueries` used a tuple-like object and failed Effect AI decoding  | Rika model-facing schema ambiguity; generic malformed-call recovery remains blocked in Effect AI beta.93 | `evidence/02-invalid-tool-schema.txt`, `evidence/failure-events.txt`, `relay.db`                  |
| 3   | `/tmp/rika-peach-run-3.T4Lhi0` | `spawn_child_run.output_schema_ref: null` failed before tool execution             | Relay model-facing adapter                                                                               | `relay.db`                                                                                        |
| 4   | `/tmp/rika-peach-run-4.QTWCif` | `spawn_child_run.metadata` used tuple-like data and failed before tool execution   | Relay model-facing adapter                                                                               | `evidence/01-spawn-metadata-schema-failure.json`, `evidence/02-tui-terminal.txt`, `relay.db`      |
| 5   | `/tmp/rika-peach-run-5.SFnaHD` | Librarian child completed and parent resumed, then `preset_name: null` failed      | Relay model-facing adapter                                                                               | `evidence/01-null-preset-terminal.txt`, `evidence/02-null-preset-events.json`, `relay.db`         |
| 6   | `/tmp/rika-peach-run-6.hwg5HE` | Packaged 0.2.10 launch reached a canonical retryable provider `InvalidKey` failure | External OpenRouter credential (`/api/v1/auth/key` returned `401 User not found`)                        | `evidence/00-welcome.txt`, `evidence/01-started.txt`, `evidence/02-retry-started.txt`, `relay.db` |
| 7   | `/tmp/rika-peach-run-7.9jqNI9` | First deterministic TUI turn completed; later expected markers shifted             | Evaluation fixture omitted the automatic title-generation response                                       | `evidence/agent-tty/01-wait.json`, `evidence/agent-tty/02-wait.json`, `relay.db`                  |
| 8   | `/tmp/rika-peach-run-8.qPFozH` | All four requested packaged TUI turns completed durably                            | Passing deterministic acceptance after fixed-selection correction                                        | `evidence/agent-tty/*-wait.json`, `evidence/agent-tty/executions.txt`, `relay.db`                 |

Completed and Oracle-signed-off corrections:

- Baton 0.4.2 preserves completed sibling tool results when another sibling suspends into a durable child run.
- Relay 0.2.7 consumes Baton 0.4.2, keeps agent turns unbounded by default, and tolerates null child model overrides.
- Relay 0.2.8 tolerates null model-facing child output-schema overrides while retaining the strict programmatic contract.
- Rika uses published Baton packages, presents `web_search.searchQueries` as a homogeneous non-empty string array, projects canonical Relay terminal failure detail, deduplicates synthetic failure presentation, and reconciles deterministic executions when start throws after persistence.
- Relay 0.2.9 removes free-form durable metadata from the model-facing child-spawn schema while preserving the programmatic metadata contract and runtime-derived correlation metadata. It is published and pinned through Rika's registry-only dependency path.
- Relay 0.2.10 treats model-facing `preset_name: null` as omission while retaining strict programmatic and durable contracts. Librarian research, Oracle planning, implementation review, focused tests, full Relay verification, publication, registry-only Rika repinning, and Oracle sign-off are complete.
- Relay 0.2.10 also removes the undocumented 1,000-event cap from streams without an explicit limit. Repository catch-up remains paginated and explicit finite limits remain bounded, while long parent and child executions retain their canonical terminal event and exact failure or output payload. Librarian research, Oracle planning, implementation review, regression coverage, full Relay verification, and Oracle sign-off are complete.
- Installed-package native acceptance on Relay 0.2.10 proves that a top-level execution preserves its canonical failure after 260 tool turns and more than 1,000 events, and that a child with more than 1,000 events reaches durable `completed` state and allows its parent to synthesize the result. Rika's full test, typecheck, format, lint, docs, build, package smoke, registry restoration, package construction, and local installation gates pass.
- Relay 0.2.11 rejects child fan-outs when the client lacks the fan-out runtime instead of persisting inert queued work. Rika consumes the published package through the registry-only installation path.
- Deterministic packaged model fixtures now declare fixed model selection explicitly, so the TUI's default reasoning effort does not synthesize an unregistered variant key. Production registrations retain exact effort and fast-mode lookup. The focused adapter suite, full typecheck, static gates, package smoke, installation, and a fresh agent-tty run of all four requested prompts pass; Oracle signed off without changes.

The next required live run is blocked on a valid model-provider credential. The additional requested TUI workflows pass deterministically, but completion criteria remain open until the grocery project finishes against a live coding model, its generated project passes verification, and final Oracle review signs off.
