# THE PLAN: Rika fixes, verified against the code

Every claim below was checked against the actual code at:
- Rika:  `.worktrees/rika-repl-kernel` @ b5d74ae4 (feat/typescript-cell-kernel)
- Baton: `.worktrees/baton-repl-kernel`

and against 5 real session transcripts (2 kernel-surface, 3 built-in-tool-surface).
Corrections to the earlier draft are marked **[CORRECTED]**.

Evidence files: /tmp/rika-plan-verify/{code-verification,papercuts-a,papercuts-b}.md
plus ISSUES.md in the Rika worktree.

---

## The one-sentence diagnosis

> Rika writes and ships every syllable of every event one at a time, seats only 4
> workers while a waiting parent camps in a chair, lies to models about child
> state, file contents, and truncation, and never told them the rules of the house.

```
                THE SYSTEM TODAY

 MODEL ──every token──> BATON ──every event──> SERVER ──every frame──> TUI
(fast)               (3 SQL stmts each)     (reserializes full      (resync = full
                                             checkpoint each)        thread reload)

                THE SYSTEM AFTER

 MODEL ──stream──> BATON ──25ms batches──> SERVER ──one patch──> TUI
                  (writes batches)        (serialize once)     (steady)
                          |
                          +── children: unlimited, honest states, push-notify
                          +── tools: never lie, errors name the real problem
```

---

# PART A — STOP THE SHOUTING (the CPU/memory fire)

### A1. Batch events into 25ms windows  — VERIFIED, unchanged

Every model fragment does the full trip. Confirmed in code, no time-coalescing
anywhere (only 256-event read pages and 32 send permits, which don't help writes):

```
per ModelPart:  3 SQL statements                (store-helpers.ts:239)
                -> full checkpoint reserialize  (baton-tree-projector.ts:620)
                -> SQL transaction per change   (root-turn-owner.ts:139)
                -> one socket frame per event   (server-host-feed.ts:137)

TODAY:  "Hel"→[full trip]  "lo"→[full trip]  "wor"→[full trip]   × thousands
AFTER:  "Hel"┐
        "lo" ├──[25ms window]──> ONE trip
        "wor"┘
```

Rule: important moments (cell done, failure, turn settled, approval needed)
skip the window and flush instantly.
Prototype already measured: 780 → 99 updates (−87%).
**Owner:** Baton event append path + Rika projector/watch stream.

### A2. Merge console output  — VERIFIED, unchanged

One `console.log` = one worker frame = one durable ToolProgress event
(bun-worker.ts:84, cell-tool.ts:72). A directory listing = 8,207 events.

```
TODAY:  log("a")→event  log("b")→event  ... ×8,207
AFTER:  adjacent same-channel chunks ──> one "output grew" event
```

**Owner:** Baton repl worker/cell-tool (adjacent stdout/stderr coalescing).

### A3. Bound the cell RESULT the model sees  — VERIFIED, unchanged

The result channel is explicitly exempt from metering (bun-runtime.ts:182:
`if (channel === "result") return { ..., truncated: false }`). stdout is capped
at 262,144; the result value is unbounded. A 1.4MB value went into model context
whole and triggered compaction. The 16,384 display cap is UI-only.

```
TODAY:  cell returns 1.4MB ──> ALL of it into model context ──> compaction fires
AFTER:  model sees first 16KB + "[truncated: 16,384 of 1,416,000 bytes.
        The full value is still in the kernel variable — slice it or artifacts.put it.]"
```

**Owner:** Baton cell-tool result path.

### A4. Render only own properties in results  ★new from transcripts

`Bun.inspect` on mapped objects dumped `toString: [Function]`, `valueOf: …`,
`__defineGetter__: …` — ~10 junk entries per object, × 6 children × 10 poll
cells of pure noise entering context.

**Owner:** Baton bun-worker `format()`.

### A5. Honest truncation everywhere  ★new from transcripts

Two lies today:
- Kernel stdout capped at exactly 16,384 with only a leading `…` — head dropped
  silently (22 occurrences in two sessions).
- Built-in bash/grep output capped at 16,384 reports `"truncated": false`
  (27 occurrences). A child cat-ing five docs lost entire files without knowing.

```
AFTER:  every capped output says
        [truncated: kept last 16,384 of N bytes — page or narrow the command]
        and the truncated flag is TRUE.
```

**Owner:** Baton channel metering + Rika built-in tool result shaping.

---

# PART B — SEAT EVERYONE (unlimited subagents)

### B1. Remove the max-4 caps  — VERIFIED, both constants found

```
Baton:  local-scheduler.ts:31      concurrency ?? 4
Rika:   kernel-composition.ts:105  maxConcurrentBoots ?? 4

TODAY:  spawn 20 ──> [1][2][3][4] run, 16 starve (parent eats a seat too)
AFTER:  spawn 20 ──> all 20 run
```

What still limits you (real, not chosen): provider 429s (surface + retry),
measured memory pressure (typed refusal only with live evidence), SQLite
contention (already ~10× reduced by Part A — which is why A lands first).

### B2. Waiting parents cost nothing  — VERIFIED

A parent waiting in `agents.inspectAll` is still an executing tool call: its run
stays `running`, its fiber stays in the scheduler FiberMap, and seats are
computed as `concurrency - admitted.size` over that map (local-scheduler.ts:134).
The harness even documents it: "A waiting parent holds its scheduler slot for
the length of the wait."

```
TODAY:  [PARENT: waiting, burning a seat] [child][child][child]
AFTER:  parent waits ──> holds nothing ──> wakes on notification
```

### B3. Honest child states: queued vs running  — VERIFIED, root cause found

`admitChild` inserts the child as `queued` then IMMEDIATELY flips it to
`running` before any seat exists (store-admit.ts:290-329). The scheduler then
picks among already-`running` runs, so the DB cannot distinguish "waiting for
a seat" from "executing". Rika's `queued -> pending` mapping is dead code
because Baton never says queued.

```
FIX:  child stays `queued` until the scheduler actually starts it.
      inspect reports the truth. (Rika mapping already exists and starts working.)
```

### B4. Push, don't poll — deliver ChildSettled to the parent  — VERIFIED

`ChildSettled` is appended to the parent's durable event log
(store-helpers.ts:412) but NO mailbox message is created, and the scheduler's
resume path only applies to Baton-native `run_child` ToolWaits — Rika spawns
are admission-only, so a Rika parent can only poll. Measured cost: 31 poll
cells / ~35 min in one session; 14 identical inspectAll model calls in another.

```
TODAY (pull):                       AFTER (push):
  spawn A,B,C                         spawn A,B,C ──> end turn / keep working
  poll... poll... ×31                    |
  learn nothing each time            [B failed!] ──> parent notified NOW
                                     [A done][C done] ──> coalesced wake
```

Rules: failure notifies immediately; successes may coalesce. The settlement
message CARRIES the child's result so no follow-up call is needed.
**Owner:** Baton (wire ChildSettled -> baton_messages) + Rika inbox + prompt
line: "after spawning, end your turn; you will be notified."

### B5. A durable wait that spans cells  ★new from transcripts

`maxWaitMillis = 30_000` (agents-binding.ts:26) meets the 120s cell deadline:
a parent literally cannot wait for a child that takes minutes. Models hand-rolled
`setTimeout(120000)` sleeps that the host then killed — and in one session the
abort LEAKED: subsequent cells (`1 + 1`) insta-failed and the kernel wedged.

```
FIX 1:  agents.wait that parks durably ACROSS cells (or rely fully on B4)
FIX 2:  the async-overrun kill must say "cell exceeded the 120s deadline"
        (today: "the kernel process exited while the cell was running")
FIX 3:  an aborted cell must never poison the next one   <- real defect
```

### B6. Fix the parallel-fanout replay defect  ★new from transcripts — REAL BUG

Two sessions lost half their children to:
`Pending operation …:tool:4:0:…:read does not match requested operation
…:tool:4:1:…:read` — a durable-replay identity mismatch when parallel tool
calls replay in a different order. Six more surfaced as `Execution failed`
with an EMPTY detail. Children died; parents redid all the work inline.

```
FIX:  make replay matching order-independent for parallel fanout,
      and never surface an error with empty detail.
```

### B7. Child results are handed over, not hunted  ★new from transcripts

A 345KB child outcome arrived as one inline JSON blob; models stashed it in
`globalThis` (69 cells across two sessions) or artifacts. `threads.read`
subtree mode returned `items: []` for live children plus a ~1KB hex cursor.

```
AFTER:  settlement notification carries result text (bounded, A3 rules)
        large outcomes come as an artifact handle + documented paged read
        inspect on a RUNNING child shows lastActivityAt + latest-step preview
```

### B8. Deeper delegation  — [CORRECTED]

The old claim "subagents can't spawn subagents" was imprecise. Truth: leaf
profiles have `children: []`; Task can spawn all five leaves but not another
Task (baton-route.ts:314,507); depth budget 8 exists as a backstop.

```
TODAY:  Root ── Task ── leaf   (Task-in-Task refused)
AFTER:  Root ── Task ── Task ── ...   (budget-guarded, not topology-capped)
```

### B9. Parent resume instead of restart  — unchanged, lands last

All children succeed, the parent's model stream dies, everything is discarded.
Baton's journal already holds everything needed to seed a new parent attempt.

```
TODAY:  A✓ B✓ C✓ D✓ ──> parent stream dies ──> all discarded, full re-run
AFTER:  A✓ B✓ C✓ D✓ ──> new attempt seeded with transcript ──> nothing re-runs
```

---

# PART C — KEEP THE SCREEN ALIVE  — [CORRECTED]

The old draft said "the client acks on receipt and there is no backpressure."
**That is wrong.** Verified: the client acks AFTER applying each batch
(server-client-session.ts:34-66) and the server holds 32 in-flight send permits
released by acks (server-host-feed.ts:12,101). The real problems are:

### C1. Overflow degrades to a full thread reload

When the outbound window overflows, `ThreadViewPatch` is remembered as
`ResyncRequired`, and the client answers with `selectThread` — a FULL thread
view reload, which under sustained load re-triggers overflow.

```
TODAY:  overflow ──> ResyncRequired ──> full reload ──> more load ──> overflow…
AFTER:  overflow ──> coalesce to LATEST state, once ──> resume incremental
```

### C2. The critical buffer kills the session

Critical-frame buffer capacity is 64; overflow errors out the entire session
(server-host-feed.ts:156-165). With A-batching this should be unreachable —
prove it, and make the failure a resync rather than a death if it ever fires.

### C3. Cancel rides an express lane

Escape was accepted under load and the work kept going; the process had to be
killed. Control frames (cancel/approve) must never queue behind stream events.

```
  stream events:  =========congested=========>
  cancel/approve: ---- express lane, never queued ---->
```

Also: a user-initiated cancel currently reports "Cancelled by Rika" — name the
actual initiator ("Cancelled by user" / "Cancelled: deadline").

---

# PART D — FIX THE KERNEL TOOL SURFACE  (from transcript mining, verified)

The chain that armed the 8,207-event bomb, observed step by step in a real
session:

```
model wants a file listing
  └─> workspace.search "apps/rika"        (it's a content grep — nothing says so)
        └─> "grep timed out after 10000ms"  (×8 across sessions)
              └─> "There's no list-dir API"  └─> retreats to node:fs FOREVER
                    └─> hand-rolls recursive tree printing
                          └─> 8,207 durable events
```

### D1. Give the workspace a listing and honest search errors

- Add `workspace.list` (structured tree, bounded depth) — glob machinery already
  exists internally (workspace-file-search.ts:231) but is NOT bound to cells.
- Invalid regex error currently discards both the pattern and rg's diagnostic
  (coding-tool-runtime-layer.ts:159): say
  `pattern 'src/**(' is not valid regex: unmatched (`.
- Search timeout must say: "search greps file CONTENTS repo-wide; scope with a
  path or use workspace.list."
- Ship ripgrep with the product or fall back to an owned search (ISSUES.md:
  today a bare PATH makes search fail with a raw grep error).

### D2. Document result shapes where models trip

`workspace.read` returns `{text}` — models called `JSON.parse(result)` and
`.slice()` on it (6 failed cells). Fix the docs AND the error: "did you mean
`.text`?". Search should return structured `{path,line,text}[]`.

### D3. Schema failures name the field

`HostBindingSchemaFailure: threads.search` says nothing else (8 occurrences).
The validator knows the path — include `Missing key at ["threadId"], expected
string` in every failure.

### D4. The kernel must not gaslight the model  ★real defects

- Snapshot restore let a stale user variable SHADOW the `rika` global (`rika`
  evaluated to a string path). Reserve all mounted binding names in
  capture/restore, and re-mount after restore.
- Prompt advertises `rika.context.*` / `rika.goal.*` that the installed kernel
  doesn't mount — generate the binding list from the actually-mounted surface.
- `Pending operation … does not match` internal errors reach the transcript
  raw (6 blocks) — translate or suppress (see B6).

### D5. One-sentence house rules in the prompt

Each of these was learned by accident, at cost, in a real session:

- "`rika` and its modules are pre-mounted globals — never import them."
- "Variables persist across all your cells — accumulate, don't re-fetch."
- "Your workspace is X and it is empty / not empty."
- "Cell output is capped at 16KB per channel — page big output in code."
- "Run shell commands via processes.start; that is the blessed path."
  (10 execSync git cells in one session)
- "After spawning children, end your turn; you'll be notified." (kills polling)

Per your standing rule: NO exploration budgets, NO stopping rules, NO subagent
count limits — agents explore freely; the system makes it cheap.

---

# PART E — FIX THE BUILT-IN TOOLS  (non-kernel surface: bash/read/grep/edit)

Three sessions ran on the classic tool surface and hit a different, equally
real set of defects.

### E1. `read` returns the WRONG FILE for a missing path  — CRITICAL

`read packages/runtime/package.json` (which didn't exist) returned the
package.json of `ast-grep-outline` — a DIFFERENT PROJECT. ~30 occurrences.
One subagent shipped a report where 7 of 16 packages were described by
inference because it stopped trusting the tool; another invented an
"orphaned package" theory from contaminated reads.

```
TODAY:  read(missing path) ──> fuzzy-resolves to SOME OTHER FILE, silently
AFTER:  read(missing path) ──> "file not found: <path>"  (never another file)
```

### E2. `read` on a directory says nothing useful

`"The operation failed before producing a usable result… Review the input"`
— the real cause is EISDIR. Say "path is a directory; use ls or glob."

### E3. grep: partial results, path filters, honest budget

10s all-or-nothing timeout on big repos (×4). Models then guessed a
Sourcegraph-style `file:` filter that silently matched nothing (×6), feeding
false conclusions. Return partial matches found before the deadline, add a
documented path/glob filter, and confirm ignore rules actually skip
node_modules/worktrees.

### E4. Validate a child's tools against its task at spawn

A Librarian asked to read a LOCAL file had only web tools; it tried
`file://` URLs, then web-searched a private repo, then gave up. Warn the
parent at spawn when a child's prompt references local paths it cannot reach,
and make `read_web_page` say "file:// is unsupported."

### E5. start_child_group: flat schema, named-field errors

A double-nested stringified members guess killed an entire turn (stream
decode error + tool-name union diff spanning every tool). Flatten and
document the schema; on failure name the offending field.

### E6. Background shell contract

- `shell-process-registry.ts:179` reaps a process the moment a poll sees exit:
  a fast command's id is spent before it can be used. Keep the id nameable
  until read once, or say "already finished, output was: …" (ISSUES.md).
- `running` results carry no elapsed time or partial output; models guessed
  240s/300s waits blind. Include both.

### E7. Turn resilience

Provider 5xx/429 killed turns whose entire user content was "Keep going" —
the user was the retry loop. Auto-retry transient provider errors with
backoff inside the turn.

### E8. Smaller sharp edges (each one line)

- `edit` non-unique old_str: add match count + line numbers (recovery in one shot).
- mcp tool-name cache: a tool a server gains mid-cell is refused until the next
  cell — note it in the refusal.
- Harness rollback: only the newest refinement can roll back, and the error
  says "entry already exists" instead of the truth — fix the message, then the
  baseline derivation.
- `--stream-json` never carries the system prompt — say so in its docs; tests
  that count prompt markers in the stream are vacuous.

---

# PART F — THE MEMORY LEAKS  (from ISSUES.md, measured)

```
Server RSS, one interactive session, 12 turns:
305 ──> 547 ──> 572 ──> 597 ──> 628 ──> 653 ──> 677 ──> 713 ──> 747 ──> 762 ──> 774 ──> 790 MiB
        └── steady +25 MiB per turn, not flattening. Native, not JS heap
            (heap shrank 27MB while RSS grew 300MB in the TUI-suite probe).
```

- F1. Find the native retention (SQLite pages / terminal buffers / allocator).
  The TUI test worker dies at ~55MB residue per subagent lane — same class.
- F2. The silent test-worker death: default reporter prints NO summary when the
  worker dies; runs read as passes. Gate on exit code + JSON reporter counts.

---

# ORDER OF WORK, AND WHY

```
 1. A1+A2+A3+A4+A5   the fire: −87% measured; makes everything after safe
        |
 2. E1+B6            the two data-integrity bugs: wrong-file read,
        |            fanout replay killing children  (small, critical, independent)
        |
 3. B1+B2+B3         uncap seats, free waiting parents, honest queued/running
        |
 4. B4+B5+B7         push-notify + durable wait + result handover (one feature)
        |
 5. C1+C2+C3         overflow coalescing + cancel express lane
        |
 6. D1..D5, E2..E8   tool-surface fixes and prompt lines (many small, high leverage)
        |
 7. F1+F2            native leak hunt (parallel-friendly, evidence-driven)
        |
 8. B8               Task-in-Task (manifest design)
        |
 9. B9               parent resume (biggest Baton change, lands last)
```

Batching MUST precede uncapping: 20 children through today's per-token pipeline
would wedge the machine five times faster.

# VERIFICATION — same bar for every step

```
change ──> unit + mutation tests ──> serial local gates
      ──> live "Explore this project with subagents" on the local build
      ──> compare against recorded baselines:
            46,924 feed msgs | 100-206% CPU | 3.7GB RSS | 790MiB@12turns
            31 poll cells | 8,207 stdout events | 1.4MB context bomb
            ~30 wrong-file reads | 27 lying truncations | 4 dead children
      ──> keep only measured wins; revert everything else; log all of it
```

All work in the same worktrees:
- Rika:  `.worktrees/rika-repl-kernel`  (feat/typescript-cell-kernel)
- Baton: `.worktrees/baton-repl-kernel` (feat/repl-kernel)
