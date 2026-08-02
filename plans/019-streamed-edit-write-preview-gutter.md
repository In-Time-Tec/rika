# Plan 019: Give streamed edit/write previews an honest line-number gutter

> **Executor instructions**: Read this plan completely before editing. Run the drift
> check first, preserve the released-package boundary, and stop at every stated
> STOP condition rather than substituting a source-coordinate guess. Do not edit,
> build, format, or test `repos/*`. When complete, update this plan’s status.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Category**: user-visible bug
- **Depends on**: none
- **Planned at**: commit `e75d1c1`, 2026-07-23
- **Status**: TODO

## Goal

Keep a numbered gutter visible while canonical `edit` and `write` arguments stream.

Before a workspace mutation is resolved, the gutter must show clearly marked,
**relative preview line positions** (`~1`, `~2`, …), not invented source-file line
numbers. Once the final tool result supplies its valid unified diff, the same row
must replace those relative positions with the existing exact source line numbers.

For example, while the `edit` arguments stream:

```text
  ~1 - old value
  ~1 + new value
```

After the tool result resolves the edit at source line 224:

```text
  224 - old value
  224 + new value
```

The `~` is part of the visual contract: it prevents a relative input-preview
position from being mistaken for an authoritative workspace coordinate.

## Executor drift gate

This plan was investigated at commit `e75d1c1`. Before implementation, run:

```sh
git diff --stat e75d1c1..HEAD -- \
  packages/transcript/src/index.ts \
  packages/transcript/test/projection.test.ts \
  packages/tui/src/diff-renderer.ts \
  packages/tui/src/adapter.ts \
  packages/tui/test/{transcript-renderers.test.ts,adapter.test.ts,transcript-bounds.test.ts,visual.capture.ts,visual.test.ts} \
  packages/tui/test/fixtures/visual/edit-streaming.{frame.txt,styles.json,ppm} \
  apps/rika/test/{tui-app.ts,app.tui.test.ts} \
  docs/features/diffs-and-process-output.md
git status --short -- \
  packages/transcript packages/tui apps/rika/test docs/features/diffs-and-process-output.md
```

If the current branch already adds valid hunk coordinates to live previews, use
that path and revise this plan rather than adding relative gutters. If it changes
the ToolFile preview contract, diff renderer priority, visual-capture mechanism,
or real-app test harness, reconcile those changes before proceeding. Stop for
review if preserving the stated semantics requires a Relay, Baton, or transcript
persistence migration.

## Verified cause

The behavior has two deliberate rendering paths:

1. `model.toolcall.delta` carries incomplete `edit`/`write` arguments. The
   transcript reducer’s `inputFiles` in `packages/transcript/src/index.ts`
   synthesizes a preview from those values. An edit is `-old_str` plus
   `+new_str`; a write is `+content`. These previews do not contain a unified
   hunk header such as `@@ -224,1 +224,1 @@`.
2. `packages/tui/src/adapter.ts` tries `renderPierreDiff` first. That parser
   renders exact gutters only for valid unified patches. Coordinate-free previews
   then reach `renderPartialDiffStyled` in `packages/tui/src/diff-renderer.ts`,
   which intentionally renders only colored `+` and `-` content with no gutter.
3. After the tool completes, `packages/tools/src/tool-runtime.ts` has read and
   validated the target content. Its `unifiedDiff` result contains real hunk
   coordinates. `applyToolResult` replaces the preview with those final files,
   and Pierre renders the exact line numbers.

The visible frozen evidence is
`packages/tui/test/fixtures/visual/edit-streaming.frame.txt`, which currently
shows unnumbered `- old` / `+ new` rows. Final numbered gutter behavior is
covered by `packages/tui/test/pierre-diff.test.ts` and the `diff-highlighted`
visual fixture.

A TUI must not read the workspace to fill this gap. It would race the tool
runtime, would not replay deterministically, and would duplicate the tool’s
unique-match and `replace_all` rules.

## Design and invariants

### Preview states

| State                                        | Data source                                 | Gutter                            | Meaning                                                                                       |
| -------------------------------------------- | ------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| Argument preview                             | partial model tool-call input               | `~N` on each known input side     | relative position within the currently received old/new/content text; not a source coordinate |
| Final unified result                         | valid runtime `unifiedDiff` result          | existing numeric Pierre gutter    | actual line number from the workspace snapshot used by the completed mutation                 |
| Terminal result without a valid unified diff | failed/cancelled result or successful no-op | relative preview or no patch body | never claim a source coordinate the result did not supply                                     |

The argument preview remains the existing single stable ToolFile and continues to
update in place as deltas arrive. The tool row remains `running`; no new lifecycle
state, transport event, or delay is introduced. A valid final unified diff replaces
that preview on the same row.

### Required rules

- Number deletion and addition sides independently, starting at one. A replacement
  therefore displays `~1 -` then `~1 +`; two deleted lines display `~1 -`,
  `~2 -`; two added lines display `~1 +`, `~2 +`.
- The marker and its number use the same red/green semantic color as their change
  row. Keep current indentation, clipping, newlines, selection, grouping, and
  expansion behavior.
- A valid unified patch still takes the Pierre path, even if its ToolFile is
  marked `preview: true`. This plan must never turn known exact hunk coordinates
  into relative numbers.
- Do not emit source-looking numeric gutters without `~` for coordinate-free
  argument text. The preview has no reliable way to know whether `old_str` is
  unique, where it occurs, whether `replace_all` will apply, or whether `write`
  creates or overwrites a file.
- Do not fabricate an empty change for an argument field that has not streamed
  yet. `inputFiles` must distinguish an absent string field from a supplied
  empty string, so a path-only partial call renders its running header but no
  fake `~1 -` / `~1 +` body.
- A supplied empty string is a known zero-line value: it emits no blank preview
  row. This makes `new_str: ""` show only the deletion side, and `content: ""`
  show no body. Split known nonempty values on `\n` after removing one terminal
  empty element, matching `unifiedDiff`’s logical-line treatment: `"a\n"`
  renders one `a` row, not an additional blank row.
- Keep partial text escaping and multiline behavior intact. Newline-containing
  values grow the affected side’s relative sequence monotonically; no raw JSON
  or literal `\\n` reaches the transcript.
- Final diffs remain the sole source of actual source line numbers. On a failed,
  cancelled, or successful no-op result with no valid unified diff, retain a
  coordinate-free preview as `preview: true` while settling its file status; do
  not flip it to `preview: false` and fall through to `renderDiffStyled`’s
  unmarked counters. A terminal result with no preview lines renders only its
  header and terminal status.

### Exact source coordinates before completion are out of scope

Exact source positions cannot be derived from argument deltas. Oracle review
recommended a pre-commit, resolved unified-patch event for that stronger feature,
but the pinned released `@relayfx/sdk` 0.7.10 does not expose a handler-scoped
append API or durably forward Baton `ToolProgress`; its tool bridge persists only
the requested and final-result events. `@rika/tools` also cannot import Relay or
Baton.

Do not work around that boundary with a TUI filesystem read, an app-local event,
an internal Relay import, an unversioned side channel, or edits under `repos/*`.
A future exact-while-running feature requires a separately approved upstream
Relay capability with durable ordering and replay semantics. This plan fixes the
visible gutter now without misrepresenting source coordinates.

## Implementation slices

### 1. Lock preview semantics with failing reducer and renderer tests

In `packages/transcript/test/projection.test.ts`, add cases applying canonical
`model.toolcall.delta` events for `edit` and `write`:

- path-only partial input creates the stable file/header metadata but no synthetic
  changed rows;
- a streamed edit with known multiline `old_str` and partial `new_str` produces
  only the known old/new preview lines, in received order;
- streamed write content produces addition preview lines without changing the
  public tool name or tool schema;
- a supplied empty `new_str` is a zero-line replacement side, an empty write
  `content` has no preview rows, and absent fields remain distinguishable from
  those known-empty values;
- `"a\n"` produces one preview row rather than a second blank row, for old,
  new, and write content.

Assert ToolFile `preview: true`, `status: "running"`, path, kind, additions, and
the generated patch body. Do not assert source line numbers in the transcript;
relative-gutter presentation is TUI-owned.

In `packages/tui/test/transcript-renderers.test.ts`, directly test
`renderPartialDiffStyled` with a coordinate-free patch:

- multi-line edit output is `~1 -`, `~2 -`, `~1 +`, `~2 +`;
- create/write output is `~1 +`, `~2 +`;
- each deletion/addition gutter has the existing red/green foreground;
- an eleven-line side proves `~9` and `~10` share a padded aligned gutter,
  asserting the exact leading space before `~9` and no space within `~9` itself;
- indentation and clipping honor the supplied width;
- headers alone return no body rather than an `(empty diff)` fallback.

Keep `packages/tui/test/pierre-diff.test.ts` as the exact-coordinate contract.
Add an assertion there or in `adapter.test.ts` that a valid hunk remains numeric
and has no `~` marker.

### 2. Make transcript previews represent only received argument fields

Refine `inputFiles` in `packages/transcript/src/index.ts` without changing the
persisted `ToolFile` schema:

- use an optional-string helper that preserves the distinction between absent,
  non-string, and supplied string input;
- build edit preview rows for each side only after its corresponding field is
  present;
- build write preview rows only after `content` is present;
- leave the ToolFile path/kind available as soon as `path` streams, with an empty
  patch body until at least one changed row exists;
- preserve the existing `preview: true` and `running` values.

Also adjust `applyToolResult`: replace the preview only when `output.diff` is a
nonempty syntactically valid unified patch. Reuse or extract a pure validation
predicate shared with the Pierre-parse contract; do not treat `---`/`+++` headers
without a valid `@@` hunk as final. When the result has no valid diff **or a
nonempty malformed/header-only diff**, settle each existing preview file’s
`status` to `complete` or `failed` but retain `preview: true`; do not route
coordinate-free content through the final-diff renderer. This preserves truthful
relative gutters for failures, no-ops, and nonstandard integrations that return a
malformed diff.

Avoid importing `@rika/tools` into `@rika/transcript` merely to share
`unifiedDiff`; the reducer must stay deterministic over event data and must not
read the workspace. Keep this logic narrowly limited to argument presence and
preview text generation.

### 3. Render a relative gutter and suppress empty-preview fallback

Change `renderPartialDiffStyled` in `packages/tui/src/diff-renderer.ts`:

- derive separate old-side and new-side counters from its filtered `-` and `+`
  preview rows;
- calculate the digit width before rendering so `~9` and `~10` align without
  separating the `~` from its number: left-pad the complete label, for example
  `${indent}${`~${number}`.padStart(digitWidth + 1)} ${marker} `;
- emit that gutter before the clipped row content;
- preserve marker-specific colors and StyledText chunk boundaries;
- return `undefined` when there are no actual preview rows.

Then adjust both single-file and nested-file cascades in
`packages/tui/src/adapter.ts`: compute the selected renderer result before
appending the body separator. After Pierre declines a `preview: true` file, use
the partial renderer result directly and do **not** fall through to
`renderDiffStyled` when it is `undefined`; append neither the separating newline
nor a body in that case. That prevents a header-only preview from rendering
`(empty diff)` or leaving a blank body line. Non-preview and valid-unified patch
behavior must continue to use the existing Pierre-then-legacy fallback.

Do not change `renderDiffStyled`, `renderPierreDiff`, hunk parsing, syntax
highlighting, or generic Diff units.

### 4. Prove replacement and grouped-layout behavior

Extend `packages/tui/test/adapter.test.ts` using real transcript projection, not
only hand-written valid patches:

1. project `model.toolcall.delta` for an `edit` with a coordinate-free preview;
2. project the matching `tool.result.received` with a unified diff whose changed
   source line is deliberately not one (for example line 24);
3. assert the running, automatically expanded row renders `~1 -` / `~1 +`;
4. assert the settled same row renders `24 -` / `24 +` and no `~` gutter;
5. assert there is one tool row throughout, no raw input JSON, and the existing
   path/count/verb behavior remains intact.

Also project matching terminal results with no `output.diff`:

- a failed edit preserves its relative preview body and terminal styling, never
  an unmarked numeric gutter;
- a cancelled edit does the same when the protocol represents it as a cancelled
  result;
- a successful no-op write with empty content has no body and no `(empty diff)`
  text;
- a nonempty malformed/header-only `output.diff` leaves the existing relative
  preview in place, settles its status, and never exposes legacy unmarked
  counters.

Cover path-only/header-only previews in both the single-file and nested-file
branches, asserting neither `(empty diff)` nor a separator-only blank body line
appears below the header. Include a multi-file edit group or nested file row so the `indent: 4`
partial-renderer branch is exercised. Extend
`packages/tui/test/transcript-bounds.test.ts` with a coordinate-free preview
containing at least eleven lines at widths 60, 80, and 132; every physical line
must fit `transcriptWrapWidth`, including the aligned `~9` / `~10` gutter.

### 5. Prove the real interactive stack can show both states

This is user-visible interactive behavior, so add an in-process regression in
`apps/rika/test/app.tui.test.ts` using `apps/rika/test/tui-app.ts`.

Add a narrowly test-only result barrier to the harness if needed: it must hold a
completed `edit` Runtime result after `Runtime.run` returns but before Relay
receives it, then release deterministically through an Effect `Deferred`. It
must not change production runtime code, use wall-clock assertions, or introduce
provider/network access.

The test should:

- start with `src/example.ts` containing a prefix, `old`, and suffix so the final
  changed source line is two rather than one;
- issue a canonical `edit` tool call through the real scripted model;
- while the result barrier is held, wait on the live frame for `~1 - old` and
  `~1 + new`, and assert the row is still `Editing` with no raw JSON;
- release the barrier, wait for the real result/final answer, and assert the row
  now contains `2 - old` and `2 + new` with no `~1` preview gutter;
- confirm the workspace contains `new` and the transcript has one edit row.

If the existing TestModel/Relay stream does not expose a live argument preview
before the runtime result barrier, stop and report the missing test seam. Do not
replace this test with timing sleeps or a mocked TUI-only assertion.

### 6. Refresh focused visual and capability evidence

Keep the existing `edit-streaming` visual scenario in
`packages/tui/test/visual.capture.ts` coordinate-free. Update it only to expect
the new relative gutter. Regenerate its `.frame.txt`, `.styles.json`, and `.ppm`
through the existing visual capture flow; do not hand-edit the generated assets.

Review the fixture diff to ensure it changes only the streaming diff rows and
their width/style spans. The final `diff-highlighted` fixture remains the
reference for true source-number gutters and should not change unless unrelated
drift requires regeneration.

Update `docs/features/diffs-and-process-output.md` with one concise sentence:
argument previews use `~`-prefixed relative line positions until the final
unified diff replaces them with source line numbers. Keep the capability contract
short; do not add plan history or an evidence table.

## Verification

Run focused checks while implementing:

```sh
bun --bun vitest run --project unit \
  packages/transcript/test/projection.test.ts \
  packages/tui/test/transcript-renderers.test.ts \
  packages/tui/test/pierre-diff.test.ts \
  packages/tui/test/adapter.test.ts \
  packages/tui/test/transcript-bounds.test.ts \
  packages/tui/test/visual.test.ts
bun run test-tui
bun run typecheck
```

Then run the supported full gate:

```sh
bun run check
```

Manual acceptance through the repository’s pilotty or agent-tty workflow should
inspect one slowly streamed edit and one slowly streamed write. Confirm that the
running preview uses `~`-prefixed relative gutters, a final valid diff uses real
source numbers, and the final mutation still occupies the same transcript row.
Report any check or manual case not run.

## Done criteria

- A canonical streamed `edit` or `write` preview has a colored, aligned `~N`
  gutter for every currently known preview line.
- No preview row claims an unmarked source-file line number before a valid unified
  diff exists.
- Missing streamed fields do not render fake blank changes or fake line numbers;
  supplied empty strings and terminal newlines follow the explicit zero-line and
  logical-line rules above.
- Header-only previews render no diff body and never `(empty diff)`.
- Failed, cancelled, no-op, and malformed-diff results without a valid unified
  patch retain no unmarked numeric gutter.
- Valid unified previews and final results keep existing Pierre source gutters,
  syntax highlighting, indentation, grouping, and clipping.
- The same row transitions from relative preview gutter to exact final gutter;
  it is not duplicated, collapsed, or replaced by raw JSON.
- Focused transcript/TUI tests, the real app TUI test, visual regression test,
  `bun run typecheck`, and `bun run check` pass.
- No tool schema, runtime mutation semantics, Relay/Baton contract, transcript
  persistence schema, or `repos/*` source changes are introduced.

## STOP conditions

Stop and request review if:

- a valid source coordinate is demanded before a tool result but the only
  available data is an argument delta;
- implementation requires the TUI, transcript reducer, or app operation to read
  workspace files;
- an upstream Relay/Baton or deep-import change appears necessary for this
  relative-gutter scope;
- the partial renderer cannot distinguish absent input from known empty values
  without changing the persisted ToolFile schema;
- changing the preview body would alter canonical edit/write inputs, match
  validation, `replace_all`, file mutation ordering, or final unified diffs;
- the real app harness cannot observe the running preview without timing-based
  behavior or production-only test hooks;
- unrelated in-scope worktree changes cannot be preserved cleanly.

## Out of scope

- Exact source-file coordinates before mutation resolution.
- A new Relay event, Baton progress bridge, handler-scoped event append API, or
  any change to released Baton/Relay contracts.
- Workspace locking, optimistic concurrency, atomic file-replacement redesign,
  or changing edit/write retry semantics.
- Replacing Pierre or the final unified-diff renderer.
- New model-visible tools or reviving `apply_patch`.
- Changes to generic Diff units, line-click targets, selection behavior, or tool
  summary copy outside the streaming edit/write preview body.
