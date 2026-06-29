# Rule: Evidence-Gated Checkoffs

Restart progress from the first unchecked or not-yet-reviewed parity row. Do
not mark a row, plan item, or inventory claim complete before its evidence gate
has passed.

A parity row may be checked off only after all of this exists for that row:

1. Amp evidence.
2. Rika evidence.
3. Automated diff or explicit manual audit.
4. Updated parity docs.
5. Focused verification.
6. Leak scan for leftover parity processes/windows.
7. Independent subagent review with a `PASS` verdict.

If anything was marked complete before that gate, revert it to the last honest
state, keep the artifacts, and rerun the gate. Check off each gate item only
after the evidence exists; never pre-check future work.

# Rule: Amp Code Subagent Parity

Rika's subagent implementation must match Amp Code's observable functionality
one to one. Rika's tech stack and technology decisions may differ internally,
but those differences must not change Amp Code parity in behavior, wording,
control flow, or pixels.

# Goal: Amp-Compatible Default Mode

Rika's default CLI must be an Amp-compatible mode with golden-master parity.
Rika may use Effect, OpenTUI, Rivet, semantic search, ast-grep outline, and fff
internally, but the default interactive surface must match Amp's observable
behavior and pixels under a fixed test environment. Rika-only features must
either render through existing Amp-style surfaces or be hidden behind explicit
Rika extension paths.

## Fixed Parity Lab

- Terminal: Ghostty, pinned version/config/theme/font/font size/window size.
- Amp: pinned CLI version.
- Rika: workspace source build, not an installed stale binary.
- Workspace: fixed repo path, git branch, clean fixture data, seeded time/cost/thread IDs where possible.
- Capture: scripted launch, screenshot, recording, and pixel diff for each flow.

## Product Rule

The default `rika` interactive CLI is Amp-compatible. No visible Rika branding,
wording, layout, color, keybinding, animation, or behavior may differ unless
listed as an explicit allowed difference.

## Allowed Differences

Only engine-level differences are allowed:

1. Semantic search backend.
2. AST-grep outline backend.
3. fff-backed search.
4. Rika subagent implementation.

These must not change transcript chrome, card rendering, command wording,
keybindings, or visual output.

## Required Method

For every Amp surface:

1. Script the exact Amp flow.
2. Capture screenshot/recording as a golden master.
3. Script the same Rika flow.
4. Pixel-diff and behavior-diff the result.
5. Log every delta.
6. Fix one delta at a time.
7. Re-capture fresh evidence.
8. Mark match only when diff is zero or explicitly explained by a documented allowed dynamic field.

## Done

Done means every feature inventory row has:

- Amp evidence.
- Rika evidence.
- Automated or manually audited diff.
- Verdict `match`.
- No unreviewed visual/behavior delta.

Treat Amp as the golden master, not inspiration. The work is driven by a harness
and an evidence ledger, not by eyeballing implementation.

For true pixel parity, the lab must pin Ghostty config, window size, font,
terminal dimensions, Amp version, Rika invocation, repo path, git branch, time,
cost, thread IDs, and model labels. If a value cannot be stable, seed it where
possible or mark that exact region as a documented dynamic field. Without that
lab, "pixel perfect" is not a meaningful claim.

---

# goal.md — Rika must be indistinguishable from Amp

> This file is the single source of truth for the Rika ⇄ Amp parity effort. It is
> intentionally nitpicky and intentionally demanding. If a behavior is not in
> this file, it is not "done" — add it, capture evidence, then close it.

## 0. North star

**A user dropped into Rika must not be able to tell it apart from Amp.** Same
startup screen, same chrome, same colors, same spacing, same keybindings, same
tool-call rendering, same expand/collapse behavior, same thread switching, same
streaming feel, same error surfaces, same copy/wording — pixel-for-pixel and
keystroke-for-keystroke. The only acceptable visible differences are the four
deliberate upgrades in §3.

"Looks basically like Amp" is a **failure**. The bar is: screenshot Rika,
screenshot Amp, diff them, and a stranger cannot say which is which.

Think of Rika as **Amp 3.0**: identical product surface, rebuilt on Effect +
OpenTUI + Rivet first principles so we can go further later.

## 1. Hard rules (non-negotiable)

1. **Library-first, always.** Before writing _any_ custom code, you MUST check,
   in order:
   - **Effect** (`effect`, `@effect/*`) — streams, fibers, schedules, queues,
     refs, layers, schema, platform. Almost all concurrency/state/IO primitives
     already exist here.
   - **OpenTUI** (`@opentui/core`) — rendering, layout, input, buffers,
     scrollback, styling, surfaces. Do not hand-roll a renderer, a layout
     engine, an input parser, or an ANSI writer if OpenTUI has it.
   - **Rivet** (`rivetkit`, `@rivetkit/effect`) — actor lifecycle, durability,
     remote transport, multi-client fan-out.
   - **Drizzle** (persistence package only) — storage/migrations.

   Only if the capability genuinely does not exist in those libraries may you
   write it yourself — and then you write a one-line note in the relevant
   `AGENTS.md`/`CONTEXT.md` explaining why it had to be custom.

2. **No code comments.** Rationale goes in `AGENTS.md`, `CONTEXT.md`, or
   `.agents/skills/`. (See repo memory: keep code comment-free.)

3. **Effect-native only.** Services, layers, typed errors (`Schema.TaggedError`),
   scopes, streams, fibers. No ad-hoc promises, no module-level singletons, no
   `setTimeout` soup. Follow the OpenCode-style module shape already used in the
   repo (`export * as Module`, `Interface`, `Context.Service`, explicit `Layer`).

4. **Parity is verified, never assumed.** Every parity claim in this file and in
   `docs/parity/AMP_FEATURE_INVENTORY.md` must point at evidence: a side-by-side
   screenshot pair or a recording in `docs/parity/`. No evidence ⇒ status is
   `unverified`, not `done`.

5. **Never break existing behavior.** This is a port, not a rewrite of product
   decisions. If you would change what the user sees or how a command behaves,
   stop — unless it is one of the §3 upgrades.

## 2. Non-functional requirements (these are requirements, not aspirations)

| Property               | Requirement                                                                                                                                                                                                      | How to check                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Scroll-while-streaming | The user can scroll up/down through transcript **while tokens are still streaming**, and the viewport does NOT get yanked back to the bottom. Auto-follow resumes only when the user scrolls back to the bottom. | Start a long streaming turn, scroll up mid-stream, confirm position holds; record it. |
| Streaming smoothness   | No visible flicker, no full-screen repaint per token, no tearing. Render deltas, not whole frames. Prefer OpenTUI's diffing/buffer APIs over reprinting.                                                         | Screen-record a fast stream in Rika and Amp; compare frame stability.                 |
| Memory footprint       | Stays low and flat over a long thread. No unbounded transcript array growth that re-renders in full. Transcript/scrollback must be bounded or virtualized.                                                       | Run a long session; watch RSS. It must not grow without bound.                        |
| Input latency          | Keystroke-to-echo and scroll responsiveness indistinguishable from Amp. No input lag during streaming.                                                                                                           | Type/scroll during a heavy stream; compare feel.                                      |
| Startup time           | Cold start to interactive prompt comparable to Amp.                                                                                                                                                              | Time `rika` vs `amp` to first prompt.                                                 |
| Subagents              | Subagents are set up the way Amp does them (see §4) — not the current bounded read-only stub.                                                                                                                    | Trigger a subagent task in both; compare behavior and rendering.                      |

## 3. The ONLY deliberate differences from Amp

Everything else is a 1:1 port. These four are intentional upgrades and must
still feel native (same UI affordances, same result rendering as the Amp tool
they replace):

1. **Semantic search** as a built-in retrieval tool.
2. **AST-grep outline** as a built-in code-structure tool.
3. **fff** instead of ripgrep for fast file/content find.
4. **Subagents done correctly** — proper Amp-style subagent orchestration
   (independent context windows, parallel fan-out, final-summary return), not a
   degraded stub.

If any of these changes _how a result looks_ in the transcript versus Amp's
equivalent, that is a parity bug — the upgrade is in the engine, not the chrome.

## 4. Subagent parity spec (current gap)

Amp's model (from the owner's manual):

- Subagents have their **own context window** and their own tools (file edit,
  terminal, etc.).
- Used for multi-step tasks that split into independent parts, large-output
  operations, and parallel work across code areas.
- They run in **isolation**: cannot talk to each other, cannot be steered
  mid-task, start fresh without the parent's accumulated context, and the main
  agent receives only their **final summary**.
- Spawned automatically for suitable tasks (mostly `smart` mode) and can be
  encouraged by the user mentioning subagents / parallel work.

Rika today (`packages/agent/src/subagent-runtime.ts`) is a "read-only bounded"
runtime. Parity work: bring it to the Amp model above (own context, own tools,
parallel fan-out, final-summary return, auto-spawn heuristics), and render
subagent activity in the transcript the way Amp does (the `subagent` card kind
already exists in `packages/tui/src/view-state.ts`).

## 5. The comparison workflow (do this every iteration)

You have computer-use MCP tools (`mcp__computer-use__*`). Use them to behave like
a real engineer using each tool, then diff.

### 5.1 Access & setup

1. Load the whole computer-use toolkit in one shot:
   `ToolSearch { query: "computer-use", max_results: 30 }`.
2. `request_access` for **Ghostty** (the terminal we test in) and any app you
   need. Re-request if you discover you need another app mid-task.
3. Terminals are granted at tier **"click"**: you can screenshot and left-click,
   but you CANNOT type into them or send keypresses via computer-use. So:
   - Drive Rika/Amp by launching them from the **Bash tool**, not by typing in
     Ghostty through computer-use.
   - Use computer-use for **observation** (screenshots, scroll, recordings) and
     for **clicks** (e.g. clicking a tool call to expand it) where clicking is
     the thing under test.
   - For prompts/keystrokes that must go into the TUI, prefer non-interactive
     paths (`rika -x`, stream-json) or scripted input, and document any step
     that genuinely needs manual keyboard input.

### 5.2 The loop (repeat until indistinguishable)

For each surface/behavior in the §6 checklist:

1. **Capture Amp** — open Amp in Ghostty, drive it to the exact state, take a
   screenshot (and a screen recording for anything animated: streaming, scroll,
   expand/collapse, thread switch). Save under `docs/parity/screenshots/amp/`
   and `docs/parity/recordings/amp/`.
2. **Capture Rika** — drive Rika to the _same_ state, capture the same way into
   the `…/rika/` folders.
3. **Diff** — put the two side by side. Look at: glyphs, box-drawing chars,
   colors/dim/bold, padding, indentation, alignment, spinner frames, label
   wording, timestamps, truncation, empty/error states, cursor shape, status
   line, footer hints. Zoom in (`mcp__computer-use__zoom`) on anything subtle.
4. **Log it** — add/update a row in `docs/parity/SCREENSHOT_LOG.md` with the file
   names, the verdict (match / mismatch), and the specific pixel/behavior delta.
5. **Fix** — make the smallest Effect/OpenTUI change that closes the delta
   (library-first per §1). Re-capture. Do not mark a row `match` without a fresh
   side-by-side pair proving it.
6. **Be relentless.** Keep iterating per surface until a stranger can't tell.
   One-pixel misalignment, one wrong dim level, one different word = not done.

### 5.3 Evidence naming

`docs/parity/screenshots/{amp,rika}/<surface>-<state>-<NN>.png`
`docs/parity/recordings/{amp,rika}/<surface>-<behavior>-<NN>.<ext>`
e.g. `amp/startup-empty-01.png` ⇄ `rika/startup-empty-01.png`.

## 6. Parity checklist (the nitpicky list — capture evidence for each)

Status legend: `unverified` (no side-by-side yet) · `mismatch` (captured, differs) · `match` (captured, indistinguishable).

### 6.1 Startup & chrome

- [ ] Startup/splash screen: logo/wordmark, version line, tips, model/mode line — exact layout, spacing, color. (`unverified`)
- [ ] Empty-state prompt area, placeholder text, footer hint line. (`unverified`)
- [ ] Status line: mode (`deep`/`smart`/`rush`), model name, reasoning effort, fast-mode indicator, git branch, cost display. (`unverified`)
- [ ] Cursor shape/blink, prompt prefix glyph. (`unverified`)

### 6.2 Streaming & transcript

- [ ] Assistant token streaming: cadence, wrapping, no flicker. (`unverified`)
- [ ] Thinking/reasoning block rendering and its expand/collapse (Alt+T). (`unverified`)
- [ ] Spinner frames and placement match Amp exactly (current Rika frames: `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` — confirm vs Amp). (`unverified`)
- [ ] Scroll up/down **while streaming** without snap-to-bottom; auto-follow resumes at bottom. (`unverified`)

### 6.3 Tool calls

- [ ] Collapsed tool-call card: glyph, name, one-line summary, status color (info/running/success/error). (`unverified`)
- [ ] **Click to expand / collapse** a tool call shows full input/output; click again collapses. Verify with computer-use click + screenshot both states. (`unverified`)
- [ ] Keyboard expand/collapse parity (`Alt+T`, focus prev/next) matches Amp. (`unverified`)
- [ ] `detailsExpandedByDefault` behavior matches Amp's setting semantics. (`unverified`)
- [ ] Diff/edit tool rendering (added/removed line colors, file header). (`unverified`)
- [ ] Error tool result rendering. (`unverified`)

### 6.4 Threads

- [ ] Thread switching: how the list looks, how switching animates/redraws, transcript reload. Record it. (`unverified`)
- [ ] New thread / archive thread flows and their key chords (`Ctrl+C Ctrl+N`, archive). (`unverified`)
- [ ] Thread reference (`@@` search) and file mention (`@`) pickers. (`unverified`)

### 6.5 Command palette & keybindings

- [ ] `Ctrl+O` command palette: layout, filtering, categories, item wording. (`unverified`)
- [ ] Full keymap parity vs `amp config keymap` (modes `Ctrl+S`, history `Ctrl+R`, editor `Ctrl+G`, reasoning `Alt+D`, fast `Alt+R`, etc.). (`unverified`)
- [ ] Message queueing (Enter Enter steer, Esc Esc interrupt) and edit-prior-message (Tab → e). (`unverified`)

### 6.6 Wording & misc

- [ ] All user-facing strings, notices, and error copy match Amp's wording. (`unverified`)
- [ ] Image paste affordance, `@file` mention, cost line format. (`unverified`)

> This list is not exhaustive. As you find new Amp behaviors, add rows. The
> companion `docs/parity/AMP_FEATURE_INVENTORY.md` is the full feature map.

## 7. Definition of done

A surface is **done** only when ALL hold:

1. Side-by-side Amp/Rika evidence exists in `docs/parity/` and is linked from
   `docs/parity/SCREENSHOT_LOG.md`.
2. The verdict is `match` and the delta column is empty.
3. The relevant §2 non-functional requirements still pass for that surface.
4. No new code comments; any custom code is justified by §1.

The **project** is done when every §6 row and every applicable row in the
feature inventory is `match`, the four §3 upgrades work without altering chrome,
and a blind side-by-side test is a coin flip.

## 8. Companion living documents

- `docs/parity/AMP_FEATURE_INVENTORY.md` — every Amp feature, mapped to its Rika
  location and parity status. Keep it current as features are verified.
- `docs/parity/SCREENSHOT_LOG.md` — the running log of every screenshot/recording
  pair and its verdict. Append to it every iteration; never delete history.
- `docs/LAUNCH_CHECKLIST.md` — existing higher-level Amp-parity matrix.
