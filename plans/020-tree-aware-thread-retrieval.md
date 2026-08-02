# Plan 020: Tree-aware, context-efficient Thread retrieval

> **Executor instructions**: Implement this plan in order. Preserve the two existing
> internal tool names. Run the focused proof after every phase and stop at any listed
> STOP condition rather than adding a silent fallback. Do not touch `repos/*`.

## Status

- **Priority**: P1
- **Effort**: L (7–12 engineering days)
- **Risk**: MED-HIGH (model-facing contract plus additive SQLite migration)
- **Depends on**: plan 018, completed
- **Category**: retrieval correctness and agent reliability
- **Planned at**: commit `bc40af4`, 2026-07-23
- **Status**: TODO

## Outcome

ReadThread can find exact context anywhere in a local Thread, including persisted
child and grandchild agent answers, without loading a large flat transcript. It starts
with compact metadata or relevant evidence, expands one child subtree only when needed,
and always tells the model what was omitted and how to continue.

Success means all of the following are true:

1. A phrase found only in a user prompt, root assistant answer, or nested child answer
   can find the owning Thread even when it is older than the first 100 Threads.
2. A successful structured file edit can find the owning Thread by normalized file path
   without indexing diff bodies, failed attempts, or raw command output.
3. A decision question exposes the newest Turns first, so a later revision cannot be
   hidden by an oldest-first Turn limit.
4. Child-agent hierarchy remains visible through stable unit, execution, and parent
   identifiers. Compact reads include child final answers; raw child activity is loaded
   only through an explicit subtree read. The version-2 taxonomy distinguishes human and
   agent-authored prompts and reserves bounded related-Thread summaries for Plan 021
   without flattening another Thread into the current result.
5. Every bounded result remains schema-valid and reports exact omission reasons plus a
   cursor or subtree selector when more evidence is available.
6. Diagnostics can distinguish: delegation never started, ReadThread started but called
   no retrieval tool, search returned no matches, retrieval failed, and retrieval omitted
   evidence due to a budget.

## Current behavior and verified root causes

### The child data exists, but its retrieval shape hides it

Settle-time backfill recursively replays Relay descendants and persists their projections
under the root Turn. `Transcript.withNestedProjections` retains each nested unit's
`parentId`, `turnId`, key, order, revision, and execution outcome. The current
`read_thread_transcript` formatter iterates those units, so persisted child final answers
are technically present.

The formatter then discards the hierarchy and provenance. Child, grandchild, and root
messages become one flat text stream. It exposes no unit id, parent id, child execution
selector, depth, continuation cursor, or missing-child signal. This makes child context
present but difficult for the model to discover, verify, or expand.

Owners:

- `packages/transcript/src/schema.ts` owns the durable projection shape.
- `packages/transcript/src/index.ts` attaches nested projections.
- `packages/app/src/operation.ts` backfills and persists child projections.
- `packages/app/src/thread-query.ts` owns retrieval selection and presentation.

ReadThread must continue to read persisted Rika state. It must not query Relay directly or
create a second child-transcript authority.

### Search cannot search conversations

`ThreadQuery.find` asks `ThreadRepository.list` for at most 100 metadata-ordered Threads,
then searches only title, Workspace, and labels. It does not search Turn prompts,
assistant answers, child answers, or successfully touched file paths. Titles are short
generated summaries, so historical context that is absent from a title is unreachable
through the supported search tool.

`truncated: true` conflates four different conditions: requested result limit, the hidden
100-Thread source cap, Turn limit, and raw character slicing. Search has no cursor, match
reason, snippet, total/returned count, or source provenance.

### Reads put the least useful page first

`ThreadQuery.read` calls `TurnRepository.list`, selects `allTurns.slice(0, maxTurns)`, and
therefore returns the oldest Turns. The ReadThread prompt says to check later Turns for
revisions, but a long Thread can make those Turns unavailable. The repository already has
newest-page-first keyset pagination; the tool does not use it.

The result is bounded by `text.slice(0, maxChars)`. This can split a unit, line, Unicode
surrogate pair, or serialized structure and provides no continuation point.

### The model-facing contracts are opaque blobs

Both `search_threads` and `read_thread_transcript` return only:

```ts
{
  text: string
  truncated: boolean
}
```

The model must parse mixed JSON-lines or prose, infer what disappeared, and formulate a
second call without stable evidence identifiers. The public delegating `read_thread`
agent tool should continue to return the child execution result; this plan changes only
the two internal retrieval tools used by the ReadThread profile.

## Local evidence from actual Rika state

The supported diagnostic and Thread interfaces were inspected before lower-level storage.

- `rika diagnostics status` reported 696 JSONL files totaling 1,147,454,930 bytes.
- A recent resident log contained 406 `tool.started`/`tool.completed` records with tool,
  execution, and call identifiers, but no `search_threads`, `read_thread_transcript`, or
  delegating `read_thread` call. Generic lifecycle logs contain no retrieval counts,
  selector, returned size, truncation reason, or result status.
- A July 15 resident log contains six warnings for an old tool input schema digest
  mismatch naming `find_thread` and `read_thread`. This proves durable tool contracts have
  changed before; it does not prove a retrieval call succeeded or failed.
- Thread `5cee5cf7-fa85-4548-a595-ad7b88f8b989`, titled “Read some of our past threads,”
  exists with zero Turns. This shows that the attempted user workflow never became a
  durable Turn. It is not evidence that ReadThread itself failed, because no tool call was
  recorded. Current diagnostics cannot distinguish those states.
- `rika threads export --format json` returns `{ thread, turns }`, and Markdown returns
  only Thread metadata plus Turn prompts/statuses. Neither exports transcript projections
  or nested tool activity. This is an intentional export contract, but it means the
  supported local inspection path cannot reconstruct what a historical ReadThread agent
  saw or returned.
- Bun's installed SQLite successfully created and queried an FTS5 virtual table. Packaged
  target support still requires release-smoke proof; development-host support alone is
  insufficient.

Do not claim that local evidence proves a specific model retrieval mistake. It proves the
current interface cannot perform content search and the current telemetry cannot explain
the attempted workflow.

## Research basis

Primary sources accessed 2026-07-23:

1. Anthropic recommends the smallest high-signal context, token-efficient tools,
   just-in-time retrieval, and progressive disclosure. It describes subagents as context
   isolation: detailed search stays in the child and a concise result returns to the
   parent. It also recommends tuning compaction for recall before precision and removing
   old raw tool results when they no longer add value.
   <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
2. Anthropic's multi-agent production report recommends progressive query refinement,
   focused subagent handoffs, full tracing of search decisions, and evaluation of factual
   accuracy, completeness, source quality, citations, and tool efficiency.
   <https://www.anthropic.com/engineering/multi-agent-research-system>
3. Liu et al. found that long-context models often perform best when relevant evidence is
   at the beginning or end and significantly worse when it is in the middle. A 40,000
   character dump is therefore not equivalent to focused retrieval, even when the answer
   is technically included.
   <https://aclanthology.org/2024.tacl-1.9/>
4. MCP specifies opaque cursor pagination: servers choose page size, return `nextCursor`,
   clients must not interpret cursors, and invalid cursors fail explicitly. The same
   semantics fit these local model tools.
   <https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/pagination>
5. OpenAI's Agents SDK models an end-to-end workflow as a trace whose agent, generation,
   function, and handoff spans preserve `trace_id` and `parent_id`. Rika should likewise
   preserve parent-child provenance rather than flattening nested executions.
   <https://openai.github.io/openai-agents-js/guides/tracing/>
6. OpenAI recommends standardized, well-documented, tested tools with clear parameters,
   structured outputs when application code consumes model output, and baseline evals
   before cost/latency optimization.
   <https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/>
7. SQLite FTS5 provides lexical ranking, snippets, external-content indexes, rebuild, and
   integrity checks suitable for a local deterministic index.
   <https://www.sqlite.org/fts5.html>
8. Amp separates discovery from extraction: `find_thread` searches keywords and files;
   `read_thread` gives a specialist a Thread plus a question. Its long-Thread agent checks
   newer revisions, treats tool calls as attempts rather than outcomes, and uses
   compactions for orientation while consulting original messages for exact evidence.
   <https://ampcode.com/news/find-threads>
   <https://ampcode.com/news/read-bigger-threads>

These sources support progressive, structured lexical retrieval. They do not justify an
embedding store, generated long-term memory, or a separate semantic code index.

## Target design

```diagram
┌─────────────────────────────────────────────────────────────┐
│ Main agent: public find_thread → delegated read_thread       │
│ ReadThread: compact prompt + two internal retrieval tools    │
└──────────────┬───────────────────────────┬──────────────────┘
               │                           │
               ▼                           ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│ search_threads           │  │ read_thread_transcript       │
│ metadata + lexical hits  │  │ overview/recent/relevant/    │
│ snippets + cursor        │  │ subtree + cursor/omissions   │
└──────────────┬───────────┘  └──────────────┬───────────────┘
               │                             │
               └──────────────┬──────────────┘
                              ▼
                  ┌───────────────────────────┐
                  │ @rika/app ThreadQuery     │
                  │ selection + result budget│
                  └─────────────┬─────────────┘
                                ▼
       ┌─────────────────────────────────────────────────┐
       │ @rika/persistence                               │
       │ Thread/Turn/Transcript repositories + derived  │
       │ FTS5 Thread-search projection                   │
       └─────────────────────────────────────────────────┘
```

### Keep two internal tools and give each one job

- `search_threads`: find candidate Threads and compact evidence anchors across local
  metadata and persisted conversation content.
- `read_thread_transcript`: inspect one known Thread through an explicit selection mode.

Do not add separate list, summary, child, or pagination tools. Opaque cursors and subtree
selectors let these two tools support progressive disclosure without tool-choice overlap.

Expose one public `find_thread` tool to main and Task profiles. It calls the same
authorization-aware `ThreadQuery.find` path and returns compact version-2 matches; it does
not delegate to another model. The public workflow mirrors Amp's useful split:

1. `find_thread` discovers candidate ids from a query or file path.
2. `read_thread` delegates a question about one candidate, or searches internally when no
   id is known.

Do not expose internal `search_threads` or `read_thread_transcript` to general agents.
Keeping the lower search tool lets ReadThread refine queries without copying the public
agent's result into its isolated context.

### Search is a derived local lexical projection

Add a `ThreadSearchRepository` owned by `@rika/persistence`. It spans multiple existing
repositories, so it must not be hidden inside `TranscriptRepository` or implemented with
SQL in `@rika/app`.

Migration 17 adds:

- `rika_thread_search_documents`, the readable derived document source;
- an external-content `rika_thread_search_fts` FTS5 table;
- source and synchronization triggers;
- a migration backfill and FTS rebuild.

Index only supported product evidence. Existing Turns are classified as `human`; Plan 021
populates the already-defined `agent` source when durable Turn provenance is introduced:

| Source                         | Indexed text                            | Search source tag  |
| ------------------------------ | --------------------------------------- | ------------------ |
| Thread                         | title, Workspace, labels                | `metadata`         |
| Turn                           | authoritative `rika_turns.prompt`       | `human` or `agent` |
| root assistant Entry           | assistant text                          | `assistant`        |
| nested assistant Entry         | child/grandchild assistant text         | `child`            |
| successful structured mutation | normalized Workspace-relative file path | `file`             |

Do not index reasoning, generic tool input/output, diff bodies, notices, context usage, or
raw command output. File documents come only from terminal successful structured
edit/create/apply-patch activity and contain normalized paths, never file content. A shell
command that merely mentions a path is not evidence that the Thread changed it. User
Entries from transcript units duplicate the durable Turn prompt and must not create a
second indexed user document.

Each document records Thread id, optional root Turn id, optional unit id, source kind,
and text. The unit's `turnId` is execution provenance: when it differs from the root
storage Turn id, return it as `executionId`.

Text queries preserve the current simple query/filter DSL and add `file:<path>`, `label:`,
`archived:`, `after:`, and `before:` filters; they do not expose raw FTS syntax. Quoted
phrases remain phrases. Parse filters in `@rika/app`, normalize file paths against the
authoritative current Workspace, escape/quote free-text terms, and use AND semantics.
Rika has no cross-project or teammate search in this release, so it does not pretend to
support Amp's `project:`, `repo:`, `ref:`, or `author:` filters.
Rank text queries by FTS rank, then pinned descending, updated time descending, and Thread
id ascending. Filter-only queries retain the existing pinned/updated/id order.

Use triggers so rename, label changes, Turn edits, transcript replacement, and deletion
update the derived projection in the same transaction as their source write. The index is
rebuildable and never authoritative.

### Structured `search_threads` result

Keep `query`, `includeArchived`, and `limit`; add `cursor`. Change the result to:

```ts
interface SearchThreadsResult {
  readonly schemaVersion: 2
  readonly matches: ReadonlyArray<{
    readonly thread: ThreadMetadata
    readonly matchedBy: ReadonlyArray<"metadata" | "human" | "agent" | "assistant" | "child" | "file">
    readonly snippets: ReadonlyArray<{
      readonly source: "metadata" | "human" | "agent" | "assistant" | "child" | "file"
      readonly text: string
      readonly turnId?: string
      readonly unitId?: string
      readonly executionId?: string
      readonly parentId?: string
      readonly sourceThreadId?: string
    }>
  }>
  readonly omissions: ReadonlyArray<Omission>
  readonly nextCursor?: string
  readonly budget: OutputBudget
}
```

Default to 10 and cap at 50. Cursor payloads are base64url-encoded, schema-validated,
versioned selector plus last sort tuple. They are opaque but not secret. Return an
explicit invalid-cursor failure. Do not promise snapshot pagination while a Thread is
being updated.

### Structured `read_thread_transcript` selectors

Replace the optional-limit bag with one discriminated selector:

```ts
type ReadSelection =
  | { readonly mode: "overview" }
  | { readonly mode: "recent"; readonly cursor?: string }
  | { readonly mode: "relevant"; readonly query: string; readonly cursor?: string }
  | {
      readonly mode: "subtree"
      readonly rootTurnId: string
      readonly executionId: string
      readonly cursor?: string
    }
```

- `overview` returns Thread metadata, exact Turn/status counts, and a bounded
  `relatedThreads` page. Before Plan 021 the relation page is empty; after Agent provenance
  exists it contains compact `created`/`message`/`reply`/`fork` edges and continuation selectors,
  never another Thread's transcript text.
- `recent` uses `TurnRepository.page`, returns the newest page in chronological order,
  and puts the newest evidence at the end of the result.
- `relevant` performs Thread-scoped lexical retrieval and returns matching items plus a
  small amount of root-Turn sibling context.
- `subtree` returns one persisted root or child execution projection, preserving activity
  order while excluding reasoning and context-usage noise.

Defer arbitrary `range` reads. No observed first-release case needs a second cursor model.

The input also accepts a bounded budget:

```ts
interface ReadBudget {
  readonly maxTurns?: number
  readonly maxItems?: number
  readonly maxOutputChars?: number
}
```

Defaults: 8 Turns, 80 items, 16,000 encoded characters. Maximums: 50 Turns, 200 items,
36,000 encoded characters. The tool policy remains 40,000 characters, leaving envelope
headroom.

### Structured read items preserve the tree

The result includes schema version, mode, Thread metadata, selected root Turns, omissions,
budget use, and optional `nextCursor`. Every unit-derived item includes:

- stable `id` from `unit.key`;
- `rootTurnId` from storage;
- `executionId` from `unit.turnId`;
- persisted `parentId`;
- resolved `parentUnitId` when available;
- computed `depth`;
- unit order, revision, and execution outcome when present.

Every message also carries an explicit author: `human`, `agent`, `assistant`, or `notice`.
Agent-authored messages include their source Thread and source root Turn identifiers. Migration 17
classifies every pre-provenance Turn as human. Once migration 18 establishes authoritative
authorship, missing or malformed authorship is a projection/storage error and must never
silently decode as human.

Use four item families:

1. `Message`: human, agent, assistant, or notice text with author provenance.
2. `ChildSummary`: child name/status, stored summary, distinct last assistant text, and
   the exact selector for a `subtree` read.
3. `Activity`: supported tool, error, diff, permission, workflow, compaction, or
   notification detail.
4. `RelatedThread`: one compact incoming/outgoing `created`, `message`, `reply`, or `fork` edge with
   availability and the exact Thread id to read next. It never embeds related transcript
   content.

`recent` and `relevant` collapse raw child activity into `ChildSummary`; `subtree`
expands it. Summaries are computed deterministically from the existing `ChildAgent`
block and final nested assistant Entry. Do not call a model, persist generated summaries,
or introduce summary invalidation.

Compaction/checkpoint items may orient ReadThread to periods of a large Thread, but do not
count as exact evidence for wording, chronology, edits, commands, or verification. A tool
call records an attempt. Retrieval reports outcome only from its terminal result and the
authoritative persisted projection.

If a linked child has no usable persisted projection, return
`child_projection_unavailable`. The query path must not fetch Relay at read time.

### Bounding never slices a serialized result

Build items incrementally and measure the complete schema-encoded envelope. If a single
text field cannot fit, truncate that field at a valid Unicode boundary and put its item
id and text offset in the continuation cursor. Never `slice` encoded JSON or return a
schema-invalid success.

Use explicit omission reasons:

- `budget_exhausted`
- `older_results_available`
- `child_subtree_collapsed`
- `activity_collapsed`
- `projection_unavailable`
- `child_projection_unavailable`
- `item_text_truncated`

Every omission is resumable through `nextCursor` or a subtree selector, or explicitly
states why it is not resumable.

## Implementation sequence

### Phase 1 — Freeze the contract and failing corpus

**Files**

- `packages/tools/src/thread-tools.ts`
- `packages/tools/test/tool-contract.test.ts`
- `packages/app/test/thread-query.test.ts`
- `packages/runtime/test/standard-tool-transcripts.test.ts`

**Work**

1. Define `schemaVersion: 2`, typed matches, selectors, items, omissions, budget, cursor,
   and structured failures with Effect Schema. Keep tool names unchanged.
2. Add public `find_thread` over the same result contract, with a concise DSL description,
   while keeping both lower tools ReadThread-only.
3. Temporarily accept legacy read input `{ maxTurns, maxChars }`, translate it to
   `selection: { mode: "recent" }` plus the new budget, and stop advertising it in the
   tool description and prompt.
4. Add a compact synthetic fixture corpus based on local failure shapes:
   - content-only match beyond metadata position 100;
   - zero-Turn Thread;
   - Turn prompt with no transcript projection;
   - answer only in a late Turn;
   - newer Turn superseding an old decision;
   - long irrelevant middle;
   - child and grandchild final answers;
   - agent-authored prompt provenance and bounded create/reply related-Thread edges, using
     synthetic version-2 data until Plan 021 adds durable authors/receipts;
   - linked child with no projection;
   - generic command output containing the query, which must not match;
   - one successful structured edit path that matches `file:` and one failed/shell-only
     path mention that does not;
   - archived Thread.
5. Write failing contract and behavior tests before implementation. Include encoded-size,
   Unicode-boundary, invalid-cursor, deterministic-order, no-duplicate-page, and explicit
   omission assertions.

**Proof**

```sh
bun --bun vitest run packages/tools/test/tool-contract.test.ts packages/app/test/thread-query.test.ts packages/runtime/test/standard-tool-transcripts.test.ts
```

The new tests fail for retrieval behavior, not because schemas cannot encode/decode.

### Phase 2 — Add the rebuildable FTS5 projection

**Files**

- `packages/persistence/src/product-database.ts`
- new `packages/persistence/src/thread-search-repository.ts`
- `packages/persistence/src/index.ts`
- `packages/persistence/package.json`
- `packages/persistence/test/product-database.test.ts`
- new `packages/persistence/test/thread-search-repository.test.ts`
- packaged-target release smoke under `scripts/`

**Work**

1. Add migration 17 without changing existing migration ids or behavior.
2. Backfill metadata, human Turn prompts, eligible valid transcript-unit JSON, and
   normalized paths from terminal successful structured mutation units into the
   derived documents table; create/rebuild the external-content FTS table and triggers.
   The document schema accepts `agent` now so migration 18 can update classification
   without another model-facing result schema change.
   Plan 021 migration 18 must rebuild affected documents/triggers from authoritative Turn
   authorship in the same migration; an agent-authored prompt indexed as human after reopen is a STOP
   condition.
3. Extend strict schema inspection for the named documents table, virtual table,
   triggers, and FTS-owned shadow objects. Continue rejecting unknown unrelated objects.
4. Implement memory and SQLite repository layers with the same matching, ordering,
   snippets, filters, cursor validation, and archive behavior.
5. Test migration from a real schema-16 shape, malformed old unit JSON, updates,
   replacement, deletion, reopen, rebuild, and FTS integrity check.
6. Add packaged-target smoke that creates the migrated database and proves one metadata,
   one human prompt, one root-assistant, one nested-child, and one successful file-path
   search. Do not silently fall back to
   a full scan if a target lacks FTS5.

**Proof**

```sh
bun --bun vitest run packages/persistence/test/product-database.test.ts packages/persistence/test/thread-search-repository.test.ts
bun --cwd packages/persistence run typecheck
```

### Phase 3 — Replace flat query selection and rendering

**Files**

- `packages/app/src/thread-query.ts`
- new `packages/app/src/thread-query-cursor.ts` only if cursor code cannot remain a
  coherent private section of `thread-query.ts`
- new `packages/app/src/thread-read-projection.ts` only if tree projection cannot remain
  a coherent private section of `thread-query.ts`
- `packages/app/src/thread-tool-handlers.ts`
- `packages/app/test/thread-query.test.ts`
- `packages/persistence/src/turn-repository.ts`
- `apps/rika/src/main.ts`

**Work**

1. Inject `ThreadSearchRepository` through the app composition root.
2. Implement search directly over the new repository; remove the hidden first-100 source
   cap.
3. Add an exact Turn summary query only if `overview` cannot be implemented efficiently
   with an existing repository method. Preserve memory/SQLite parity.
4. Implement `overview`, `recent`, `relevant`, and `subtree` independently.
5. Resolve parent-unit links/depth from persisted units without changing their original
   `parentId`. Return unresolved provenance rather than inventing a parent.
6. Compute child summaries from persisted evidence and report unavailable projections.
7. Replace raw string slicing with schema-aware result budgeting and continuation.
8. Keep archive checks and reasoning omission. Map storage errors to typed failures with a
   concise recovery action.

**Proof**

```sh
bun --bun vitest run packages/app/test/thread-query.test.ts packages/persistence/test/thread-search-repository.test.ts
bun --cwd packages/app run typecheck
```

### Phase 4 — Teach and instrument the ReadThread agent

**Files**

- `packages/runtime/src/prompts/read-thread.prompt.txt`
- `packages/runtime/src/agent-profiles.ts`
- `packages/runtime/src/execution-backend.ts`
- `packages/runtime/test/agent-profiles.test.ts`
- `packages/runtime/test/subagent-spawn.test.ts`
- `packages/runtime/test/standard-tool-transcripts.test.ts`
- `packages/app/src/thread-query.ts`
- `docs/features/thread-retrieval-tools.md`

**Prompt behavior**

1. Search when no Thread id is supplied.
2. Prefer `relevant` for a named subject.
3. Always inspect `recent` before answering chronology, current-state, decision, or
   supersession questions.
4. Use `subtree` only when a compact child summary lacks evidence needed for the answer.
5. Follow `nextCursor` only when the omission could change the answer.
6. Cite every Thread id used and distinguish direct evidence from an unavailable
   projection.
7. When related-Thread provenance exists, follow only a relation that can change the
   answer. Never recursively load a relationship graph by default.
8. Do not stop at the first plausible hit. Check recent evidence for revisions,
   supersession, reverts, or contradictions.
9. Use compactions/checkpoints only for orientation and inspect original persisted items
   when exact requirements, wording, code, commands, chronology, edits, or verification
   matter.
10. Treat tool calls as attempted actions; cite a result only when a terminal outcome or
    later authoritative evidence proves it.

**Observability**

Emit content-free structured annotations at the owning layer:

- delegation start/completion/failure and terminal status;
- internal retrieval-call count;
- operation and read mode;
- cursor-used boolean;
- query term/filter counts;
- candidate/match/returned counts by metadata, human, agent, assistant, child, and file source;
- selected Turn/unit/child counts;
- requested and used budget;
- omission reason set and `hasMore`.

Do not log query text, cursor values, titles, Workspace paths, prompts, snippets, tool
input/output, or transcript content. Reuse existing execution/tool correlation annotations
rather than duplicating identifiers.

Add a runtime test proving that a nested Oracle can delegate ReadThread, whose ReadThread
child performs relevant/recent/subtree calls and returns the child final without receiving
general delegation tools.

**Proof**

```sh
bun --bun vitest run packages/runtime/test/agent-profiles.test.ts packages/runtime/test/subagent-spawn.test.ts packages/runtime/test/standard-tool-transcripts.test.ts
bun --cwd packages/runtime run typecheck
```

### Phase 5 — Rehearse durable compatibility and release behavior

The package graph ships together, but Relay stores execution snapshots and tool schema
digests. That durable boundary makes the result-schema change externally observable even
without separately deployed services.

1. Add a `*.proc.test.ts` fixture containing a pre-change nonterminal ReadThread
   execution/snapshot.
2. Resume it under the new runtime and verify legacy read inputs are translated and no
   fatal schema-digest mismatch occurs. It may complete or fail with an explicit “retry
   ReadThread” recovery, but it must not hang or poison resident recovery.
3. If Relay treats the changed success digest as fatal, stop. Introduce temporary
   versioned lower-level names only after proving they are necessary; do not ship four
   overlapping tools by default.
4. Keep compatibility input translation for one release. Measure old input use. Remove it
   after one release with no nonterminal old ReadThread executions and no observed legacy
   calls.
5. Do not change `rika threads export` in this release. Retrieval telemetry and the
   structured tool contract are the supported proof. Plan a separate export contract only
   if users still cannot diagnose failures.

**Final proof**

```sh
bun run test
bun run check
bun run package -- --target <local-target>
bun run release-smoke
```

Also run one real installed-build acceptance:

1. create a Thread with more than eight Turns and a decision revised in the final Turn;
2. create nested and grandchild subagents whose final answers contain unique phrases;
3. ask ReadThread for the current decision and each unique phrase without supplying a
   Thread id;
4. confirm it finds the Thread, checks recent context, expands only the needed subtree,
   identifies the Thread used, and diagnostics show the retrieval path without content.

## Rollout and recovery

This is one local executable and one local database, so no feature flag or dual-write path
is required. The safe sequence is:

1. package smoke proves FTS5 before installation;
2. database migration/backfill completes transactionally on first start;
3. runtime and the two version-2 schemas ship in the same build;
4. legacy read input translation protects old calls for one release;
5. index corruption is repaired by rebuilding the derived projection from authoritative
   Thread, Turn, and transcript-unit rows.

Rollback to a binary that understands only schema 16 is not supported after migration 17,
because database validation intentionally rejects future schemas. Recovery is forward:
fix or rebuild the derived search projection while preserving authoritative product data.
The migration must therefore finish before installation is called successful.

## STOP conditions

Stop and report instead of improvising if any condition occurs:

1. A schema-16 database cannot migrate, reopen, pass FTS integrity checking, and preserve
   every existing Thread, Turn, checkpoint, and transcript unit.
2. Any packaged target lacks FTS5. Do not replace it with the old first-100 scan.
3. Source triggers cannot keep the documents and FTS tables transactionally synchronized
   across transcript `replace`, incremental append, queued prompt edit, and Thread delete.
4. The fixture corpus cannot find content beyond position 100, return the newest revision
   on the first recent page, or retrieve a grandchild final through a subtree selector.
5. A successful tool result can exceed its policy limit, become schema-invalid, split
   Unicode incorrectly, duplicate/skip an unchanged result page, or report a resumable
   omission without a working continuation.
6. A persisted pre-change execution encounters a fatal schema digest mismatch. Prove the
   required temporary compatibility shape before adding more tools.
7. Diagnostics still cannot distinguish zero internal tool calls, zero matches, a tool
   failure, and a budget-limited result.

## Explicitly out of scope

- Embeddings, vector search, a semantic code index, or cross-project knowledge memory.
- Model-generated or separately persisted Thread/child summaries.
- Reading Relay execution storage directly from ThreadQuery.
- Persisting a second child-transcript tree.
- Exposing reasoning content.
- Arbitrary Turn/unit range selectors in the first release.
- TUI rendering changes.
- Changing JSON or Markdown Thread export.
- Creating, messaging, waiting on, or controlling independent agent-created Threads; Plan 021 owns
  that behavior and populates the relationship fields reserved here.
