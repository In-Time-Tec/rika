# Plan 027: Agent-native repository architecture

## Goal

Reshape Rika into a repository that agents can navigate from names, paths, package boundaries, imports, tests, and deterministic queries without first reconstructing the whole codebase.

The source standard is `/Users/dallenpyrah/Documents/Obsidian Vault/Agent-Native Repository Architecture.md`. This plan adopts its core recommendation: compact semantic completeness rather than either monoliths or one-function files.

The completed repository will have:

- descriptive domain-role package, folder, file, symbol, error, and test names;
- many meaningful capability branches, with at most two semantic directories below any `src/`;
- medium semantic source and test files, with 500 lines as the growth warning and 800 as an absolute ceiling;
- one primary abstraction and normally one to four exports per file, never more than eight;
- no hand-authored `index.ts`, internal barrels, `export *`, default exports, generic basenames, or cross-package deep imports;
- product-owned execution and repository contracts, with Relay and SQLite implementations pointing inward from adapter packages;
- colocated narrow unit and property tests, package-level integration and contract tests, and the existing Rika TUI/process acceptance boundaries;
- exact package export maps and machine-readable package kinds;
- a generated structural dependency graph and query CLI, but no prohibited semantic code index;
- structural policy checks with remediation-oriented diagnostics; and
- a short root `AGENTS.md` plus narrowly scoped nested instructions at real boundaries.

This is a greenfield breaking migration. Old package names, paths, barrels, and compatibility forwarding modules are deleted rather than preserved.

## Evidence and current path

The current tree is clean but `main` is one commit behind `origin/main` (`9daa7a0`, a TUI teardown test change). Synchronizing that commit is the first implementation action.

Current structural facts:

- There are 172 production TypeScript files and 54,337 production lines under `apps/*/src` and `packages/*/src`.
- Six flat source directories contain 15 to 26 TypeScript files each.
- Nine production files are named `index.ts`; package roots use namespace barrels and `export *`.
- There are 36 maintained code files above 800 lines: 17 production files and 19 tests or executable fixtures.
- The largest production files are `packages/app/src/operation.ts` at 4,815 lines, `packages/tui/src/adapter.ts` at 4,386, `packages/runtime/src/execution-backend.ts` at 2,605, and `packages/tui/src/view-state.ts` at 2,247.
- Sixty-four production files expose more than eight top-level export statements. `view-state.ts` exposes 80, `resident-service.ts` 59, `agent-tools.ts` 45, and `config-contract.ts` 41.
- `@rika/app` has 112 import edges into `@rika/persistence` and 29 into `@rika/runtime`. Both adapter packages currently own the service contracts consumed by product semantics, so dependency injection hides rather than reverses the dependency direction.
- `packages/persistence/src/product-database.ts` combines 27 immutable migrations, schema inspection, preflight, manifest validation, and Layer construction.
- `packages/runtime/src/execution-contract.ts` mixes Rika execution contracts with Baton `ModelRegistry` types and Relay-adapter-only registration behavior.
- `plans/026-refactor-files-over-800-lines.md` proposes many `index.ts` folder facades. That directly conflicts with the agent-native source standard and is superseded by this plan.

The current package graph is acyclic but points from product policy toward adapter ownership. In every graph below, `A ─→ B` means A imports B:

```text
@rika/tools ─→ @rika/config
@rika/transcript ─→ @rika/tools
@rika/persistence ─→ @rika/config + @rika/tools + @rika/transcript
@rika/runtime ─→ @rika/config + @rika/tools
@rika/app ─→ @rika/config + @rika/extensions + @rika/persistence + @rika/runtime + @rika/tools + @rika/transcript
@rika/tui ─→ @rika/config + @rika/transcript
@rika/cli ─→ every Rika package
```

## Source-standard adaptations for Rika

The Obsidian source is a general standard. Rika-specific instructions remain authoritative where they are narrower:

- Keep `PRODUCT.md` and `CONTEXT.md` as the product and vocabulary authorities. Do not add `ARCHITECTURE.md` or `docs/vocabulary.md` duplicates.
- Keep root everyday scripts named `build`, `check`, `dev`, `format`, `test`, and `typecheck`. Do not add colon-named command aliases. Repository graph queries run through the tooling workspace directly.
- Keep `test/` as the root cross-workspace test directory and keep `apps/rika/test/tui-app.ts` at that exact path.
- Keep `*.tui.test.ts` and `*.proc.test.ts` in their dedicated Vitest projects. Colocation applies to narrow unit, property, schema, reducer, and service tests, not process or application acceptance suites.
- Generate only structural import, package, export, and test-relation data. Do not create a semantic code index, natural-language module catalog, or ast-grep outline system.
- Keep generated graph data under `docs/generated/`, but do not create documentation indexes, status ledgers, evidence tables, or duplicated prose contracts.
- Keep comments out of code. Generated ownership is conveyed by generated paths, filenames, manifests, and policy rather than source headers.
- Never inspect or modify `repos/*` during this migration.

The request for many nested folders is implemented as many meaningful branches, not arbitrary depth. The source standard itself caps nesting at:

```text
workspace → src → capability → subcapability → semantic file
```

Anything deeper must be flattened, renamed, or promoted to a real package boundary.

## Chosen target shape

### Options considered

| Option                                                                                                          | Result                                                                                                                                          | Decision |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Keep current package names and only add folders                                                                 | Lowest move cost, but leaves generic `app`, `runtime`, `tools`, and `tui` names and keeps product-to-adapter dependency inversion               | Reject   |
| Create a package for every feature folder                                                                       | Strong isolation, but fragments tightly coupled product semantics, increases graph traversal, and is likely to create false contracts or cycles | Reject   |
| Rename durable package owners, add capability/subcapability folders, and move consumer-owned ports into product | Strong path signal, fewer deeper boundaries, correct dependency direction, and manageable migration slices                                      | Adopt    |

### Package move map

| Current                                     | Target                                              | Kind        | Ownership                                                               |
| ------------------------------------------- | --------------------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| `packages/app`, `@rika/app`                 | `packages/product`, `@rika/product`                 | capability  | Rika product models, ports, policies, operations, and projections       |
| `packages/config`, `@rika/config`           | `packages/configuration`, `@rika/configuration`     | capability  | typed settings, model routes, modes, and paths                          |
| `packages/tools`, `@rika/tools`             | `packages/coding-tools`, `@rika/coding-tools`       | capability  | typed coding-tool contracts, policy, runtime adapters, and web research |
| `packages/persistence`, `@rika/persistence` | `packages/product-store`, `@rika/product-store`     | adapter     | memory and SQLite implementations of product-owned repository ports     |
| `packages/runtime`, `@rika/runtime`         | `packages/relay-execution`, `@rika/relay-execution` | adapter     | released Relay/Baton adaptation and execution runtime composition       |
| `packages/tui`, `@rika/tui`                 | `packages/terminal`, `@rika/terminal`               | adapter     | pure terminal state/presentation and the OpenTUI adapter                |
| `packages/extensions`, `@rika/extensions`   | unchanged                                           | capability  | extension, plugin, skill, and MCP lifecycle                             |
| `packages/transcript`, `@rika/transcript`   | unchanged                                           | capability  | semantic transcript model and projection                                |
| `apps/rika`, `@rika/cli`                    | unchanged                                           | application | CLI, process entrypoints, transport, and runtime composition            |

### Target dependency direction

```text
@rika/coding-tools ─→ @rika/configuration
@rika/transcript ─→ @rika/coding-tools
@rika/product ─→ @rika/configuration + @rika/coding-tools + @rika/extensions + @rika/transcript
@rika/product-store ─→ @rika/product + @rika/transcript
@rika/relay-execution ─→ @rika/configuration + @rika/coding-tools + @rika/product
@rika/terminal ─→ @rika/configuration + @rika/transcript
@rika/cli ─→ @rika/configuration + @rika/coding-tools + @rika/extensions + @rika/product + @rika/product-store + @rika/relay-execution + @rika/terminal + @rika/transcript
```

`@rika/product` will not import `@rika/product-store` or `@rika/relay-execution`. Repository ports, Thread/Turn schemas, execution identifiers/statuses, and the Rika execution service contract move into product. The persisted product route becomes an adapter-neutral snapshot: Mode/model intent, provider-connection snapshot, request variant/options as Rika configuration data, compaction budgets, and an opaque model-registration identity. Product code and stored rows contain no `registrationKey`, `providerRuntime`, `openAiAccountFingerprint`, Baton type, or provider SDK type. `@rika/relay-execution` translates that snapshot into Relay/Baton registration/runtime data and recreates the same opaque identity on restart. Migration 028 rewrites existing route JSON without changing the prior 27 migrations. SQLite and Relay/Baton packages implement the product ports. `@rika/product-store` therefore has no configuration or coding-tool dependency. The CLI resident composition root chooses concrete Layers but contains no Baton model/provider implementation.

Package manifests receive machine-readable metadata:

```json
{
  "rika": {
    "kind": "domain | capability | adapter | application | tooling",
    "domain": "<owned capability>"
  }
}
```

The repository policy enforces kind-level rules plus the exact acyclic Rika package allowlist above. Kind metadata describes ownership; it does not permit every capability package to import every other capability. Manifests remain the source of dependency declarations.

All workspace libraries remain private and source-first. Their exact export maps target TypeScript source, while `typecheck`, tests, and export-contract tests validate them. Library barrel build scripts are removed; only executable applications own production bundles. This avoids replacing `index.ts` with a generated entrypoint list or accidentally bundling colocated tests. `@rika/cli` continues to build the four explicit process entrypoints.

Production and test dependency graphs are checked separately. Product unit tests use product-owned test Layers, not `@rika/product-store` or `@rika/relay-execution` dev dependencies. Real adapter parity stays in adapter contract tests, and the CLI acceptance stack proves composition. This avoids hiding a production inversion behind a package-level test cycle.

## Naming, file, folder, import, and test rules

- Production basenames use two to five meaningful kebab-case words and are globally unique unless a framework-required configuration, numbered migration, or process entrypoint name is explicitly exempted.
- `product-migration-NNN-<meaningful-slug>.ts` is exempt only from the two-to-five-word limit; the numeric ID, full basename uniqueness, kebab case, registry order, and migration identity remain enforced.
- Files match their primary export: `execution-service.ts` exports `ExecutionService`; `thread-repository.ts` exports `ThreadRepository`; `model-route-conflict.ts` names the failure condition.
- Services use domain-specific names instead of `Service`, `Interface`, `Options`, `Error`, `layer`, or `testLayer` as globally ambiguous primary exports.
- One concept uses one term from `CONTEXT.md`: Workspace, Thread, Turn, Model Turn, Pending Turn, Thread Host, Execution, Agent, Child Run, Workflow, Mode, Provider, Resolved Context, Thread Projection, Resident Rika Service, and Profile.
- Functions state transformations or decisions. Generic heads such as `handle`, `process`, `run`, `manager`, and `helper` are prohibited unless `run` is the real CLI boundary required by Effect CLI.
- Hand-authored `index.ts`, package barrels, internal barrels, `export *`, default exports, and cross-package `src` imports are prohibited.
- Package export maps list exact supported subpaths. Most internal packages have no `.` export; callers import the named capability module they use.
- Internal imports target direct files. Cross-package imports target exact export-map subpaths.
- Narrow tests sit beside source with the same stem. Broader tests use `test/integration`, `test/contract`, `test/support`, or the application TUI/process directories.
- A missing same-stem test is valid only when `tooling/repository-policy/test-ownership-exceptions.json` maps that source path to a named broader test, relationship (`direct`, `public-api`, `integration`, or `process`), and reason. Policy verifies that the test exists and imports or reaches the named owner. The final file is an exception map, not a general test ledger.
- Tests and fixtures follow the same 500-line warning and 800-line ceiling as production code.
- Target file size is 150–400 physical lines. Small schemas and process entrypoints may be shorter. A semantic unit is never padded or split only to satisfy a target.
- New or changed files above 500 lines fail unless a temporary, named migration waiver exists. No file may exceed 800 lines.
- Functions warn above 80 lines and fail above 150. Files warn above four exported declarations and fail above eight. Direct dependencies warn above 12 and fail above 18. Directories warn above 20 source files and fail above 30.
- Export limits count declarations and named export specifiers through the AST. A grouped `export { A, B, C }` counts as three; `export type` declarations count; re-export stars are prohibited rather than counted as one.
- A capability directory normally contains at least three related source modules. Policy rejects both a leaf directory containing one source module and a semantic directory containing one child directory with no direct source. A smaller non-singleton directory requires an exception naming the stable boundary; directory-per-file and redundant parent chains are not accepted.

### Frozen public export contract

No internal package has a `.` export. Every supported subpath is exact and matches the public source basename: `@rika/product/execution-service` maps to `packages/product/src/execution/contract/execution-service.ts`. Private leaves in the target tree are not exported.

Slice 2 commits and contract-tests this complete manifest surface before any parallel track starts:

```text
@rika/configuration
  ./behavior-mode                 → ./src/model-routing/behavior-mode.ts
  ./model-catalog                 → ./src/model-routing/model-catalog.ts
  ./model-preset                  → ./src/model-routing/model-preset.ts
  ./model-route                   → ./src/model-routing/model-route.ts
  ./model-route-label             → ./src/model-routing/model-route-label.ts
  ./model-route-resolution        → ./src/model-routing/model-route-resolution.ts
  ./canonical-data-root           → ./src/path-resolution/canonical-data-root.ts
  ./configuration-paths           → ./src/path-resolution/configuration-paths.ts
  ./profile-data-paths            → ./src/path-resolution/profile-data-paths.ts
  ./configuration-settings        → ./src/settings/configuration-settings.ts
  ./configuration-service         → ./src/settings/configuration-service.ts

@rika/coding-tools
  ./coding-tool-catalog           → ./src/catalog/coding-tool-catalog.ts
  ./thread-tool-contract          → ./src/catalog/thread-tool-contract.ts
  ./tool-invocation               → ./src/catalog/tool-invocation.ts
  ./agent-tool-contract           → ./src/delegation/agent-tool-contract.ts
  ./agent-tool-result             → ./src/delegation/agent-tool-result.ts
  ./media-view-service            → ./src/media/media-view-service.ts
  ./view-media-tool               → ./src/media/view-media-tool.ts
  ./coding-tool-policy            → ./src/policy/coding-tool-policy.ts
  ./local-safety-policy           → ./src/policy/local-safety-policy.ts
  ./bash-tool                     → ./src/process/bash-tool.ts
  ./shell-command-status-tool     → ./src/process/shell-command-status-tool.ts
  ./shell-process-registry        → ./src/process/shell-process-registry.ts
  ./coding-tool-runtime           → ./src/runtime/coding-tool-runtime.ts
  ./parallel-web-search           → ./src/web-research/parallel-web-search.ts
  ./read-web-page-service         → ./src/web-research/read-web-page-service.ts
  ./read-web-page-tool            → ./src/web-research/read-web-page-tool.ts
  ./web-search-provider           → ./src/web-research/web-search-provider.ts
  ./web-search-service            → ./src/web-research/web-search-service.ts
  ./web-search-tool               → ./src/web-research/web-search-tool.ts
  ./edit-file-tool                → ./src/workspace/edit-file-tool.ts
  ./grep-files-tool               → ./src/workspace/grep-files-tool.ts
  ./local-path                    → ./src/workspace/local-path.ts
  ./read-file-tool                → ./src/workspace/read-file-tool.ts
  ./unified-diff                  → ./src/workspace/unified-diff.ts
  ./workspace-file-search         → ./src/workspace/workspace-file-search.ts
  ./write-file-tool               → ./src/workspace/write-file-tool.ts

@rika/extensions
  ./execution-extension-service   → ./src/plugin/execution-extension-service.ts
  ./mcp-configuration             → ./src/mcp/mcp-configuration.ts
  ./mcp-oauth-service             → ./src/mcp/mcp-oauth-service.ts
  ./mcp-runtime                   → ./src/mcp/mcp-runtime.ts
  ./plugin-contract               → ./src/plugin/plugin-contract.ts
  ./plugin-digest                 → ./src/plugin/plugin-digest.ts
  ./plugin-registry               → ./src/plugin/plugin-registry.ts
  ./skill-registry                → ./src/skill/skill-registry.ts

@rika/transcript
  ./child-parent-correlation       → ./src/ordering/child-parent-correlation.ts
  ./transcript-unit-identity       → ./src/ordering/transcript-unit-identity.ts
  ./transcript-unit-order          → ./src/ordering/transcript-unit-order.ts
  ./model-usage-fallback           → ./src/presentation/model-usage-fallback.ts
  ./recorded-shell-presentation    → ./src/presentation/recorded-shell-presentation.ts
  ./nested-transcript-projection   → ./src/projection/nested-transcript-projection.ts
  ./partial-tool-input             → ./src/projection/partial-tool-input.ts
  ./transcript-projection          → ./src/projection/transcript-projection.ts
  ./transcript-settlement          → ./src/projection/transcript-settlement.ts
  ./transcript-presentation-model  → ./src/schema/transcript-presentation-model.ts
  ./transcript-projection-model    → ./src/schema/transcript-projection-model.ts
  ./transcript-source-event        → ./src/schema/transcript-source-event.ts
  ./transcript-unit                → ./src/schema/transcript-unit.ts

@rika/product
  ./agent-profile                         → ./src/agent/agent-profile.ts
  ./product-agent-service                 → ./src/agent/product-agent-service.ts
  ./openai-auth-contract                  → ./src/authentication/openai-auth-contract.ts
  ./openai-auth-service                   → ./src/authentication/openai-auth-service.ts
  ./context-file-system                   → ./src/context/context-file-system.ts
  ./context-resolution-service            → ./src/context/context-resolution-service.ts
  ./resolved-context                      → ./src/context/resolved-context.ts
  ./execution-approval                    → ./src/execution/contract/execution-approval.ts
  ./execution-child-run                   → ./src/execution/contract/execution-child-run.ts
  ./execution-event                       → ./src/execution/contract/execution-event.ts
  ./execution-identifier                  → ./src/execution/contract/execution-identifier.ts
  ./execution-inspection                  → ./src/execution/contract/execution-inspection.ts
  ./execution-request                     → ./src/execution/contract/execution-request.ts
  ./execution-route-snapshot              → ./src/execution/contract/execution-route-snapshot.ts
  ./execution-service                     → ./src/execution/contract/execution-service.ts
  ./execution-status                      → ./src/execution/contract/execution-status.ts
  ./execution-workflow                    → ./src/execution/contract/execution-workflow.ts
  ./model-registration-identity           → ./src/execution/contract/model-registration-identity.ts
  ./provider-connection-snapshot          → ./src/execution/contract/provider-connection-snapshot.ts
  ./configuration-operation               → ./src/operation/contract/configuration-operation.ts
  ./extension-operation                   → ./src/operation/contract/extension-operation.ts
  ./interactive-operation                 → ./src/operation/contract/interactive-operation.ts
  ./product-operation                     → ./src/operation/contract/product-operation.ts
  ./product-operation-service             → ./src/operation/contract/product-operation-service.ts
  ./thread-operation                      → ./src/operation/contract/thread-operation.ts
  ./workflow-operation                    → ./src/operation/contract/workflow-operation.ts
  ./interactive-command                   → ./src/operation/interactive/interactive-command.ts
  ./interactive-event                     → ./src/operation/interactive/interactive-event.ts
  ./interactive-session                   → ./src/operation/interactive/interactive-session.ts
  ./resident-interactive-feed             → ./src/resident/resident-interactive-feed.ts
  ./resident-operation-request            → ./src/resident/resident-operation-request.ts
  ./resident-service-handshake            → ./src/resident/resident-service-handshake.ts
  ./resident-service                      → ./src/resident/resident-service.ts
  ./pending-turn                          → ./src/thread/model/pending-turn.ts
  ./thread-record                         → ./src/thread/model/thread-record.ts
  ./thread-relationship                   → ./src/thread/model/thread-relationship.ts
  ./thread-result                         → ./src/thread/model/thread-result.ts
  ./thread-state                          → ./src/thread/model/thread-state.ts
  ./thread-summary                        → ./src/thread/model/thread-summary.ts
  ./transcript-page                       → ./src/thread/model/transcript-page.ts
  ./turn-record                           → ./src/thread/model/turn-record.ts
  ./workspace-record                      → ./src/thread/model/workspace-record.ts
  ./thread-interaction-repository         → ./src/thread/repository/thread-interaction-repository.ts
  ./thread-repository                     → ./src/thread/repository/thread-repository.ts
  ./thread-search-repository              → ./src/thread/repository/thread-search-repository.ts
  ./thread-summary-repository             → ./src/thread/repository/thread-summary-repository.ts
  ./transcript-repository                 → ./src/thread/repository/transcript-repository.ts
  ./turn-repository                       → ./src/thread/repository/turn-repository.ts
  ./usage-repository                      → ./src/thread/repository/usage-repository.ts
  ./thread-query-service                  → ./src/thread/query/thread-query-service.ts
  ./thread-tool-service                   → ./src/thread/tool/thread-tool-service.ts
  ./usage-projection                      → ./src/usage/usage-projection.ts
  ./usage-snapshot                        → ./src/usage/usage-snapshot.ts
  ./usage-snapshot-codec                  → ./src/usage/usage-snapshot-codec.ts
  ./workflow-definition                   → ./src/workflow/workflow-definition.ts
  ./workflow-service                      → ./src/workflow/workflow-service.ts

@rika/product-store
  ./product-database-layer                → ./src/database/product-database-layer.ts
  ./sqlite-thread-interaction-repository  → ./src/interaction/sqlite-thread-interaction-repository.ts
  ./sqlite-thread-search-repository       → ./src/search/sqlite-thread-search-repository.ts
  ./sqlite-thread-summary-repository      → ./src/summary/sqlite-thread-summary-repository.ts
  ./sqlite-thread-repository              → ./src/thread/sqlite-thread-repository.ts
  ./sqlite-transcript-repository          → ./src/transcript/sqlite-transcript-repository.ts
  ./sqlite-turn-repository                → ./src/turn/sqlite-turn-repository.ts
  ./sqlite-usage-repository               → ./src/usage/sqlite-usage-repository.ts

@rika/relay-execution
  ./baton-agent-definition                → ./src/agent/definition/baton-agent-definition.ts
  ./media-analysis-adapter                → ./src/model/provider/media-analysis-adapter.ts
  ./model-provider-runtime                → ./src/model/provider/model-provider-runtime.ts
  ./scripted-model-runtime                → ./src/model/provider/scripted-model-runtime.ts
  ./relay-execution-layer                 → ./src/relay/execution/relay-execution-layer.ts
  ./relay-workflow-compiler               → ./src/relay/relay-workflow-compiler.ts

@rika/terminal
  ./terminal-performance-evaluation       → ./src/performance/terminal-performance-evaluation.ts
  ./terminal-transcript-presentation      → ./src/presentation/transcript/terminal-transcript-presentation.ts
  ./transcript-viewport                   → ./src/presentation/transcript/transcript-viewport.ts
  ./opentui-surface                       → ./src/opentui/surface/opentui-surface.ts
  ./terminal-message                      → ./src/state/model/terminal-message.ts
  ./terminal-state                        → ./src/state/model/terminal-state.ts
  ./terminal-state-reducer                → ./src/state/reducer/terminal-state-reducer.ts
  ./terminal-session                      → ./src/terminal-session.ts
```

Memory adapters remain private to product-store tests. The left-hand subpath set is frozen in Slice 2. Where a final target file does not yet exist, Slice 2 may point that exact subpath directly at its current implementation file under a named migration waiver; several subpaths may temporarily share that old file. No forwarding TypeScript module is created. The owning later slice retargets the manifest entry to the exact right-hand final path in the same commit that moves the behavior. Slice 2 may remove one listed entry only after moving every cross-package caller inward in the same green commit. Later slices may not rename, add, or widen this surface without parent approval and updated exact-set export-contract tests.

## Total intended repository tree

A same-stem `*.test.ts` sits beside every behavior-bearing source leaf below unless the behavior is proved by one of the broader suites shown under `test/`. Type-only files, process entrypoints, prompts, and generated graph data do not receive placeholder tests.

```text
.
├── .agents/
│   ├── resume
│   ├── setup
│   └── skills/<existing Rika skills>
├── .claude/skills
├── .github/
│   ├── dependabot.yml
│   └── workflows/
│       ├── ci.yml
│       └── publish.yml
├── .githooks/
│   ├── post-merge
│   ├── post-rewrite
│   └── vendor
├── .gitignore
├── .oxlintrc.json
├── .prettierignore
├── .rgignore
├── AGENTS.md
├── CLAUDE.md
├── CONTEXT.md
├── GOAL.md
├── ISSUES.md
├── LICENSE
├── PRODUCT.md
├── README.md
├── bun.lock
├── install.sh
├── package.json
├── sgconfig.yml
├── tsconfig.json
├── turbo.json
├── vitest.config.ts
├── apps/
│   └── rika/
│       ├── AGENTS.md
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── client-main.ts
│       │   ├── interactive-main.ts
│       │   ├── performance-main.ts
│       │   ├── resident-main.ts
│       │   ├── rika-version.ts
│       │   ├── command/
│       │   │   ├── product/
│       │   │   │   ├── auth-command.ts
│       │   │   │   ├── configuration-command.ts
│       │   │   │   ├── diagnostics-command.ts
│       │   │   │   ├── extension-command.ts
│       │   │   │   ├── mcp-command.ts
│       │   │   │   ├── skill-command.ts
│       │   │   │   ├── thread-command.ts
│       │   │   │   ├── tool-catalog-command.ts
│       │   │   │   └── workflow-command.ts
│       │   │   └── root/
│       │   │       ├── cli-operation-dispatch.ts
│       │   │       ├── noninteractive-run-command.ts
│       │   │       ├── review-command.ts
│       │   │       └── rika-command.ts
│       │   ├── client/
│       │   │   ├── client-process.ts
│       │   │   ├── client-process-exit.ts
│       │   │   ├── interactive-runtime-restart.ts
│       │   │   └── private-runtime-launch.ts
│       │   ├── interactive/
│       │   │   ├── controller/
│       │   │   │   ├── interactive-controller.ts
│       │   │   │   ├── interactive-event-dispatch.ts
│       │   │   │   ├── terminal-interactive-feed.ts
│       │   │   │   ├── interactive-frame-batch.ts
│       │   │   │   ├── terminal-thread-selection.ts
│       │   │   │   └── terminal-turn-submission.ts
│       │   │   ├── input/
│       │   │   │   ├── changed-file-discovery.ts
│       │   │   │   ├── clipboard-image.ts
│       │   │   │   ├── goodbye-message.ts
│       │   │   │   ├── local-file-selection.ts
│       │   │   │   ├── prompt-attachment.ts
│       │   │   │   └── terminal-title.ts
│       │   │   └── process/
│       │   │       ├── interactive-process.ts
│       │   │       ├── interactive-process-layer.ts
│       │   │       └── terminal-lifecycle.ts
│       │   ├── observability/
│       │   │   ├── export-rika-logs.ts
│       │   │   ├── rika-log-status.ts
│       │   │   └── rika-process-logging.ts
│       │   ├── performance/
│       │   │   ├── performance-platform.ts
│       │   │   └── rika-performance-runner.ts
│       │   ├── provider/
│       │   │   ├── bedrock-auth-refresh.ts
│       │   │   └── openai/
│       │   │       ├── openai-auth-adapter.ts
│       │   │       ├── openai-credential-store.ts
│       │   │       └── openai-provider-auth.ts
│       │   ├── release/
│       │   │   ├── release-download.ts
│       │   │   ├── release-install.ts
│       │   │   ├── release-update.ts
│       │   │   └── relaunch-argument.ts
│       │   ├── resident/
│       │   │   ├── composition/
│       │   │   │   ├── resident-auth-layer.ts
│       │   │   │   ├── resident-configuration-adapter.ts
│       │   │   │   ├── lazy-execution-backend.ts
│       │   │   │   ├── resident-execution-layer.ts
│       │   │   │   ├── resident-product-layer.ts
│       │   │   │   └── resident-repository-layer.ts
│       │   │   └── process/
│       │   │       ├── resident-endpoint.ts
│       │   │       ├── resident-process.ts
│       │   │       ├── resident-process-launch.ts
│       │   │       └── resident-startup.ts
│       │   └── transport/
│       │       ├── AGENTS.md
│       │       ├── client/
│       │       │   ├── resident-client-connection.ts
│       │       │   ├── resident-client-feed.ts
│       │       │   ├── resident-client-reconnect.ts
│       │       │   ├── resident-client-session.ts
│       │       │   ├── resident-client-startup.ts
│       │       │   └── resident-client-transport.ts
│       │       ├── host/
│       │       │   ├── resident-host-command.ts
│       │       │   ├── resident-host-connection.ts
│       │       │   ├── resident-host-feed.ts
│       │       │   ├── resident-host-lifecycle.ts
│       │       │   ├── resident-host-operation.ts
│       │       │   ├── resident-host-transport.ts
│       │       │   └── resident-websocket-server.ts
│       │       └── protocol/
│       │           ├── resident-protocol-handshake.ts
│       │           ├── resident-message-codec.ts
│       │           └── resident-protocol.ts
│       └── test/
│           ├── tui-app.ts
│           ├── fixtures/
│           │   ├── process/
│           │   │   ├── interactive-pty.py
│           │   │   ├── logging-hard-exit.ts
│           │   │   ├── logging-soft-exit.ts
│           │   │   └── runtime-stub.ts
│           │   └── resident/
│           │       ├── resident-client-fixture.ts
│           │       ├── resident-host-fixture.ts
│           │       ├── resident-mismatched-client-fixture.ts
│           │       ├── resident-mismatched-host-fixture.ts
│           │       └── resident-old-host-fixture.ts
│           ├── integration/
│           │   ├── cli-operation.integration.test.ts
│           │   ├── shell-session.integration.test.ts
│           │   └── test-model-script.integration.test.ts
│           ├── process/
│           │   ├── client-cancel-on-quit.proc.test.ts
│           │   ├── client-cancel.proc.test.ts
│           │   ├── client-process.proc.test.ts
│           │   ├── performance-platform.proc.test.ts
│           │   ├── release-update.proc.test.ts
│           │   ├── resident-cancel-on-quit.proc.test.ts
│           │   ├── resident-delivery.proc.test.ts
│           │   ├── resident-lifecycle.proc.test.ts
│           │   └── resident-transport.proc.test.ts
│           ├── support/
│           │   ├── client-process-harness.ts
│           │   └── resident-transport-harness.ts
│           └── tui/
│               ├── rika-application.tui.test.ts
│               └── subagent-live-stream.tui.test.ts
├── packages/
│   ├── configuration/
│   │   ├── AGENTS.md
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── model-routing/
│   │   │   │   ├── behavior-mode.ts
│   │   │   │   ├── model-catalog.ts
│   │   │   │   ├── model-preset.ts
│   │   │   │   ├── model-route.ts
│   │   │   │   ├── model-route-label.ts
│   │   │   │   └── model-route-resolution.ts
│   │   │   ├── path-resolution/
│   │   │   │   ├── canonical-data-root.ts
│   │   │   │   ├── configuration-paths.ts
│   │   │   │   └── profile-data-paths.ts
│   │   │   └── settings/
│   │   │       ├── configuration-defaults.ts
│   │   │       ├── configuration-diagnostic.ts
│   │   │       ├── configuration-merge.ts
│   │   │       ├── configuration-service.ts
│   │   │       ├── configuration-settings-decoder.ts
│   │   │       ├── configuration-settings-input.ts
│   │   │       └── configuration-settings.ts
│   │   └── test/
│   │       └── contract/configuration-exports.contract.test.ts
│   ├── coding-tools/
│   │   ├── AGENTS.md
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── catalog/
│   │   │   │   ├── coding-tool-catalog.ts
│   │   │   │   ├── thread-tool-contract.ts
│   │   │   │   └── tool-invocation.ts
│   │   │   ├── delegation/
│   │   │   │   ├── agent-tool-contract.ts
│   │   │   │   └── agent-tool-result.ts
│   │   │   ├── media/
│   │   │   │   ├── media-view-service.ts
│   │   │   │   └── view-media-tool.ts
│   │   │   ├── policy/
│   │   │   │   ├── coding-tool-policy.ts
│   │   │   │   ├── local-safety-policy.ts
│   │   │   │   └── workspace-boundary-policy.ts
│   │   │   ├── process/
│   │   │   │   ├── bash-tool.ts
│   │   │   │   ├── shell-command-status-tool.ts
│   │   │   │   └── shell-process-registry.ts
│   │   │   ├── runtime/
│   │   │   │   ├── coding-tool-result.ts
│   │   │   │   ├── coding-tool-runtime-filesystem.ts
│   │   │   │   └── coding-tool-runtime.ts
│   │   │   ├── web-research/
│   │   │   │   ├── AGENTS.md
│   │   │   │   ├── parallel-web-search.ts
│   │   │   │   ├── read-web-page-service.ts
│   │   │   │   ├── read-web-page-tool.ts
│   │   │   │   ├── web-search-provider.ts
│   │   │   │   ├── web-search-service.ts
│   │   │   │   └── web-search-tool.ts
│   │   │   └── workspace/
│   │   │       ├── edit-file-tool.ts
│   │   │       ├── grep-files-tool.ts
│   │   │       ├── local-path.ts
│   │   │       ├── read-file-tool.ts
│   │   │       ├── unified-diff.ts
│   │   │       ├── workspace-file-search.ts
│   │   │       └── write-file-tool.ts
│   │   └── test/
│   │       ├── contract/coding-tool-catalog.contract.test.ts
│   │       ├── process/coding-tool-filesystem.proc.test.ts
│   │       └── support/coding-tool-test-layer.ts
│   ├── extensions/
│   │   ├── AGENTS.md
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── mcp/
│   │   │   │   ├── mcp-configuration.ts
│   │   │   │   ├── mcp-oauth-service.ts
│   │   │   │   ├── mcp-oauth-store.ts
│   │   │   │   └── mcp-runtime.ts
│   │   │   ├── plugin/
│   │   │   │   ├── execution-extension-service.ts
│   │   │   │   ├── plugin-contract.ts
│   │   │   │   ├── plugin-digest.ts
│   │   │   │   ├── plugin-loader.ts
│   │   │   │   └── plugin-registry.ts
│   │   │   └── skill/
│   │   │       ├── skill-file-system.ts
│   │   │       └── skill-registry.ts
│   │   └── test/
│   │       ├── contract/extension-activation.contract.test.ts
│   │       └── support/extension-test-layer.ts
│   ├── transcript/
│   │   ├── AGENTS.md
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── ordering/
│   │   │   │   ├── child-parent-correlation.ts
│   │   │   │   ├── transcript-unit-identity.ts
│   │   │   │   └── transcript-unit-order.ts
│   │   │   ├── presentation/
│   │   │   │   ├── model-usage-fallback.ts
│   │   │   │   └── recorded-shell-presentation.ts
│   │   │   ├── projection/
│   │   │   │   ├── nested-transcript-projection.ts
│   │   │   │   ├── partial-tool-input.ts
│   │   │   │   ├── transcript-child-event-fold.ts
│   │   │   │   ├── transcript-event-fold.ts
│   │   │   │   ├── transcript-fold-state.ts
│   │   │   │   ├── transcript-generic-event-fold.ts
│   │   │   │   ├── transcript-model-event-fold.ts
│   │   │   │   ├── transcript-projection.ts
│   │   │   │   ├── transcript-settlement.ts
│   │   │   │   └── transcript-tool-event-fold.ts
│   │   │   └── schema/
│   │   │       ├── transcript-presentation-model.ts
│   │   │       ├── transcript-projection-model.ts
│   │   │       ├── transcript-source-event.ts
│   │   │       └── transcript-unit.ts
│   │   └── test/
│   │       └── contract/transcript-projection.contract.test.ts
│   ├── product/
│   │   ├── AGENTS.md
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── agent/
│   │   │   │   ├── agent-profile.ts
│   │   │   │   ├── delegation-depth-policy.ts
│   │   │   │   └── product-agent-service.ts
│   │   │   ├── authentication/
│   │   │   │   ├── openai-auth-contract.ts
│   │   │   │   ├── openai-auth-flow.ts
│   │   │   │   └── openai-auth-service.ts
│   │   │   ├── context/
│   │   │   │   ├── context-file-system.ts
│   │   │   │   ├── context-mention-parser.ts
│   │   │   │   ├── context-preparation.ts
│   │   │   │   ├── context-resolution-service.ts
│   │   │   │   ├── context-usage.ts
│   │   │   │   ├── file-mention-parser.ts
│   │   │   │   └── resolved-context.ts
│   │   │   ├── execution/
│   │   │   │   ├── AGENTS.md
│   │   │   │   ├── contract/
│   │   │   │   │   ├── execution-approval.ts
│   │   │   │   │   ├── execution-child-run.ts
│   │   │   │   │   ├── execution-event.ts
│   │   │   │   │   ├── execution-identifier.ts
│   │   │   │   │   ├── execution-inspection.ts
│   │   │   │   │   ├── execution-request.ts
│   │   │   │   │   ├── execution-route-snapshot.ts
│   │   │   │   │   ├── execution-service.ts
│   │   │   │   │   ├── execution-status.ts
│   │   │   │   │   ├── execution-workflow.ts
│   │   │   │   │   ├── model-registration-identity.ts
│   │   │   │   │   └── provider-connection-snapshot.ts
│   │   │   │   ├── ingest/
│   │   │   │   │   ├── execution-ingest-commit.ts
│   │   │   │   │   ├── execution-ingest-event.ts
│   │   │   │   │   ├── execution-ingest-restore.ts
│   │   │   │   │   ├── execution-ingest-service.ts
│   │   │   │   │   ├── execution-ingest-state.ts
│   │   │   │   │   ├── execution-projection-contract.ts
│   │   │   │   │   ├── execution-projection-patch.ts
│   │   │   │   │   └── execution-projection-state.ts
│   │   │   │   └── lifecycle/
│   │   │   │       ├── abandoned-product-work-settlement.ts
│   │   │   │       ├── child-projection-follower.ts
│   │   │   │       ├── execution-projection-reconciliation.ts
│   │   │   │       ├── execution-projection-tree.ts
│   │   │   │       ├── product-execution-quiescence.ts
│   │   │   │       ├── product-execution-stop.ts
│   │   │   │       └── root-execution-event.ts
│   │   │   ├── operation/
│   │   │   │   ├── contract/
│   │   │   │   │   ├── configuration-operation.ts
│   │   │   │   │   ├── extension-operation.ts
│   │   │   │   │   ├── interactive-operation.ts
│   │   │   │   │   ├── product-operation.ts
│   │   │   │   │   ├── product-operation-service.ts
│   │   │   │   │   ├── thread-operation.ts
│   │   │   │   │   └── workflow-operation.ts
│   │   │   │   ├── dispatch/
│   │   │   │   │   ├── authentication-operation-dispatch.ts
│   │   │   │   │   ├── configuration-operation-dispatch.ts
│   │   │   │   │   ├── extension-operation-dispatch.ts
│   │   │   │   │   ├── product-operation-dispatch.ts
│   │   │   │   │   ├── noninteractive-operation-dispatch.ts
│   │   │   │   │   ├── review-operation-dispatch.ts
│   │   │   │   │   ├── thread-operation-dispatch.ts
│   │   │   │   │   └── workflow-operation-dispatch.ts
│   │   │   │   └── interactive/
│   │   │   │       ├── child-run-follower.ts
│   │   │   │       ├── interactive-command.ts
│   │   │   │       ├── interactive-control.ts
│   │   │   │       ├── interactive-event.ts
│   │   │   │       ├── interactive-feed-overflow.ts
│   │   │   │       ├── interactive-operation-feed.ts
│   │   │   │       ├── interactive-thread-selection.ts
│   │   │   │       ├── interactive-session.ts
│   │   │   │       ├── interactive-turn-submission.ts
│   │   │   │       └── pending-turn-promotion.ts
│   │   │   ├── resident/
│   │   │   │   ├── resident-interactive-feed.ts
│   │   │   │   ├── resident-operation-request.ts
│   │   │   │   ├── resident-service-handshake.ts
│   │   │   │   └── resident-service.ts
│   │   │   ├── thread/
│   │   │   │   ├── model/
│   │   │   │   │   ├── pending-turn.ts
│   │   │   │   │   ├── thread-relationship.ts
│   │   │   │   │   ├── thread-result.ts
│   │   │   │   │   ├── thread-state.ts
│   │   │   │   │   ├── thread-summary.ts
│   │   │   │   │   ├── thread-record.ts
│   │   │   │   │   ├── transcript-page.ts
│   │   │   │   │   ├── turn-record.ts
│   │   │   │   │   └── workspace-record.ts
│   │   │   │   ├── query/
│   │   │   │   │   ├── thread-activity.ts
│   │   │   │   │   ├── thread-query-service.ts
│   │   │   │   │   ├── thread-result-delivery.ts
│   │   │   │   │   └── thread-title-policy.ts
│   │   │   │   ├── queue/
│   │   │   │   │   ├── pending-turn-policy.ts
│   │   │   │   │   ├── root-turn-owner.ts
│   │   │   │   │   ├── turn-queue-promotion.ts
│   │   │   │   │   └── turn-queue-state.ts
│   │   │   │   ├── repository/
│   │   │   │   │   ├── thread-interaction-repository.ts
│   │   │   │   │   ├── thread-repository.ts
│   │   │   │   │   ├── thread-search-repository.ts
│   │   │   │   │   ├── thread-summary-repository.ts
│   │   │   │   │   ├── transcript-repository.ts
│   │   │   │   │   ├── turn-repository.ts
│   │   │   │   │   └── usage-repository.ts
│   │   │   │   └── tool/
│   │   │   │       ├── thread-tool-action.ts
│   │   │   │       └── thread-tool-service.ts
│   │   │   ├── transcript/
│   │   │   │   ├── thread-transcript-result.ts
│   │   │   │   ├── transcript-bounds.ts
│   │   │   │   ├── transcript-repair.ts
│   │   │   │   └── thread-transcript-window.ts
│   │   │   ├── usage/
│   │   │   │   ├── usage-active-time.ts
│   │   │   │   ├── usage-attempt.ts
│   │   │   │   ├── usage-event.ts
│   │   │   │   ├── usage-fold.ts
│   │   │   │   ├── usage-projection.ts
│   │   │   │   ├── usage-snapshot-codec.ts
│   │   │   │   ├── usage-snapshot.ts
│   │   │   │   └── usage-total.ts
│   │   │   └── workflow/
│   │   │       ├── workflow-definition.ts
│   │   │       ├── workflow-schema.ts
│   │   │       └── workflow-service.ts
│   │   └── test/
│   │       ├── contract/
│   │       │   ├── execution-service.contract.test.ts
│   │       │   ├── product-operation.contract.test.ts
│   │       │   └── repository-port.contract.test.ts
│   │       └── support/product-test-layer.ts
│   ├── product-store/
│   │   ├── AGENTS.md
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── database/
│   │   │   │   ├── product-database-inspection.ts
│   │   │   │   ├── product-database-layer.ts
│   │   │   │   ├── product-database-preflight.ts
│   │   │   │   └── product-database-schema-manifest.ts
│   │   │   ├── interaction/
│   │   │   │   ├── memory-thread-interaction-repository.ts
│   │   │   │   ├── sqlite-thread-interaction-repository.ts
│   │   │   │   └── thread-interaction-row-codec.ts
│   │   │   ├── migration/
│   │   │   │   ├── AGENTS.md
│   │   │   │   ├── execution/
│   │   │   │   │   ├── product-migration-004-execution-extension-pins.ts
│   │   │   │   │   ├── product-migration-007-execution-route-pins.ts
│   │   │   │   │   ├── product-migration-008-review-fan-out-owners.ts
│   │   │   │   │   ├── product-migration-013-provider-execution-routes.ts
│   │   │   │   │   └── product-migration-028-product-route-snapshot.ts
│   │   │   │   ├── thread/
│   │   │   │   │   ├── product-migration-001-baseline.ts
│   │   │   │   │   ├── product-migration-002-turns.ts
│   │   │   │   │   ├── product-migration-003-queued-turn-status.ts
│   │   │   │   │   ├── product-migration-005-turn-prompt-parts.ts
│   │   │   │   │   ├── product-migration-006-drop-thread-session-id.ts
│   │   │   │   │   ├── product-migration-010-thread-summaries.ts
│   │   │   │   │   ├── product-migration-012-queue-state-and-current-transcripts.ts
│   │   │   │   │   ├── product-migration-014-durable-queue-claims.ts
│   │   │   │   │   ├── product-migration-017-thread-search-projection.ts
│   │   │   │   │   ├── product-migration-018-durable-thread-coordination.ts
│   │   │   │   │   ├── product-migration-019-turn-stop-intent.ts
│   │   │   │   │   ├── product-migration-021-materialized-thread-summaries.ts
│   │   │   │   │   └── product-migration-026-discriminated-turns.ts
│   │   │   │   ├── transcript/
│   │   │   │   │   ├── product-migration-009-transcript-projection.ts
│   │   │   │   │   ├── product-migration-011-semantic-transcript-projection.ts
│   │   │   │   │   ├── product-migration-015-usage-cursor-checkpoints.ts
│   │   │   │   │   ├── product-migration-016-pricing-version-checkpoints.ts
│   │   │   │   │   ├── product-migration-022-reconciled-child-trees.ts
│   │   │   │   │   ├── product-migration-023-consumed-execution-checkpoints.ts
│   │   │   │   │   └── product-migration-025-stable-transcript-unit-order.ts
│   │   │   │   ├── usage/
│   │   │   │   │   ├── product-migration-020-usage-projection.ts
│   │   │   │   │   ├── product-migration-024-drop-usage-repairs.ts
│   │   │   │   │   └── product-migration-027-usage-projection-sources.ts
│   │   │   │   └── product-migration-registry.ts
│   │   │   ├── search/
│   │   │   │   ├── memory-thread-search-repository.ts
│   │   │   │   ├── sqlite-thread-search-repository.ts
│   │   │   │   └── thread-search-row-codec.ts
│   │   │   ├── summary/
│   │   │   │   ├── memory-thread-summary-repository.ts
│   │   │   │   ├── sqlite-thread-summary-repository.ts
│   │   │   │   └── thread-summary-row-codec.ts
│   │   │   ├── thread/
│   │   │   │   ├── memory-thread-repository.ts
│   │   │   │   ├── sqlite-thread-repository.ts
│   │   │   │   └── thread-row-codec.ts
│   │   │   ├── transcript/
│   │   │   │   ├── memory-transcript-repository.ts
│   │   │   │   ├── sqlite-transcript-repository.ts
│   │   │   │   ├── transcript-checkpoint-codec.ts
│   │   │   │   ├── transcript-repository-test-layer.ts
│   │   │   │   └── transcript-unit-row-codec.ts
│   │   │   ├── turn/
│   │   │   │   ├── memory-turn-repository.ts
│   │   │   │   ├── sqlite-turn-repository.ts
│   │   │   │   ├── turn-queue-transaction.ts
│   │   │   │   └── turn-row-codec.ts
│   │   │   └── usage/
│   │   │       ├── memory-usage-repository.ts
│   │   │       ├── sqlite-usage-repository.ts
│   │   │       └── usage-row-codec.ts
│   │   └── test/
│   │       ├── contract/
│   │       │   ├── repository-memory-sqlite-parity.contract.test.ts
│   │       │   └── transcript-checkpoint-delta.contract.test.ts
│   │       ├── fixtures/
│   │       │   ├── product-migration-oracle-v27.fixture.json
│   │       │   └── product-route-snapshot.fixture.json
│   │       ├── integration/
│   │       │   ├── product-database-migration.integration.test.ts
│   │       │   ├── product-database-preflight.integration.test.ts
│   │       │   ├── product-database-rejection.integration.test.ts
│   │       │   ├── product-migration-data-rewrite.integration.test.ts
│   │       │   ├── thread-repository-sqlite.integration.test.ts
│   │       │   ├── transcript-repository-sqlite.integration.test.ts
│   │       │   └── turn-repository-sqlite.integration.test.ts
│   │       └── support/sqlite-product-store-harness.ts
│   ├── relay-execution/
│   │   ├── AGENTS.md
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── agent/
│   │   │   │   ├── definition/
│   │   │   │   │   ├── baton-agent-definition.ts
│   │   │   │   │   ├── baton-agent-preset.ts
│   │   │   │   │   └── painter-capability-policy.ts
│   │   │   │   ├── delegation/
│   │   │   │   │   ├── child-execution-identifier.ts
│   │   │   │   │   ├── child-result-resolution.ts
│   │   │   │   │   ├── delegation-tool-policy.ts
│   │   │   │   │   └── subagent-join.ts
│   │   │   │   └── prompt/
│   │   │   │       ├── child.prompt.txt
│   │   │   │       ├── librarian.prompt.txt
│   │   │   │       ├── oracle.prompt.txt
│   │   │   │       ├── painter.prompt.txt
│   │   │   │       ├── read-thread.prompt.txt
│   │   │   │       ├── review.prompt.txt
│   │   │   │       ├── root.prompt.txt
│   │   │   │       ├── surgeon.prompt.txt
│   │   │   │       ├── task.prompt.txt
│   │   │   │       └── title.prompt.txt
│   │   │   ├── blob/
│   │   │   │   ├── inline-blob-codec.ts
│   │   │   │   └── inline-blob-store.ts
│   │   │   ├── model/
│   │   │   │   ├── compaction/
│   │   │   │   │   ├── context-compaction.ts
│   │   │   │   │   └── context-tokenizer.ts
│   │   │   │   ├── provider/
│   │   │   │   │   ├── media-analysis-adapter.ts
│   │   │   │   │   ├── model-provider-registration.ts
│   │   │   │   │   ├── model-provider-runtime.ts
│   │   │   │   │   ├── relay-model-registration.ts
│   │   │   │   │   ├── relay-provider-runtime.ts
│   │   │   │   │   └── scripted-model-runtime.ts
│   │   │   │   └── routing/
│   │   │   │       ├── model-resilience-policy.ts
│   │   │   │       ├── relay-model-registry.ts
│   │   │   │       ├── prompt-cache-policy.ts
│   │   │   │       └── streaming-only-model.ts
│   │   │   ├── relay/
│   │   │   │   ├── AGENTS.md
│   │   │   │   ├── execution/
│   │   │   │   │   ├── relay-approval-adapter.ts
│   │   │   │   │   ├── relay-child-result.ts
│   │   │   │   │   ├── relay-event-mapping.ts
│   │   │   │   │   ├── relay-execution-adapter.ts
│   │   │   │   │   ├── relay-execution-follow.ts
│   │   │   │   │   ├── relay-execution-identifier.ts
│   │   │   │   │   ├── relay-execution-layer.ts
│   │   │   │   │   ├── relay-execution-recovery.ts
│   │   │   │   │   ├── relay-execution-tree.ts
│   │   │   │   │   └── relay-tool-runtime.ts
│   │   │   │   ├── host/
│   │   │   │   │   ├── relay-fan-out-host.ts
│   │   │   │   │   ├── relay-thread-host.ts
│   │   │   │   │   └── relay-workflow-host.ts
│   │   │   │   └── relay-workflow-compiler.ts
│   │   └── test/
│   │       ├── integration/
│   │       │   ├── relay-execution.integration.test.ts
│   │       │   ├── relay-recovery.integration.test.ts
│   │       │   └── relay-workflow.integration.test.ts
│   │       ├── process/
│   │       │   ├── execution-recovery.proc.test.ts
│   │       │   └── workflow-execution.proc.test.ts
│   │       └── support/relay-execution-harness.ts
│   └── terminal/
│       ├── AGENTS.md
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── opentui/
│       │   │   ├── AGENTS.md
│       │   │   ├── rendering/
│       │   │   │   ├── opentui-render-block.ts
│       │   │   │   ├── opentui-renderer.ts
│       │   │   │   └── opentui-spinner.ts
│       │   │   └── surface/
│       │   │       ├── opentui-composer-region.ts
│       │   │       ├── opentui-input.ts
│       │   │       ├── opentui-lifecycle.ts
│       │   │       ├── opentui-overlay-region.ts
│       │   │       ├── opentui-sidebar-region.ts
│       │   │       ├── opentui-surface-construction.ts
│       │   │       ├── opentui-surface.ts
│       │   │       └── opentui-transcript-region.ts
│       │   ├── performance/
│       │   │   ├── terminal-performance-evaluation.ts
│       │   │   ├── terminal-performance-metric.ts
│       │   │   └── terminal-performance-workload.ts
│       │   ├── presentation/
│       │   │   ├── markdown/
│       │   │   │   ├── markdown-renderer.ts
│       │   │   │   ├── styled-text.ts
│       │   │   │   └── syntax-highlighter.ts
│       │   │   ├── terminal/
│       │   │   │   ├── command-palette.ts
│       │   │   │   ├── terminal-format.ts
│       │   │   │   ├── terminal-keymap.ts
│       │   │   │   └── terminal-theme.ts
│       │   │   ├── tool/
│       │   │   │   ├── diff-renderer.ts
│       │   │   │   ├── pierre-diff-adapter.ts
│       │   │   │   └── tool-summary.ts
│       │   │   └── transcript/
│       │   │       ├── execution-event-presentation.ts
│       │   │       ├── transcript-attachment.ts
│       │   │       ├── terminal-transcript-presentation.ts
│       │   │       ├── transcript-row.ts
│       │   │       ├── transcript-viewport.ts
│       │   │       └── terminal-transcript-window.ts
│       │   ├── terminal-session.ts
│       │   └── state/
│       │       ├── model/
│       │       │   ├── terminal-activity-state.ts
│       │       │   ├── terminal-composer-state.ts
│       │       │   ├── terminal-layout-state.ts
│       │       │   ├── terminal-loadable-state.ts
│       │       │   ├── terminal-message.ts
│       │       │   ├── terminal-prompt-part.ts
│       │       │   ├── terminal-queue-state.ts
│       │       │   ├── terminal-state.ts
│       │       │   ├── terminal-thread-navigation.ts
│       │       │   └── terminal-usage-state.ts
│       │       └── reducer/
│       │           ├── terminal-data-event-reducer.ts
│       │           ├── terminal-execution-event-reducer.ts
│       │           ├── terminal-keyboard-reducer.ts
│       │           ├── terminal-overlay-reducer.ts
│       │           ├── terminal-queue-input-reducer.ts
│       │           ├── terminal-state-reducer.ts
│       │           └── terminal-transcript-event-reducer.ts
│       └── test/
│           ├── fixtures/visual/<existing named frame, image, and style fixtures>
│           ├── integration/
│           │   ├── opentui-input-resize.integration.test.ts
│           │   ├── opentui-surface.integration.test.ts
│           │   └── opentui-transcript-window.integration.test.ts
│           └── support/opentui-surface-harness.ts
├── tooling/
│   ├── repository-policy/
│   │   ├── AGENTS.md
│   │   ├── package.json
│   │   ├── test-ownership-exceptions.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── policy/
│   │       │   ├── dependency-count-policy.ts
│   │       │   ├── directory-size-policy.ts
│   │       │   ├── export-declaration-policy.ts
│   │       │   ├── file-size-policy.ts
│   │       │   ├── filename-policy.ts
│   │       │   ├── folder-depth-policy.ts
│   │       │   ├── function-size-policy.ts
│   │       │   ├── package-boundary-policy.ts
│   │       │   ├── single-child-directory-policy.ts
│   │       │   ├── test-topology-policy.ts
│   │       │   └── waiver-policy.ts
│   │       ├── repository-policy-diagnostic.ts
│   │       └── repository-policy-main.ts
│   ├── repository-graph/
│   │   ├── AGENTS.md
│   │   ├── dependency-cruiser.config.cjs
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── command/
│   │       │   ├── check-command.ts
│   │       │   ├── dependency-command.ts
│   │       │   ├── generate-graph-command.ts
│   │       │   ├── graph-command.ts
│   │       │   ├── graph-freshness-command.ts
│   │       │   ├── impact-command.ts
│   │       │   ├── test-command.ts
│   │       │   ├── user-command.ts
│   │       │   ├── violation-command.ts
│   │       │   └── why-command.ts
│   │       ├── graph/
│   │       │   ├── dependency-graph.ts
│   │       │   ├── package-dependency-graph.ts
│   │       │   ├── repository-graph-query.ts
│   │       │   └── test-relationship-graph.ts
│   │       └── repository-graph-main.ts
│   └── repository-generator/
│       ├── AGENTS.md
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── generator/
│           │   ├── capability-module-generator.ts
│           │   ├── effect-service-generator.ts
│           │   ├── package-generator.ts
│           │   └── same-stem-test-generator.ts
│           └── repository-generator-main.ts
├── scripts/
│   ├── benchmark/
│   │   ├── baselines/fold-persistence.json
│   │   ├── benchmark-baseline.ts
│   │   ├── benchmark-runner.ts
│   │   ├── benchmark-statistics.ts
│   │   ├── fold-persistence-benchmark.ts
│   │   ├── performance-comparison.ts
│   │   ├── performance-metric-policy.ts
│   │   ├── populated-root-seed.ts
│   │   └── warm-resident-benchmark.ts
│   ├── capture/
│   │   └── tui-visual-capture.ts
│   ├── installation/
│   │   ├── install-contract.ts
│   │   ├── install-local.ts
│   │   ├── local-install.ts
│   │   └── uninstall-local.ts
│   ├── packaging/
│   │   ├── archive-contract.ts
│   │   ├── npm-package.ts
│   │   └── package-target.ts
│   ├── release/
│   │   └── release-smoke.ts
│   └── upstream/
│       └── upstream-source.ts
├── test/
│   ├── live/
│   │   ├── README.md
│   │   ├── live-model.test.ts
│   │   └── vitest.config.ts
│   ├── process/
│   │   ├── install-upgrade.proc.test.ts
│   │   └── local-install.proc.test.ts
│   ├── release/
│   │   ├── archive-contract.test.ts
│   │   ├── install-contract.test.ts
│   │   ├── package-target.test.ts
│   │   └── release-workflow.test.ts
│   └── support/
│       └── relay-polling-setup.ts
├── docs/
│   ├── decisions/
│   │   ├── agent-native-repository-structure.md
│   │   └── <existing lasting decisions>
│   ├── features/<existing capability contracts>
│   ├── generated/
│   │   ├── dependency-graph.json
│   │   ├── package-dependency-graph.json
│   │   ├── production-dependency-graph.json
│   │   └── test-dependency-graph.json
│   ├── tradeoffs/<existing tradeoffs>
│   └── effect-module-conventions.md
├── ast-grep/rules/<Effect and forbidden-import rules>
└── plans/
    └── 027-agent-native-repository-architecture.md
```

The tree is a target ownership map, not permission to create empty placeholders. A listed leaf is created when its current behavior moves. If two listed leaves prove inseparable and together remain within policy, they may be merged under the more precise filename. If a listed leaf would exceed 500 lines or eight exports, it must split at the next real semantic boundary without adding a third directory level.

## Structural tooling

### Oxlint and ast-grep

Use existing released rules where they fit:

- `max-lines` fails at 800;
- `max-lines-per-function` fails at 150;
- `max-dependencies` fails at 18;
- `no-barrel-file`;
- `no-cycle`;
- `no-default-export`;
- `no-restricted-imports`; and
- Vitest test-quality rules.

Repository policy emits the 500/80/12/20 warnings, enforces the changed-file 500-line growth gate, and enforces the 30-file directory ceiling, AST declaration export limit, depth, basename, and single-child rules. Policy tests prove both warning and failure thresholds. Keep existing Effect boundary rules. Add narrow ast-grep rules only for constraints that are syntactic and stable, such as `export *`, forbidden root namespace barrels, or imports of an adapter package from product.

### Repository policy

`tooling/repository-policy` enforces filename, file/function size, exported declaration count, direct dependency count, directory size, folder depth, single-child directories, package kinds and exact allowed edges, exact exports, test topology, checked-in build-output absence, and migration waivers. AST inspection uses a released parser API verified against the pinned TypeScript/Oxc versions. Every failure includes the violating path, rule, expected form, and a concrete rename or move example.

A temporary machine-readable migration waiver file may exist only while old violations remain. Every entry names its removal slice. The final slice deletes the waiver file and the waiver code path.

### Structural graph

Use dependency-cruiser as the file import source of truth after a compatibility spike against Bun workspaces, TypeScript 7 bundler resolution, package exports, prompt text assets, and test files.

Generate and commit exact structural data only:

- `docs/generated/dependency-graph.json`;
- `docs/generated/production-dependency-graph.json`;
- `docs/generated/test-dependency-graph.json`; and
- `docs/generated/package-dependency-graph.json`.

Every artifact has `schemaVersion: 1`. File nodes contain `path`, `workspace`, `kind`, `production`, and exact public export names. Edges contain `from`, `to`, and `relationship` (`runtime`, `type`, `test`, or `asset`). Test nodes use one exact kind: `unit-test`, `integration-test`, `contract-test`, `tui-test`, `process-test`, or `fixture`. Derived graphs are canonical sorted projections of the complete graph. Generation writes stable two-space JSON with one trailing newline.

The exact `.rgignore` baseline is:

```gitignore
node_modules/
dist/
coverage/
.turbo/
.cache/
tmp/
artifacts/
repos/
docs/generated/
**/*.snap
**/*.snapshot.*
**/*.recording.*
**/*.payload.*
**/test/fixtures/visual/*.frame.txt
**/test/fixtures/visual/*.ppm
**/test/fixtures/visual/*.styles.json
```

It does not hide behavioral `*.test.ts`, `*.tui.test.ts`, or `*.proc.test.ts`. Other fixtures remain visibly named under `test/fixtures/` or with `.fixture.*`. Graph/test queries rank production source, direct unit tests, integration/contract tests, TUI/process tests, and fixtures in that order. Repository-policy tests prove every ignored/noisy sample and every still-searchable behavioral sample. Policy also rejects checked-in compiled JavaScript beside TypeScript and generated output outside a named generated path.

The query CLI exposes `dependencies`, `users`, `impact`, `tests`, `why`, `graph`, `violations`, and `check` subcommands with text and JSON output. `check` reports affected packages, ranked tests, and canonical commands but never executes or orchestrates them; Bun, Vitest, and Turborepo still own execution. The CLI does not provide symbol references or semantic summaries. TypeScript language tooling remains the symbol-reference source of truth.

The policy and graph workspaces define these exact one-command scripts:

```json
{
  "name": "@rika/repository-policy",
  "scripts": {
    "check": "bun ./src/repository-policy-main.ts",
    "typecheck": "bun ../../node_modules/typescript/lib/tsc.js --noEmit"
  }
}
```

```json
{
  "name": "@rika/repository-graph",
  "scripts": {
    "generate": "bun ./src/repository-graph-main.ts generate",
    "query": "bun ./src/repository-graph-main.ts query",
    "check": "bun ./src/repository-graph-main.ts check-generated",
    "typecheck": "bun ../../node_modules/typescript/lib/tsc.js --noEmit"
  }
}
```

Canonical invocations are:

```bash
bun --cwd tooling/repository-graph generate
bun --cwd tooling/repository-graph check
bun --cwd tooling/repository-graph query -- impact packages/product/src/thread/query/thread-query-service.ts
bun --cwd tooling/repository-graph query -- check packages/product/src/thread/query/thread-query-service.ts
```

`generate` writes the four committed paths. `check` generates to a scoped temporary directory and byte-compares all four outputs, so it never repairs stale files during validation.

Root `package.json` adds one-command internal scripts `"repository-policy": "bun --cwd tooling/repository-policy check"` and `"repository-graph-check": "bun --cwd tooling/repository-graph check"`. Turbo adds exact root tasks `//#repository-policy` and `//#repository-graph-check`; both include tooling/config/source/test/manifest inputs. The final root `check` command is one Turborepo command:

```text
bun turbo run --continue build typecheck "//#test-unit" "//#repository-policy" "//#repository-graph-check" "//#diagnostics" "//#ast-grep-check" "//#format-check" "//#lint"
```

The old `//#dependency-check` task disappears after its behavior moves into repository policy. No colon-named root script or validation dispatcher is added.

### Performance evidence contract

Capture three independent source runs and three independent packaged runs before the migration, then the same six candidate runs after affected milestones and at final acceptance. JSON is comparable only when `schemaVersion`, workload identity, terminal dimensions, platform, architecture, pinned Bun version, metric IDs, and internal sample counts match.

`performance-metric-policy.ts` lists every gated metric ID, direction, and tolerance. Targeted `lte` metrics must remain at or below both the product target and 120% of the baseline median; targeted `gte` metrics must remain at or above both the target and 80% of the baseline median; `eq` metrics must remain exact. A baseline failed target must improve to the product target rather than using tolerance as an excuse. Untargeted metrics are recorded but never cited as pass evidence. A measured metric becoming unsupported fails, the unsupported set may shrink but never grow, and missing metrics or incompatible workload/machine data fail comparison.

The canonical comparison command is:

```bash
bun scripts/benchmark/performance-comparison.ts --baseline <three-baseline-json-files> --candidate <three-candidate-json-files>
```

Unit tests cover directionality, medians, target precedence, incompatible workloads, missing metrics, and unsupported transitions. Existing unsupported GOAL metrics remain explicit residual gaps; this architecture migration does not claim they pass.

## Implementation slices

### 0. Approve, synchronize, and freeze the baseline

- **Result:** The approved plan is committed on top of current `origin/main`, and every later worker starts from a clean, green baseline.
- **Changes:** Fast-forward the missing upstream commit. Recompute current file, exported declaration, directory, and graph inventories with exact inclusion/exclusion predicates and store them as temporary tooling inputs. Before any persistence extraction, use the current monolith to capture and review `product-migration-oracle-v27.fixture.json`: every prefix's migration rows, canonical `sqlite_schema` SQL, indexes, triggers, constraints, representative rewrite rows, and rejection file/side-file hashes. Mark Plan 026 superseded and remove it when this plan lands. Capture three source and three current-target packaged diagnostics-performance JSON runs plus the fold/persistence benchmark as pre-migration artifacts under ignored `artifacts/performance/`.
- **Tests:** No behavior changes.
- **Checks:** `bun run check`, `bun run test-tui`, `bun run test-proc`, `bun run bench`, one current-target package build, three `bun run dev -- diagnostics performance` runs, and three packaged `rika diagnostics performance` runs. The performance artifacts record every measured, failed, and unsupported metric; unsupported metrics do not become passes.
- **Stop conditions:** The worktree is dirty for unrelated reasons, the branch cannot fast-forward, or any current suite is red.

### 1. Add migration-mode architecture guardrails

- **Result:** New violations cannot appear while old violations are explicitly bounded.
- **Changes:** Add `tooling/*` to Bun workspaces and package discovery; include `tooling/**` in root TypeScript, lint, diagnostics, ast-grep, Turbo inputs, and test discovery; pin dependency-cruiser and parser dependencies in the catalog/lockfile; and give each tooling workspace simple `typecheck` and test participation. Add package-kind metadata, `.rgignore`, repository-policy tooling, the dependency-cruiser spike, graph generation/query tooling, generated graphs, the lasting decision, updated Effect module conventions, and concise root/nested instruction maps. Move the current `scripts/check-dependencies.ts` manifest/link/provider checks and tests into `package-boundary-policy.ts`; delete the old script only after parity tests pass. Keep root `AGENTS.md` near 80–120 lines and reduce `CLAUDE.md` to `@AGENTS.md` so one instruction source owns shared rules. Update the unit Vitest project to include `packages/*/src/**/*.test.ts`, `apps/*/src/**/*.test.ts`, and `tooling/*/src/**/*.test.ts` while continuing to exclude `*.tui.test.ts` and `*.proc.test.ts`. Add temporary waivers tied to named slices. Vitest coverage remains disabled and is not an acceptance claim for this migration; the existing inactive 95% thresholds do not count as proof. Enabling coverage would be a separate workflow decision with exact include/exclude rules.
- **Tests:** Tooling unit tests cover every policy diagnostic and graph query relationship. A discovery test proves representative colocated package, app, and tooling tests execute in the unit project.
- **Checks:** Tooling typechecks/tests, generated graph freshness, then `bun run check`.
- **Stop conditions:** Dependency-cruiser cannot resolve Bun workspace exports, TypeScript 7, text assets, or test edges exactly; a policy threshold cannot be assigned to a tested enforcement owner; or `bun run check` can pass while a tooling package is broken. Stop for an approved graph-source decision rather than committing a partial graph.
- **Cleanup:** The migration mode and waiver path must be deleted in Slice 10.

### 2. Rename packages and public specifiers

- **Result:** Every import and workspace path uses the final descriptive package names, while behavior remains unchanged.
- **Changes:** Apply the package move map with `git mv`; commit the frozen export subpath set above with no `.` entries, using direct temporary manifest targets under migration waivers where final files do not yet exist; migrate every root-package import to one exact subpath; remove private-library barrel build scripts; and update manifests, Bun lockfile, Turbo inputs, Vitest paths, CLI build/package scripts, source imports, test imports, and architecture checks. Parallel work is blocked until every manifest and export-contract test is green.
- **Tests:** Package export contract tests plus all deterministic tests.
- **Checks:** `bun run build`, `bun run typecheck`, `bun run test`, and dependency graph validation.
- **Cleanup:** Delete old package directories, old package names, path aliases, and forwarding modules in the same slice.

### 3. Reverse adapter dependencies

- **Result:** Product owns repository and execution ports; SQLite and Relay/Baton packages implement them; the CLI composition root chooses adapters.
- **Changes:** Move Thread, Turn, summary, state, transcript-page, repository-service, and execution-service contracts into `@rika/product`. Replace the persisted adapter-shaped execution route with `ExecutionRouteSnapshot`, `ProviderConnectionSnapshot`, and opaque `ModelRegistrationIdentity`; add migration 028 to transform existing route JSON. Remove Baton `ModelRegistry`, registration keys/runtime objects, provider SDK types, and adapter-only registration operations from product. Add the explicit Relay conversion boundary that derives Baton registrations from the snapshot. Make `@rika/product-store` and `@rika/relay-execution` import product contracts. Update resident composition and tests.
- **Tests:** Product port contracts, memory/SQLite parity, Relay adapter contract, current operation tests, source-graph checks, and resident composition tests proving one resident owns both product and Relay databases while clients cannot construct competing database/runtime graphs.
- **Checks:** Focused package tests, package graph, `bun run check`, and `bun run test-proc` for resident composition.
- **Stop conditions:** SQL or Relay/Baton/provider SDK types leak into product contracts; product imports either adapter; migrations 1–27 change; migration 028 cannot preserve the pinned route identity needed for existing durable Executions; or execution authority moves out of Relay.

### 4. Reshape foundation packages

After Slice 3, run four isolated package tracks. Public export subpaths are fixed before parallel work begins.

#### 4A. Configuration

Move model routing, settings, and paths into the target folders; split `config-contract.ts`; replace generic service symbols; colocate narrow tests; remove the root barrel.

#### 4B. Coding tools

Move tool definitions beside their owned workspace/process/media/web capabilities; disambiguate service/tool duplicate basenames; split `tool-runtime.ts`; preserve Effect interruption, bounded output, and provider restrictions.

#### 4C. Extensions

Group MCP, plugin, and skill lifecycle; split file-system and OAuth concerns; preserve generation pins and Baton public contracts.

#### 4D. Transcript

Split the fold by event family, state, settlement, ordering, and nesting; separate schemas; preserve unit identity, ordering, transient behavior, and bounded projection semantics.

- **Tests:** Each track moves narrow tests beside source and runs its package contract/integration suites.
- **Checks:** Package typecheck/test, export-map contract, repository policy, and graph validity against a locally regenerated temporary graph. The integration worker alone updates committed graph artifacts after merging parallel tracks.
- **Cleanup:** Remove all old flat files and package barrels.

### 5. Reshape product semantics

This package is serialized into three writer milestones because `operation.ts` and its tests currently intersect most capabilities.

#### 5A. Split characterization tests and pure contracts

Split oversized product tests by observable behavior without changing assertions or test counts. Move operation, interactive, execution, Thread, Turn, workflow, and resident contracts to final paths.

#### 5B. Extract context, execution ingest, usage, Thread, and workflow owners

Move existing standalone modules first, then split `execution-ingest.ts`, `usage-cost.ts`, query/tool services, and pure policies. Preserve serialized schemas while renaming process-local Context service identifiers and Effect trace names with all callers in the same commit. Preserve queue ordering, usage accounting, projection revision behavior, and repository transactions.

#### 5C. Decompose product operation composition

Turn `operation.ts` into named operation dispatch, interactive behavior, product projection/settlement lifecycle, transcript access, and Thread coordination modules. Product lifecycle files may consume only `ExecutionService` and product repositories: they reconcile projections, determine product quiescence, request stop, and settle abandoned product work. Durable Execution creation/recovery/follow/cancellation, Child Run trees, waits, joins, and replay remain exclusively in the `relay-*` modules of `@rika/relay-execution`. Keep one composition owner; do not replace the monolith with a generic state bag or controller.

- **Tests:** Product unit/contract tests, real repository adapter tests, specialty transcript tests, status parity, and in-process TUI acceptance.
- **Checks:** Product typecheck, `bun run check`, and `bun run test-tui`.
- **Stop conditions:** Relay is bypassed, SQL enters product, queue ownership changes, transcript repair changes, or a replacement god module appears.

### 6. Reshape adapter packages in parallel

#### 6A. Product store

Extract the 27 existing migrations unchanged plus the approved route-snapshot migration 028 into numbered files, retain one ordered registry and schema manifest, separate preflight/inspection/Layer construction, and split each repository into product-owned port plus memory/SQLite implementations and row codecs. Build every migration prefix in a real temporary SQLite database. For data-rewriting migrations, seed representative pre-migration rows and compare canonical post-migration rows, indexes, triggers, and constraints. Unknown, future, partial, and malformed databases must retain an unchanged file hash and no new side files after rejection.

#### 6B. Relay execution

Move the current CLI `model-provider-runtime.ts`, resident scripted-model behavior, registration, and Baton/provider adaptation into this package, then split agent definitions, delegation, prompt assets, model-provider registration, model behavior, Relay event/identifier mapping, execution methods, hosts, workflow compilation, inline blobs, and media analysis. Keep every Relay import and every Baton agent-loop, model, provider, compaction, and execution import in this package and use released exports only. `@rika/extensions` retains its existing narrow exception for released Baton extension contracts. The CLI passes Rika configuration/credential values into exported Layer factories without owning Baton model behavior.

- **Tests:** Every-prefix database schema tests, seeded data-rewrite migration tests, read-only rejection tests, repository memory/SQLite parity, Relay execution/recovery/workflow, subagent, and process suites.
- **Checks:** Adapter package checks, `bun run check`, relevant process tests, the fold/persistence benchmark after Product Store changes, and the diagnostics performance runner after Relay execution changes.
- **Stop conditions:** Migration ids/names/order/SQL change; transaction or Scope ownership changes; durable identifiers, cursors, cancellation, approvals, waits, joins, or recovery semantics change.

### 7. Reshape terminal state, presentation, and OpenTUI

Serialize three milestones:

1. split oversized tests and establish exact visual/interaction characterization;
2. split pure state, reducers, viewport, transcript, markdown, diff, theme, and tool presentation; and
3. split the OpenTUI Surface into domain collaborators without spreading mutable Surface ownership across arbitrary classes.

- **Tests:** Colocated reducers/presentation tests, OpenTUI integration tests, byte-stable visual fixtures, and `apps/rika/test/tui-app.ts` suites.
- **Checks:** Terminal typecheck, `bun run check`, `bun run test-tui`, and the diagnostics performance runner with its JSON compared to the Slice 0 measured metrics.
- **Stop conditions:** OpenTUI imports escape `src/opentui/**`, visual fixtures change without approved behavior, or cursor/focus/viewport/teardown behavior changes.

### 8. Reshape the CLI application and process transport

Serialize process-sensitive work:

1. split process tests and executable fixtures;
2. split resident protocol, client transport, host transport, reconnect, delivery, and lifecycle state machines;
3. split resident composition and provider/auth adapters;
4. split interactive controller/input/process behavior and command modules; and
5. reduce the four root `*-main.ts` files to process-boundary adapters while preserving packaged executable names.

- **Tests:** Colocated unit tests, integration tests, all TUI tests, source-graph/package tests, release-update tests, and explicit process characterization for frozen-v3/current authentication, launch-versus-reattach build selection, stale connection/feed rejection, replay and acknowledgement ordering, bounded-delivery overflow resync, reconnect replacement, command ordering, and finalizer order. Command-startup isolation proves SQL, Relay, model providers, extensions, and OpenTUI remain uninitialized until dispatch selects them.
- **Checks:** `bun run build`, `bun run check`, `bun run test-tui`, `bun run test-proc`, and the diagnostics performance runner. No measured metric may regress beyond its target/baseline tolerance, and the unsupported set may not grow.
- **Stop conditions:** Wire schemas, authentication, replay/acknowledgement, retry classification, launch isolation, lazy startup, process names, or finalizer order change; or any direct `@batonfx/*` or `@relayfx/*` import/dependency remains under production `apps/rika/src` or `@rika/cli`'s manifest. The allowed `@rika/cli → @rika/relay-execution` edge and imports of its Rika-facing Layer factories are required.

### 9. Reshape operational scripts and cross-workspace tests

- **Result:** Script paths communicate packaging, installation, release, benchmark, capture, and upstream ownership; corresponding narrow tests are colocated or grouped by real workflow.
- **Changes:** Apply the target `scripts/` and root `test/` tree. In the same commit, update every root script entrypoint: `bench` to `scripts/benchmark/benchmark-runner.ts`, `package` to `scripts/packaging/package-target.ts`, `npm-package` to `scripts/packaging/npm-package.ts`, `release-smoke` to `scripts/release/release-smoke.ts`, and install/uninstall commands to `scripts/installation/*`; preserve `bun run package -- --target <target>` argument forwarding. Update all three Vitest `setupFiles` entries to `test/support/relay-polling-setup.ts`, add `test/process/**/*.proc.test.ts` to the process project, remove stale `test/scripts` globs, and update package/release workflows and Turbo inputs without adding wrapper aliases.
- **Tests:** Package, archive, install, upgrade, local-install, release-workflow, benchmark, root command-entrypoint, and Vitest discovery tests.
- **Checks:** `bun run build`, focused script tests, `bun run package -- --target <current-target>`, and `bun run release-smoke`.

### 10. Delete migration support and enforce the final standard

- **Result:** The repository has one final architecture and mechanically rejects drift.
- **Changes:** Delete all temporary waivers, migration-mode policy, old paths, old package names, empty folders, barrels, `index.ts`, generic symbols, stale export entries, and Plan 026. Regenerate structural graphs. Ensure root and nested instructions point to exemplars rather than duplicating rules.
- **Tests:** Full deterministic, TUI, process, packaging, and release-smoke checks.
- **Checks:**
  - `bun run format`
  - `bun run check`
  - `bun run test`
  - `bun run test-tui`
  - `bun run test-proc`
  - `bun run build`
  - `bun run package -- --target <current-target>`
  - `bun run release-smoke`
  - `bun run bench`
  - source and packaged `rika diagnostics performance` runs with versioned JSON retained under ignored `artifacts/performance/`
  - manual Pilotty acceptance of launch, prompt submission, Child Run display, Thread switching, cancellation, queue controls, and clean exit
- **Completion gates:** Zero hand-authored `index.ts`; zero `export *`; zero old package specifiers in executable source, tests, scripts, manifests, generated graphs, and active instructions; zero unapproved generic basenames; zero files above 800; zero unwaived changed files above 500; zero functions above 150; zero files above eight exported declarations; zero files above 18 direct dependencies; zero directories above 30 source files; zero forbidden dependency edges; exact graph artifacts fresh; every replacement path deleted. Historical plans are excluded from old-specifier checks and remain historical evidence rather than active architecture.

### 11. Calibrate the hypotheses after the migration

Run a bounded agent-navigation study over representative Rika tasks. Record first relevant path, files opened, test discovery, graph queries, unnecessary reads, policy violations, tokens, duration, and final test result. Use the results to decide whether the 500-line warning, basename uniqueness, two-level depth, and export limits should change. Any lasting threshold change gets its own decision update and policy change rather than an exception list.

This slice measures the architecture; it does not add a semantic index or model-provider SDK to repository tooling.

## Delegation and merge plan

All implementation work after approval is delegated to GPT-5.6 Luna subagents. The parent session remains the orchestrator and does not edit source files.

Current `subagent models` reports every builtin inheriting `switchboard-openai/gpt-5.6-sol`. The independent read-only review fanout for this plan successfully validated the explicit per-run override `switchboard-openai/gpt-5.6-luna`. Every implementation, fix, review, validation, and integration launch must keep that explicit override; never inherit or silently fall back to Sol.

### Per-milestone loop

1. Parent verifies `git status --porcelain` is empty and records the exact base SHA before launch.
2. Define the milestone's exact changed-path allowlist, then launch one Luna `worker` as the only active writer. The worker must commit from the recorded base and stop before touching an unlisted path.
3. Require a handoff with resolved model ID (`switchboard-openai/gpt-5.6-luna`), base/result SHA, allowed paths, actual changed files, clean `git status --porcelain`, tests, command exit codes, graph/policy results, and residual risks. Parent verifies the model from the subagent run artifact rather than trusting prose.
4. Launch fresh-context Luna `reviewer` agents for distinct risks: behavior/authority, architecture/dependencies, tests/proof, and package-specific concerns. Reviewers are read-only: no edits, commits, plan updates, or conflict resolution.
5. Parent verifies and synthesizes findings without editing.
6. Launch one Luna fix `worker` from the reviewed commit SHA for accepted findings.
7. Re-run focused Luna review when the fix is substantial.
8. Launch one Luna integration worker to merge the accepted milestone and run its gate. Its write allowlist is the named shared surface for that milestone, drawn from root/package manifests, `bun.lock`, Turbo/TypeScript/Vitest/lint configs, `docs/generated/**`, active `AGENTS.md` files, and the architecture decision. Any source conflict or any other path is returned to the milestone writer rather than resolved by guesswork.
9. Parent verifies the integration branch is clean and at the expected resulting SHA before the next launch.

Parallel writers use isolated git worktrees and only after the shared public contracts are merged and the main worktree is clean.

### Parallel graph

```text
Slice 0 baseline
  → Slice 1 guardrails
    → Slice 2 package rename
      → Slice 3 contract inversion
        ├─→ 4A configuration ─┐
        ├─→ 4B coding tools ──┤
        ├─→ 4C extensions ────┼─→ foundation integration
        └─→ 4D transcript ────┘
                               ├─→ 5 product milestones ───────┐
                               ├─→ 6A product store ───────────┤
                               ├─→ 6B Relay execution ─────────┤
                               └─→ 7 terminal milestones ──────┤
                                                               ↓
                                                        8 CLI/process
                                                               ↓
                                                        9 scripts/tests
                                                               ↓
                                                       10 final enforcement
                                                               ↓
                                                       11 calibration
```

The Product, Product Store, Relay Execution, and Terminal tracks may run in isolated worktrees after the foundation export contracts are fixed. Milestones inside the same package remain serial. Root manifests, lockfile, Vitest config, Turbo config, generated graphs, and shared instructions are edited only by the integration worker to avoid merge-by-guessing. Package workers regenerate graphs to temporary output for validation; only the integration worker refreshes and commits `docs/generated/`.

## Proof

- Repository-policy tests and agent-navigation calibration prove paths and names retrieve the intended capability.
- Package-graph and forbidden-edge tests prove product no longer depends on adapters.
- Exact export maps and contract import tests prove package APIs are finite.
- Oxlint, ast-grep, and repository policy prove no barrel or deep-import path remains.
- Size, export, dependency, directory, and same-stem test checks prove semantic source/test units remain bounded.
- The 27 pre-existing migration identities remain unchanged; migration 028 has a focused route-snapshot rewrite oracle; every-prefix schemas, seeded row rewrites, unchanged-file rejection, and memory/SQLite parity prove persistence behavior.
- Resident composition/process tests prove one resident exclusively owns both product and Relay databases and clients remain lazy.
- Execution, Child Run, wait/join, cancellation, approval, workflow, and recovery tests prove Relay/Baton authority.
- Pure reducers, real OpenTUI integration, byte-stable visuals, in-process TUI acceptance, and Pilotty prove terminal behavior.
- Pre/post fold benchmarks and source/packaged diagnostics-performance JSON prove measured performance does not regress; unsupported GOAL metrics remain explicitly unsupported and never count as passing.
- Authenticated WebSocket, replay, reconnect, delivery, lifecycle, and packaged runtime tests prove process/transport behavior.
- Regenerate-and-diff plus graph-query tests prove structural graph freshness.
- Zero active old paths/specifiers, compatibility modules, empty folders, and Plan 026 prove old architecture is deleted.

## Rollout and recovery

There are no users and no compatibility window. Each merged milestone must still be buildable and testable. Structural moves use `git mv` where a file keeps its identity. Replaced files are deleted in the same milestone as caller migration.

The architecture adds only migration 028, which converts the persisted adapter-shaped route JSON into the product-owned route snapshot while preserving the opaque identity required to resume existing Relay Executions. Migrations 1–27, unrelated stored rows, serialized schema tags, wire schemas, durable identifiers, and package/runtime behavior stay unchanged unless a separate approved behavior change is required. Process-local Effect Context identifiers and trace names are renamed to the new package/symbol vocabulary in the same commit as every caller; they are not retained as legacy `@rika/app`, `@rika/runtime`, or other old strings. If a milestone fails its gate, revert that milestone commit rather than adding a forwarding path.

## Open blocker

Implementation is ready to start after explicit approval. The GPT-5.6 Luna override is validated; no source implementation has started.
