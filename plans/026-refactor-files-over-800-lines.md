# Plan 026: Refactor every code file over 800 lines

## Goal

After this work:

- every maintained TypeScript, JavaScript, shell, SQL, and Python code file under `apps/`, `packages/`, `scripts/`, and `test/` is at most 800 physical lines after formatting;
- capability folders use a local `index.ts` façade, so `@rika/tui/adapter` resolves to `packages/tui/src/adapter/index.ts` and there is no sibling `adapter.ts`;
- the same folder rule applies to operation, operation contract, usage cost, Relay execution backend, ViewState, persistence repositories, database, process entrypoints, and resident transports;
- public package specifiers, wire schemas, database migrations, durable execution behavior, process boundaries, Effect scopes, and terminal behavior remain unchanged; and
- tests are organized by the capability they prove, with broad TUI and process coverage retained.

This is an ownership refactor, not a product redesign. The 800-line ceiling is a backstop, not permission to create arbitrary 799-line files.

## Baseline and drift rule

The working tree is already replacing `apps/rika/src/main.ts` with private client, interactive, resident, and performance entrypoints. That work must be settled before this plan starts. Do not revive the old `main.ts` layout from GitHub epic #181.

At the inventory snapshot, 32 code files exceed 800 physical lines: 14 source files and 18 test or executable-fixture files. Counts are expected to drift while the current work lands.

### Source baseline

| Lines | File                                                        |
| ----: | ----------------------------------------------------------- |
| 6,213 | `packages/app/src/operation.ts`                             |
| 4,392 | `packages/tui/src/adapter.ts`                               |
| 2,681 | `packages/runtime/src/execution-backend.ts`                 |
| 2,324 | `packages/tui/src/view-state.ts`                            |
| 1,982 | `apps/rika/src/interactive-main.ts`                         |
| 1,734 | `apps/rika/src/resident-main.ts`                            |
| 1,254 | `packages/persistence/src/turn-repository.ts`               |
| 1,229 | `apps/rika/src/resident-client-transport.ts`                |
| 1,173 | `packages/transcript/src/index.ts`                          |
| 1,162 | `apps/rika/src/resident-host-transport.ts`                  |
|   936 | `packages/app/src/usage-cost.ts`                            |
|   930 | `packages/persistence/src/product-database.ts`              |
|   910 | `packages/persistence/src/thread-interaction-repository.ts` |
|   820 | `packages/app/src/operation-contract.ts`                    |

### Test and executable-fixture baseline

| Lines | File                                                         |
| ----: | ------------------------------------------------------------ |
| 5,601 | `packages/app/test/operation.test.ts`                        |
| 3,614 | `packages/tui/test/opentui-adapter.test.ts`                  |
| 2,538 | `packages/app/test/interactive-session.test.ts`              |
| 2,475 | `packages/tui/test/adapter.test.ts`                          |
| 2,353 | `packages/runtime/test/execution-backend.test.ts`            |
| 1,919 | `apps/rika/test/interactive-controller.test.ts`              |
| 1,898 | `packages/transcript/test/projection.test.ts`                |
| 1,768 | `packages/tui/test/view-state.test.ts`                       |
| 1,606 | `packages/app/test/operation-interactive-extensions.test.ts` |
| 1,597 | `packages/runtime/test/execution-backend-relay.test.ts`      |
| 1,374 | `packages/app/test/usage-cost.test.ts`                       |
| 1,371 | `packages/persistence/test/sqlite.test.ts`                   |
| 1,177 | `packages/runtime/test/subagent-spawn.test.ts`               |
| 1,097 | `packages/persistence/test/turn-repository.test.ts`          |
| 1,048 | `packages/tui/test/execution-events.test.ts`                 |
|   949 | `apps/rika/test/test-model-script.test.ts`                   |
|   866 | `packages/persistence/test/transcript-repository.test.ts`    |
|   821 | `apps/rika/test/fixtures/resident-client.ts`                 |

Before executing a slice:

1. start from a clean tree containing the completed private-runtime split;
2. run `bun run format` and commit formatting separately if it changes the baseline;
3. regenerate the complete `> 800` inventory, including untracked code files but excluding `.git`, `node_modules`, `repos`, `.turbo`, `artifacts`, `dist`, `coverage`, documentation, and generated visual/data fixtures;
4. add any newly oversized code file to the nearest ownership slice; and
5. stop if an in-flight feature or correctness change overlaps the same owner. Land that behavior change and its tests first, then rebase this plan.

## Non-negotiable design rules

### Folder façades

A promoted capability is a folder with one local façade:

```text
before                         after
src/adapter.ts                 src/adapter/index.ts
src/operation.ts               src/operation/index.ts
src/execution-backend.ts       src/execution-backend/index.ts
src/view-state.ts              src/view-state/index.ts
```

There must not be both `name.ts` and `name/index.ts`. Use `git mv` when the original file becomes the façade so history is retained.

Package specifiers stay stable by changing export targets, not consumers:

```json
{
  "./operation": "./src/operation/index.ts",
  "./operation-contract": "./src/operation-contract/index.ts",
  "./relay": "./src/execution-backend/index.ts",
  "./adapter": "./src/adapter/index.ts",
  "./database": "./src/product-database/index.ts",
  "./turn-repository": "./src/turn-repository/index.ts",
  "./thread-interaction-repository": "./src/thread-interaction-repository/index.ts"
}
```

Root namespace exports such as `Operation`, `UsageCost`, `ViewState`, `Database`, and `TurnRepository` must likewise point at their directory façades while retaining the same names. `packages/transcript/src/index.ts` is already the package-root façade. It stays in place and becomes a thin, explicit façade over `src/projection/`.

### Dependency direction

- A child module imports sibling contracts or leaves directly. Nothing inside a capability folder imports its own `index.ts`, `.`, or `..` façade. Imports of a parent leaf such as `../contract` remain valid; the guard targets only imports that resolve to that capability's own index.
- Every `index.ts` explicitly exports names and types. Do not use `export *` in a new capability façade. Existing root namespace exports may continue to expose a folder as a namespace, but each folder façade enumerates its own public names.
- Moving a private symbol into another file does not make it public. Export it only between internal leaves, and omit it from the folder façade.
- Preserve all `Context.Service` identifier strings, tagged-error names, schema tags, optional keys, union members, and public function signatures.
- Keep SQL in `@rika/persistence`, Relay/Baton adaptation in `@rika/runtime`, product semantics in `@rika/app`, process composition in `apps/rika`, and OpenTUI imports under `packages/tui/src/adapter/**` only.
- Do not introduce `utils`, `helpers`, `common`, `shared`, or `lib` modules.
- Keep pure computations pure. Keep Effect acquisition, interruption, finalizers, queues, semaphores, fibers, and scopes with their current owner.

### Tests

- Split an oversized characterization suite before moving the source it protects. That test-only commit must keep the same assertions and test count.
- Tests should mirror ownership, but do not create shared test barrels. Extract support only when it has a narrow domain name such as `operation-test-layer.ts`, `relay-backend-harness.ts`, `opentui-surface-harness.ts`, or `sqlite-product-harness.ts`.
- Every resulting test and support file must be at most 800 physical lines.
- Keep `.tui.test.ts` and `.proc.test.ts` suffixes. Splitting them must not move behavior into the unit project or add new test commands.
- Do not replace deterministic assertions with snapshots. Existing visual fixtures must remain byte-identical unless a separate product change intentionally updates them.

## Target source tree

The exact leaf count may change during extraction, but the ownership and façades below are fixed. If a proposed leaf would still exceed 800 lines, divide it by the next real capability boundary before merging.

```text
packages/app/src/
├── operation/
│   ├── index.ts
│   ├── errors.ts
│   ├── options.ts
│   ├── auth.ts
│   ├── product-layer.ts
│   ├── execution-reconciliation.ts
│   ├── execution-tree.ts
│   ├── execution-lifecycle.ts
│   ├── transcript-bounds.ts
│   ├── transcript-repair.ts
│   ├── usage-projection.ts
│   ├── title-service.ts
│   ├── context-preparation.ts
│   ├── thread-results.ts
│   ├── test-layer.ts
│   ├── interactive/
│   │   ├── index.ts
│   │   ├── event-feed.ts
│   │   ├── session.ts
│   │   ├── submission.ts
│   │   ├── queue-promotion.ts
│   │   ├── child-followers.ts
│   │   ├── selection.ts
│   │   ├── selection-repair.ts
│   │   └── controls.ts
│   └── dispatch/
│       ├── index.ts
│       ├── run.ts
│       ├── review.ts
│       ├── workflow.ts
│       ├── migration.ts
│       └── thread.ts
├── operation-contract/
│   ├── index.ts
│   ├── input.ts
│   ├── errors.ts
│   ├── service.ts
│   └── interactive/
│       ├── index.ts
│       ├── queue.ts
│       ├── event.ts
│       ├── event-schema.ts
│       ├── command.ts
│       └── session.ts
└── usage-cost/
    ├── index.ts
    ├── contract.ts
    ├── snapshot-codec.ts
    ├── totals.ts
    ├── active-time.ts
    ├── attempt-ledger.ts
    ├── observation.ts
    ├── history-reader.ts
    └── rebuild.ts

packages/runtime/src/execution-backend/
├── index.ts
├── options.ts
├── errors.ts
├── model-registry.ts
├── model-routing.ts
├── tool-runtime.ts
├── identifiers.ts
├── event-mapping.ts
├── child-results.ts
├── execution-follow.ts
├── execution-tree.ts
├── recovery.ts
├── client-layer/
│   ├── index.ts
│   ├── thread-host.ts
│   ├── fan-out.ts
│   ├── workflows.ts
│   ├── children.ts
│   ├── executions.ts
│   └── approvals.ts
└── embedded/
    ├── index.ts
    ├── prompt-recovery.ts
    ├── delegation.ts
    ├── tools.ts
    ├── fan-out-host.ts
    └── workflow-host.ts

packages/transcript/src/
├── index.ts
└── projection/
    ├── index.ts
    ├── state.ts
    ├── identifiers.ts
    ├── diff-files.ts
    ├── tool-input.ts
    ├── tool-events.ts
    ├── child-events.ts
    ├── model-events.ts
    ├── generic-events.ts
    ├── settlement.ts
    └── nesting.ts

packages/persistence/src/
├── product-database/
│   ├── index.ts
│   ├── errors.ts
│   ├── migration-history.ts
│   ├── schema-manifest.ts
│   ├── inspection.ts
│   ├── preflight.ts
│   ├── layer.ts
│   └── migrations/
│       ├── 001-product-baseline.ts
│       ├── 002-turns.ts
│       ├── ...
│       └── 022-reconciled-child-trees.ts
├── turn-repository/
│   ├── index.ts
│   ├── contract.ts
│   ├── errors.ts
│   ├── pagination.ts
│   ├── queue-state.ts
│   ├── memory/
│   │   ├── index.ts
│   │   └── state.ts
│   └── sqlite/
│       ├── index.ts
│       ├── row-codec.ts
│       └── queue-transactions.ts
└── thread-interaction-repository/
    ├── index.ts
    ├── contract.ts
    ├── errors.ts
    ├── admission-policy.ts
    ├── result-readiness.ts
    ├── relationship-pagination.ts
    ├── memory/index.ts
    └── sqlite/
        ├── index.ts
        └── row-codec.ts

packages/tui/src/
├── view-state/
│   ├── index.ts
│   ├── model.ts
│   ├── messages.ts
│   ├── activity.ts
│   ├── usage.ts
│   ├── loadable.ts
│   ├── layout.ts
│   ├── queue.ts
│   ├── prompt-parts.ts
│   ├── composer.ts
│   ├── thread-navigation.ts
│   └── reducer/
│       ├── index.ts
│       ├── data-events.ts
│       ├── execution-events.ts
│       ├── transcript-events.ts
│       ├── keyboard.ts
│       ├── overlays.ts
│       └── queue-input.ts
└── adapter/
    ├── index.ts
    ├── contract.ts
    ├── errors.ts
    ├── spinner.ts
    ├── render-block.ts
    ├── changed-files.ts
    ├── welcome.ts
    ├── renderer.ts
    ├── transcript/
    │   ├── index.ts
    │   ├── bounds.ts
    │   ├── units.ts
    │   ├── cache.ts
    │   └── renderables.ts
    ├── surface/
    │   ├── index.ts
    │   ├── construction.ts
    │   ├── viewport.ts
    │   ├── input.ts
    │   ├── sidebar.ts
    │   ├── update.ts
    │   └── lifecycle.ts
    └── overlays/
        ├── index.ts
        ├── shortcuts.ts
        ├── palette.ts
        ├── mode-picker.ts
        ├── thread-switcher.ts
        └── file-picker.ts

apps/rika/src/
├── interactive-main/
│   ├── index.ts
│   ├── terminal-title.ts
│   ├── prompt-attachments.ts
│   ├── local-files.ts
│   ├── changed-files.ts
│   ├── clipboard-images.ts
│   ├── settings.ts
│   ├── resident-dispatch.ts
│   ├── process.ts
│   └── tui-session/
│       ├── index.ts
│       ├── state.ts
│       ├── event-dispatch.ts
│       ├── feed.ts
│       ├── terminal-lifecycle.ts
│       ├── submission.ts
│       ├── selection.ts
│       └── renderer.ts
├── resident-main/
│   ├── index.ts
│   ├── settings.ts
│   ├── test-model.ts
│   ├── process.ts
│   ├── model-routes/
│   │   ├── index.ts
│   │   ├── pins.ts
│   │   └── persisted.ts
│   ├── backend/
│   │   ├── index.ts
│   │   ├── configured.ts
│   │   ├── lazy.ts
│   │   ├── pinned-registration.ts
│   │   └── workspace.ts
│   └── product/
│       ├── index.ts
│       ├── repositories.ts
│       ├── config-adapter.ts
│       └── auth.ts
├── resident-client-transport/
│   ├── index.ts
│   ├── socket-failure.ts
│   ├── handshake.ts
│   ├── physical-connection.ts
│   ├── interactive-feed.ts
│   ├── interactive-session.ts
│   ├── startup-acquisition.ts
│   └── reconnect-supervisor.ts
└── resident-host-transport/
    ├── index.ts
    ├── lifecycle.ts
    ├── connection.ts
    ├── operation-forwarding.ts
    ├── http-server.ts
    └── interactive/
        ├── index.ts
        ├── feed.ts
        └── commands.ts
```

## Target test tree

These are ownership targets, not permission to duplicate setup. Move current assertions without changing behavior, then extract only narrowly named harnesses needed by multiple files.

```text
packages/app/test/
├── operation/
│   ├── recovery.test.ts
│   ├── reconciliation.test.ts
│   ├── queue-promotion.test.ts
│   ├── thread-dispatch.test.ts
│   ├── workflow-dispatch.test.ts
│   ├── run-dispatch.test.ts
│   ├── interactive-feed.test.ts
│   ├── interactive-selection.test.ts
│   ├── interactive-controls.test.ts
│   ├── interactive-submission.test.ts
│   ├── transcript-repair.test.ts
│   ├── child-followers.test.ts
│   ├── titles.test.ts
│   ├── usage-projection.test.ts
│   └── root-execution-events.test.ts
├── interactive-session/
│   ├── controls.test.ts
│   ├── queue.test.ts
│   ├── transcript-pages.test.ts
│   ├── control-failures.test.ts
│   └── subagent-reload.test.ts
├── operation-contract/
│   ├── input.test.ts
│   ├── interactive-events.test.ts
│   └── interactive-commands.test.ts
├── usage-cost/
│   ├── snapshot.test.ts
│   ├── active-time.test.ts
│   ├── attempts.test.ts
│   └── collection.test.ts
└── test-support/operation-test-layer.ts

packages/runtime/test/
├── execution-backend/
│   ├── identifiers.test.ts
│   ├── events.test.ts
│   ├── following.test.ts
│   ├── execution-methods.test.ts
│   ├── child-methods.test.ts
│   ├── workflow-methods.test.ts
│   ├── host-methods.test.ts
│   ├── tool-runtime.test.ts
│   ├── layer.test.ts
│   └── resilience.test.ts
├── relay/
│   ├── execution.test.ts
│   ├── tools.test.ts
│   ├── workspace-routing.test.ts
│   ├── workflows.test.ts
│   ├── model-routing.test.ts
│   ├── steering.test.ts
│   ├── cancellation.test.ts
│   ├── approvals.test.ts
│   └── compaction.test.ts
├── subagent/
│   ├── parallel.test.ts
│   ├── read-thread.test.ts
│   ├── nested.test.ts
│   ├── routes.test.ts
│   ├── handoff.test.ts
│   ├── workspace-tools.test.ts
│   └── approvals.test.ts
└── test-support/relay-backend-harness.ts

packages/transcript/test/projection/
├── model-events.test.ts
├── tool-events.test.ts
├── child-events.test.ts
├── process-events.test.ts
├── compaction.test.ts
├── settlement.test.ts
├── correlation.test.ts
├── steering.test.ts
└── failure-recovery.test.ts

packages/persistence/test/
├── product-database/
│   ├── migrations.test.ts
│   ├── preflight.test.ts
│   └── schema-validation.test.ts
├── sqlite/
│   ├── product-roundtrip.test.ts
│   ├── turn-queue.test.ts
│   ├── concurrency.test.ts
│   └── malformed-rows.test.ts
├── turn-repository/
│   ├── memory-lifecycle.test.ts
│   ├── memory-queue.test.ts
│   ├── sqlite-lifecycle.test.ts
│   └── sqlite-queue.test.ts
├── transcript-repository/
│   ├── memory.test.ts
│   ├── sqlite.test.ts
│   └── pagination.test.ts
└── test-support/sqlite-product-harness.ts

packages/tui/test/
├── view-state/
│   ├── activity.test.ts
│   ├── composer.test.ts
│   ├── execution.test.ts
│   ├── queue.test.ts
│   ├── overlays.test.ts
│   ├── permissions.test.ts
│   ├── transcript.test.ts
│   └── keyboard.test.ts
├── adapter/
│   ├── transcript-rendering.test.ts
│   ├── tool-rendering.test.ts
│   ├── surface-input.test.ts
│   ├── surface-lifecycle.test.ts
│   ├── sidebar.test.ts
│   ├── overlays.test.ts
│   └── create.test.ts
├── opentui-adapter/
│   ├── input-resize.test.ts
│   ├── transcript-window.test.ts
│   ├── transcript-scroll.test.ts
│   ├── transcript-renderables.test.ts
│   ├── animation.test.ts
│   ├── pointer-clipboard.test.ts
│   ├── sidebar.test.ts
│   ├── responsive-layout.test.ts
│   └── queue.test.ts
├── execution-events/
│   ├── tools.test.ts
│   ├── children.test.ts
│   ├── cancellation.test.ts
│   └── delegation-verdicts.test.ts
└── test-support/opentui-surface-harness.ts

apps/rika/test/
├── interactive-controller/
│   ├── transcript-pages.test.ts
│   ├── child-projections.test.ts
│   ├── selection.test.ts
│   ├── usage.test.ts
│   ├── queue.test.ts
│   └── frame-batching.test.ts
├── resident-main/
│   ├── model-routes.test.ts
│   ├── persisted-routes.test.ts
│   ├── backend.test.ts
│   └── test-model.test.ts
└── fixtures/resident-client/
    ├── index.ts
    ├── connection.ts
    ├── interactive-feed.ts
    └── scenarios.ts
```

## Implementation slices

### 0. Stabilize and freeze the baseline

- **Result:** The current private-runtime split is committed, formatted, green, and no plan step targets deleted `main.ts` code.
- **Changes:** Finish the existing `client-main.ts`, `interactive-main.ts`, `resident-main.ts`, performance, packaging, install, release-workflow, transcript, runtime, and TUI behavior changes already present in the working tree. Do not combine those behavior changes with this refactor. Recompute the inventory after formatting and update only the baseline section of this plan if counts changed.
- **Tests:** Preserve all current unit, TUI, process, package, install, and release-workflow tests.
- **Checks:** `bun run check`, `bun run test-tui`, `bun run test-proc`, and the focused package/release tests already changed by that work.
- **Stop conditions:** Dirty or untracked product changes remain; any current suite is red; or the source inventory is still changing during the run.

### 1. Add façade and ownership characterization

- **Result:** Structural moves can fail visibly without adding alternate mocks.
- **Changes:** Add focused tests for:
  - exact public exports of `@rika/app/operation`, `@rika/app/operation-contract`, `@rika/runtime/relay`, `@rika/tui/adapter`, and affected persistence subpaths;
  - every operation Input member, InteractiveEvent variant, and InteractiveCommand dispatch;
  - memory/SQLite parity for turn and thread-interaction repository contracts;
  - transcript ordering, unknown events, transient/durable replay, and nested settlement;
  - ViewState message routing and modal-key precedence;
  - Surface construction, transcript/composer/sidebar/overlay updates, and teardown;
  - interactive/resident lazy startup and finalizer behavior; and
  - resident feed replay, acknowledgements, command ordering, reconnect, replacement, and shutdown.
- **Tests:** Use existing real SQLite, Relay, OpenTUI, and transport harnesses.
- **Checks:** Focused unit files, then `bun run check`, `bun run test-tui`, and `bun run test-proc`.
- **Cleanup:** Do not keep export snapshots that depend on source text or private names. Assert the runtime/module API consumed by controlled callers.

### 2. Split all oversized test and fixture files without source changes

- **Result:** Every current test and code fixture is at most 800 lines, and later source slices have focused verification targets.
- **Changes:** Apply the target test tree above. Split by `describe`/behavior family, not equal line chunks. Extract only narrowly named test support. Move the 821-line resident client fixture into a folder with `index.ts` plus connection/feed/scenario leaves, and update `resident-transport-harness.ts` plus every explicit `options.script` caller to the new executable fixture path in the same change.
- **Tests:** Record the discovered test count for each original file before the split and compare it with the sum after the split. Run the complete affected project after each family. The fixture-folder change must execute the process suites that spawn it; importing its index in a unit test is insufficient.
- **Checks:** `bun run test` after unit splits; `bun run test-tui` after TUI-project splits; `bun run test-proc` after fixture or process splits.
- **Stop conditions:** A test must be weakened, skipped, reclassified, or converted to a snapshot to fit the target; discovery count changes unexpectedly; or splitting introduces parallel process ownership that did not exist before.

### 3. Convert contracts and pure projections

- **Result:** Small, low-side-effect owners establish the internal dependency direction used by later tracks.
- **Changes:**
  1. Convert `operation-contract.ts` to `operation-contract/index.ts` and its interactive leaves.
  2. Convert `usage-cost.ts` to `usage-cost/index.ts` and split snapshot, active-time, attempt, observation, history, and rebuild logic.
  3. Reduce transcript package-root `index.ts` to explicit public exports and move projection logic under `projection/`.
  4. Convert `view-state.ts` to `view-state/index.ts`; extract models/messages first, then layout/composer/queue, then message-family reducers.
- **Tests:** Run operation-contract, usage-cost, transcript-projection, ViewState, and interactive-controller focused families.
- **Checks:** Affected package typechecks and `bun run check`; run `bun run test-tui` after ViewState moves.
- **Stop conditions:** A child imports its own façade; an internal symbol becomes part of a public façade only to avoid a proper dependency; schema tags, optional keys, or union variants change; or the top-level ViewState reducer stops being exhaustive and pure.

### 4. Refactor persistence owners

- **Result:** Database history and repository contracts are separated from memory and SQLite implementations without changing atomicity.
- **Changes:**
  1. Convert `product-database.ts` to `product-database/index.ts`; move immutable numbered migrations, keep the ordered migration registry and schema-prefix manifest explicit, and separate inspection/preflight/layer code.
  2. Convert `turn-repository.ts` to `turn-repository/index.ts`; extract contract and row codecs, then memory and SQLite implementations.
  3. Convert `thread-interaction-repository.ts` to its folder façade; extract contracts/pure admission rules, then memory and SQLite implementations.
  4. Update `@rika/persistence` exports and source-graph assertions to directory paths.
- **Tests:** Run product-database, SQLite, turn-repository, thread-interaction-repository, transcript-repository, and app thread-tool gateway tests.
- **Checks:** `bun --cwd packages/persistence typecheck`, focused tests, then `bun run check`.
- **Stop conditions:** Migration SQL, number, name, or order changes; `schemaObjectsByMigration` no longer covers every prefix; a current SQL transaction is split across Effect boundaries; service identifiers change; or memory/SQLite parity fails.

### 5. Refactor the Relay execution backend

- **Result:** `@rika/runtime/relay` is a folder façade over pure identifiers/mapping, client methods, and embedded runtime composition.
- **Changes:**
  1. Convert `execution-backend.ts` to `execution-backend/index.ts` and update the package export.
  2. Extract model registration/routing, tool runtime, identifiers, event mapping, child result reconstruction, follow/tree, and recovery.
  3. Split `layerFromClient` by root execution, child/fan-out, workflow, thread-host, and approval methods.
  4. Split embedded prompt recovery, delegation, tool, fan-out-host, and workflow-host composition.
  5. Keep released Relay/Baton imports and prompt-text loader behavior unchanged.
- **Tests:** Run all execution-backend, relay, subagent, workflow, and recovery families.
- **Checks:** Runtime typecheck, `bun run check`, and affected process suites.
- **Stop conditions:** Durable identifier formats, event attribution/order, cursor recovery, registration keys, cancellation/approval semantics, prompt paths, or scope/finalizer ownership change.

### 6. Refactor app operation semantics

- **Result:** `@rika/app/operation` is a thin public façade over named product services and dispatch owners; no replacement god object appears.
- **Changes:**
  1. Convert `operation.ts` to `operation/index.ts` and update package exports.
  2. Extract transcript bounds, root-event filtering, usage projection, reconciliation, execution tree, quiescence, stop/recovery, titles, context preparation, and thread result delivery.
  3. Replace the monolithic `productLayer` closure with parameterized capability factories or narrowly scoped internal services. Do not move shared mutable state into a generic state bag.
  4. Extract interactive feed, selection/repair, child followers, submission, queue promotion, and controls.
  5. Extract Run, Review, Workflow, Migration, and Thread dispatch. Leave the folder façade responsible for public exports and top-level composition only.
- **Tests:** Run every app operation and interactive-session family, thread tools, specialty transcripts, status parity, and the in-process TUI app suite.
- **Checks:** App typecheck, `bun run check`, and `bun run test-tui`.
- **Stop conditions:** Relay becomes bypassed as durable authority; SQL enters app leaves; one shared mutable object replaces the old closure; queue claim/release, observer uniqueness, cancellation precedence, transcript repair, or usage/title behavior changes; or the façade exceeds 800 lines.

### 7. Refactor the OpenTUI adapter

- **Result:** `packages/tui/src/adapter/index.ts` is the only adapter façade, presentation is separate from mutable region ownership, and OpenTUI remains contained.
- **Changes:**
  1. Convert `adapter.ts` to `adapter/index.ts`; update the package export and build entry.
  2. Extract pure changed-file, transcript-bound, transcript-unit, overlay, welcome, and presentation functions.
  3. Do not attempt to split the `Surface` class across files. Introduce domain collaborators that own transcript mounting/reconciliation, viewport/anchors, sidebar virtualization, overlay/composer input, animation, and lifecycle state.
  4. Keep renderer acquisition/release in `renderer.ts` and the public `create`/`Surface` API in the façade.
  5. Add an architecture guard proving OpenTUI imports appear only under `src/adapter/**`.
- **Tests:** Run adapter, OpenTUI adapter, transcript viewport/bounds/renderers, visual tests, and app TUI tests.
- **Checks:** TUI typecheck, `bun run check`, and `bun run test-tui`.
- **Stop conditions:** Visual fixtures change without an approved behavior change; mounted-window bounds, identity, selection, cursor/focus, scroll anchors, animation clock, or teardown changes; OpenTUI leaks outside the adapter folder; or mutable fields are merely moved into one replacement controller.

### 8. Refactor resident client and host transports

- **Result:** Both transport monoliths are folder façades over explicitly owned connection, feed, command, operation, and supervision state machines.
- **Changes:**
  1. Convert `resident-client-transport.ts` to its folder façade; extract socket failure/handshake, physical connection, feed/session, startup acquisition, and reconnect supervisor.
  2. Convert `resident-host-transport.ts`; extract lifecycle, interactive feed, command ordering, connection, operation forwarding, and HTTP server.
  3. Preserve bounded queues, semaphores, Deferred races, replay windows, authentication, build replacement, and Scope close order.
- **Tests:** Run resident service/wire/client tests and all delivery, reconnect, lifecycle, cancellation-on-quit, and transport process suites.
- **Checks:** CLI typecheck, `bun run check`, and `bun run test-proc`.
- **Stop conditions:** Protocol version/frames, proofs/nonces, replay/ack/resync, command order, read-vs-mutation retry policy, drain/replacement, or process behavior changes.

### 9. Refactor private interactive and resident entrypoints

- **Result:** `interactive-main/index.ts` and `resident-main/index.ts` are thin process boundaries; build and packaged executable names remain unchanged.
- **Changes:**
  1. Extract pure interactive file/image/Git/terminal behavior, then TUI event/feed/selection/renderer owners, then process lifecycle.
  2. Extract resident test-model and route calculations, configured/lazy backend wrappers, repository/product composition, then process startup.
  3. Update all literal source paths together: `apps/rika/package.json`, `scripts/package.ts`, `client-main.ts`, `performance-platform.ts`, focused tests, and development spawning.
  4. Configure build entrypoints or output naming so directory `index.ts` files cannot collide as `dist/index.js`. Preserve `client-main.js`, `interactive-main.js`, `resident-main.js`, `.rika-interactive`, and `.rika-resident` contracts.
  5. Update `test/scripts/package.test.ts` so source-graph guards assert directory paths and do not become vacuous after `.ts` files disappear. Update both forbidden-path assertions and positive assertions for `operation-contract/index.ts`, `resident-client-transport/index.ts`, and each private runtime entrypoint.
  6. Update any tests whose sample changed-file paths intentionally name the old source files so they still exercise the intended tree/label behavior against the new paths; do not rewrite historical plans merely to change old evidence.
- **Tests:** Run prompt parts, shell session, terminal title, model route/backend/test-model tests, source-graph/package tests, TUI tests, and resident process suites.
- **Checks:** CLI typecheck, `bun run build`, `bun run check`, `bun run test-tui`, `bun run test-proc`, one current-platform `bun run package -- --target <target>`, and `bun run release-smoke` when packaging is available.
- **Stop conditions:** `import.meta.dir` or `import.meta.path` resolves a wrong source/runtime path; the resident graph imports TUI/OpenTUI; the interactive graph imports provider/Relay host code; lazy command startup regresses; or packaged private runtimes cannot be found.

### 10. Enforce the ceiling and close the epic

- **Result:** Future code over 800 lines fails the existing lint workflow, with no custom validator or allowlist.
- **Changes:**
  - Add Oxlint's existing rule to `.oxlintrc.json` only after the inventory is zero:

    ```json
    "max-lines": ["error", { "max": 800, "skipBlankLines": false, "skipComments": false }]
    ```

  - Include maintained root `test/**` code in the supported lint surface by adding `test` to the existing root `lint` command and `test/**/*.ts` to the existing `//#lint` inputs. Keep one root `lint` command; do not add a second line-count script.
  - Add focused ast-grep architecture rules for the promoted capability folders that reject imports resolving to that same folder's `index.ts`; do not broadly ban `..`, because legitimate children import parent leaves.
  - Re-run the complete inventory and confirm no source, test, executable fixture, or newly extracted test support file exceeds 800 lines after formatting.

- **Tests:** Run all deterministic, TUI, and process suites.
- **Checks:** Run `bun run format`, then use `bun run format-check` for the final non-mutating gate, followed by `bun run check`, `bun run test`, `bun run test-tui`, `bun run test-proc`, build, package, and release smoke as applicable.
- **Cleanup:** Remove old sibling monoliths, stale explicit `.ts` export targets, vacuous source-graph assertions, temporary forwarding files, and any refactor-only compatibility path.

## Parallel delivery graph

After Slices 0–2, use these independently mergeable tracks:

```text
contracts/pure state: operation-contract → usage-cost/transcript → view-state
persistence:          product-database → turn repository → thread interaction repository
runtime:              execution-backend
app:                  operation-contract + transcript + persistence/runtime façades → operation
TUI:                  view-state → adapter
transport:            operation-contract → client transport + host transport
entrypoints:          app/runtime/persistence + transports + TUI adapter → interactive/resident main
final gate:           every track → max-lines lint
```

Persistence, runtime, transcript, and TUI-state work can proceed in parallel after their oversized tests are split. Serialize slices that edit the same package manifest or literal entrypoint paths. Do not run app operation, adapter `Surface`, and entrypoint conversion as one change.

## Per-slice acceptance checklist

- The changed source, test, fixture, and test-support files are all at most 800 physical lines after `bun run format`.
- The folder has one `index.ts` façade and no same-named sibling `.ts` file.
- Public package specifiers and root namespace exports are unchanged.
- The façade explicitly exports only the previous public API.
- Children import direct leaves, never their own façade.
- Context keys, tagged errors, schemas, durable IDs, SQL transactions, and Effect scope ownership are unchanged.
- Existing focused tests pass; TUI/process suites run when their owners are touched.
- No generic catch-all module or replacement god object is introduced.
- What ran and what did not run is recorded in the implementation PR.

## Completion criteria

- The post-format inventory reports zero maintained code files over 800 physical lines.
- Oxlint `max-lines` enforces 800 through the existing `bun run check` path without exemptions.
- `@rika/app/operation`, `@rika/app/operation-contract`, `@rika/runtime/relay`, `@rika/tui/adapter`, and persistence subpaths resolve through folder `index.ts` façades.
- `packages/transcript/src/index.ts` is a thin explicit package façade.
- No child-to-own-façade import, public-surface widening, generic catch-all module, or replacement god object remains.
- Wire, database, Relay/Baton, process, packaging, and public package contracts are unchanged.
- `bun run check`, `bun run test`, `bun run test-tui`, and `bun run test-proc` pass.
- A supported current-platform package and `bun run release-smoke` pass when packaging credentials/platform support are available; any unrun release check is reported explicitly.
