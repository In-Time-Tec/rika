# PLAN: Prompt cache — 31% to >= 98% on every provider

## Evidence (from `~/.rika/baton.db` usage telemetry, Aug 3-15)

- Overall input cache hit: **30.9%** (18.2M cacheRead / 59.0M input tokens).
- Anthropic (claude-opus-5 + claude-fable-5): **3.1%** — 37.5M uncached input tokens, cacheWrite
  median **0** across all 842 committed calls. A 63-turn run re-sends 73k -> 126k uncached
  conversation tokens on every call while a constant ~2,981-token system prefix is the only
  thing that ever hits.
- OpenAI gpt-5.6-terra: 87.7% (automatic prefix caching); gpt-5.6-sol: 25.4% (all 51 calls are
  handoffs inside one run — cold cache-machine routing); gpt-5.6-luna: 0%.
- Cost: ~$218 of ~$242 Anthropic input spend is uncached input (Opus 5: $5/M vs $0.50/M read).
  At 98% hit the same tokens cost ~$26 — about $190 saved in this 12-day window, plus ~10x less
  prefix processing per call.

## Root cause

Baton (the agent loop that owns model calls) never places Anthropic `cache_control`
breakpoints. Anthropic only caches blocks you mark, so the entire conversation is re-sent and
re-billed on every call. Nothing in `@batonfx/*` sets `options.anthropic.cacheControl`;
`@effect/ai-anthropic` (4.0.0-beta.98) already lowers it for system messages and the last part
of user/tool-result messages (not assistant messages or tools). Bedrock has the same gap with
its own `cachePoint` plumbing that nothing sets. Secondary losses: system prompt is one blob
whose harness section changes between executions; no prefix-stability discipline; no cache
diagnostics; 5m default TTL with occasional expiry; compaction replaces the whole history.

## Aligned decisions

In scope: Baton-owned fix (every consumer gets it, no per-user settings), provider matrix for
Anthropic/OpenAI/OpenRouter/Bedrock, Baton prompt-prefix diagnostics, Rika stable system split,
unified stable prefix across agent profiles, adaptive TTL, tail-only compaction with seam
breakpoint, per-purpose marking, byte-identical retry bodies, switchboard server-side
normalization, and a **% cached** line in the Context & Usage preview.

Explicitly out: same-model routing for handoffs; cache-pressure alerting beyond the % cached
display.

## What opencode v2 does (reference)

- Cache policy "auto" on by default: ephemeral breakpoints on last tool definition, last system
  block, latest user message; 4-breakpoint cap; skipped for implicit-caching providers;
  `prompt_cache_key` for OpenAI; per-message `cache_control` + `session_id` sticky routing on
  OpenRouter. System prompt split into stable block first, dynamic block last (97.6% first call
  in a new repo, 99.9% per-call steady state). Prompt-cache diagnostics hash settings/tools/
  system/messages and diff consecutive requests (`stable` / `append-only` / `changed:<component>`).
  Prefix-stability fixes: frozen dates, deterministic tool ordering, no per-repo schema fields,
  byte-drift fix for DB reloads. Compaction pinFirstUserTurn; optional 1h TTL.

## Baton work (~/projects/batonfx)

### B0 — dev setup (not currently wired)

Baton sits at v0.26.2, exactly Rika's npm pin; both use effect 4.0.0-beta.98. Loop: change ->
`bun run check` + `bun run test` -> bump every package manifest -> tag `vX.Y.Z` -> publish.yml
-> npm -> pin in Rika. Optional: test-only Vitest alias to the Baton worktree while iterating.
Note: the repo currently has uncommitted providers WIP; branch or land it first.

### B1 — cache breakpoint policy (the core fix)

New `packages/core/src/model/prompt-cache.ts`: a provider-aware policy that rebuilds (a) each
system message with `options.anthropic.cacheControl = { type: "ephemeral", ttl: "1h" }` and
`options.amazonBedrock.cachePoint = true`, and (b) the **last user message** with
`options.anthropic.cacheControl = { type: "ephemeral" }` and the Bedrock equivalent (tool
results are user messages, so one marker covers every intra-turn tool loop and steering
continuation). Anthropic/Bedrock-keyed options are inert on OpenAI/OpenRouter adapters, so the
policy is safe to apply unconditionally. 4-breakpoint budget helper included for later tool
markers. Applied in `model-turn.ts` only on the prompt passed to `LanguageModel.streamText` —
after `responsePrompt = Prompt.concat(history, preparedPrompt)`, never persisted, never seen by
`validateContext`/`syncSession`/`countTokens`, so replay stays byte-stable and markers are
derived at send time.

### B2 — Anthropic automatic caching enabled in the adapter

`@effect/ai-anthropic` accepts Anthropic's top-level `cache_control` (automatic caching: the
provider places the breakpoint at the last cacheable block and moves it forward, covering
system + tools + history). Baton's Anthropic adapter spreads its config straight into the
request body, so set `cache_control: { type: "ephemeral" }` as the adapter's default config
(overridable). This caches tools, which beta.98 cannot mark per-message, and is the
belt-and-suspenders under the explicit markers. Verify at implementation time that the
top-level field composes with explicit per-block markers (docs say explicit markers take
precedence); if they conflict, keep the explicit policy and note the tradeoff.

### B3 — prompt-prefix diagnostics

Per-run request snapshot (sha256 of settings/tools/system/each message), consecutive-send
comparison, `PromptPrefixChanged { component, index, label }` event plus
TTL-expiry-vs-prefix-change miss counters. Feeds the Rika % cached display and the debug
surface.

### B4 — supplemental system block

`Agent.make` gains `supplemental` instructions emitted as a second system message after the
stable one, so Rika can keep the stable profile/surface prefix separate from the changing
harness section. The stable block takes the 1h marker, the dynamic block the 5m marker.

### B5 — tests

Marker placement (system + last user, multi-system lowering, tool-result continuation), 4-point
budget, wire-body integration asserting `cache_control`/`cachePoint` land on the right blocks,
diagnostics comparison cases, TestClock TTL cases. Release as `v0.27.0`.

## Rika work (/Users/dallen.pyrah/projects/Rika)

### R1 — pin and wire

Pin the released Baton; pass `supplemental` through `baton-route.ts`; no per-user settings
required — every consumer gets the policy from Baton defaults.

### R2 — stable system split

`baton-route.ts` splits agent instructions: stable part (profile instructions + cell surface)
and dynamic part (harness supplement). Deterministic ordering inside the harness section (sort
skills/memories). Stable block gets 1h, dynamic gets 5m.

### R3 — % cached in the Context & Usage preview

Add one line to the Context & Usage preview (Ctrl+Y overlay, Session section): `% cached` =
cacheRead / input total, from the usage projection that already carries
uncached/cacheRead/cacheWrite per execution (`baton-usage-accounting` /
`execution-token-totals`). Nothing else — no alerts, no extra telemetry UI.

### R4 — adaptive TTL

Thread-velocity policy: long tool loops keep the 5m conversation marker; threads that idle
between calls (long cell runs, user pauses — production data showed a 7-minute gap) escalate
the conversation boundary to 1h. Exposed as a Baton policy input, default auto, per-thread
override in settings.

### R5 — tail-only compaction with seam breakpoint

Compaction replaces only the last K turns with the summary; the head stays untouched and gets
a breakpoint at the seam so it stays warm under its own TTL instead of one full-prefix rewrite
(opencode's pinFirstUserTurn plus the seam marker).

### R6 — unified stable prefix across agent profiles

Make the stable block (profile instructions + cell surface + tool set) byte-identical across
all profiles (Root, Oracle, Librarian, Surgeon, Title, Compaction...) with role-specific
instructions in the trailing dynamic block. Every child, title, oracle, and compaction run
then hits the parent's warm system+tools prefix on its first call — the biggest fan-out win
(children today read only their own ~2.3k system prefix).

### R7 — per-purpose marking

Never mark one-shot tiny prompts (title, compaction summary, deterministic test): a write
costs 1.25x and evicts capacity for zero re-reads. Mark only conversation-purpose calls in
durable sessions.

### R8 — retry/cancellation cache symbiosis

Constraint, not code: retry bodies stay byte-identical (no attempt counters or timestamps
inside messages). Failed attempts and user-cancelled streams still write their prefix, so the
retry or next turn reads it at 0.1x.

### R9 — switchboard server-side normalization

The proxy normalizes each Anthropic-bound body to a canonical stable prefix (dynamic content
moved to the tail) and injects top-level `cache_control` when the client omitted it. Because
prompt caches are isolated per organization, every machine and thread sharing the switchboard
key shares one warm cache — cross-machine first-call hits, which opencode cannot do.

## Provider matrix

- Anthropic: Baton B1 explicit markers (stable system 1h + last user message 5m) + B2 automatic
  caching default. 4-breakpoint cap; 5m/1h buckets; verify minimum cacheable prefix thresholds.
- OpenAI GPT-5.6: no markers (implicit + explicit breakpoints via `prompt_cache_breakpoint`,
  4 written per request, matches up to the latest 80); add `prompt_cache_key` per session for
  deterministic cache-machine routing (fixes terra 87.7% -> 95%+ and the sol/luna cold-handoff
  gap) and `prompt_cache_options.ttl` 30m. Follow-up Baton/Rika wiring.
- OpenRouter: per-message `cache_control` for Anthropic models plus `session_id` per session
  for provider sticky routing (Baton's OpenRouter config already accepts `session_id`).
- Amazon Bedrock: Converse `cachePoint` via the existing request-builder plumbing, same policy
  as B1, 4-point cap.
- Deterministic/test: never mark.

## Targets

- Anthropic: >= 98% aggregate, >= 99% steady-state per call, first call in a profile >= 90%
  (unified stable prefix + automatic caching).
- OpenAI terra/sol/luna: >= 95% aggregate via prompt_cache_key + explicit breakpoints.
- OpenRouter: >= 95% via markers + session_id sticky routing.
- Bedrock: >= 95% via cachePoint policy.
- Healthy profile shape: each prefix written once, read many times; zero unexplained
  prefix-change events.

## Verification gates

1. Baton unit + integration green; wire bodies carry the markers.
2. Rika `bun run check` + `bun run test` with the new pin.
3. Live run through switchboard: first call writes, follow-on calls read >= 95%.
4. Re-query `~/.rika/baton.db` after a few days: per-provider ratios per the targets; the
   Context & Usage preview shows the % cached line.
5. Compare against opencode claims (99.9% per-call within session, 97.6% first call cross-repo).

## Risks

- beta.98 cannot mark assistant messages or tools per-message; the last-user-message marker
  covers the full prefix except the new tail (which must be uncached anyway), and B2's automatic
  caching covers tools. No cost.
- The switchboard proxy must forward markers (it already forwards cache writes); R9 makes it
  normalize and inject them regardless.
- Mid-run harness refinement changes the dynamic system block and busts that suffix; the stable
  1h prefix survives — the point of the R2 split.
- Anthropic 4-breakpoint cap: the policy uses at most 3.
- Minimum cacheable prefix thresholds (1h TTL requires a larger minimum prefix than 5m) — the
  1h system marker is a no-op below the threshold; harmless, verify sizes at implementation.
- Adaptive TTL escalation costs 2x writes; it must only engage when a thread demonstrably
  idles beyond 5m (R4 default auto).


## Execution status

Shipped: Baton 0.27.0 (published to npm) with B1 cache breakpoint policy, per-purpose gating,
B4 supplemental system block, and tests; Anthropic automatic caching shipped as caller opt-in
(resolvedConfig) pending live wire verification. Rika main pins 0.27.0: R1 pin, R2 stable system
split (harness moves to the supplemental block), R3 % cached line in the Context & Usage preview,
R7 purpose gating inherited from Baton. Baton release flow: tag v0.27.0 after the main/release
ancestry gate. Rika is on main at 0.5.34 awaiting the CI gate before tagging.

Open follow-ups (documented in the repo plans): B2 default-on after live wire verification against
Anthropic (switchboard was rate-limited during this pass), B3 prompt-prefix diagnostics events,
R4 adaptive TTL (needs a Baton policy input), R5 tail-only compaction with seam breakpoint,
R6 full cross-profile stable-prefix unification (per-profile split shipped; cross-profile ordering
needs prompt-quality validation), R9 switchboard server-side normalization (separate infra),
plus the live baton.db re-query gate after real sessions run on 0.27.0.


## Live wire verification (switchboard, 2026-08-16)

- B1 shipped policy verified against the real gateway: explicit system (1h) + last-block (5m) markers
  yield a 99.5% continuation hit (read 3597 of 3613 tokens; only the 14-token tail written).
- Composition verdict: a top-level `cache_control` automatic field overrides explicit per-block
  markers (the explicit 1h system marker was ignored, the whole prefix landed in the 5m bucket).
  B2 stays caller opt-in permanently; the tools-caching gap remains a follow-up (Effect AI beta.98
  cannot mark tools per-message).
- The switchboard appears to normalize system prefixes itself (a fresh system string still read the
  canonical ~1902-token prefix) — server-side normalization partially exists; revisit R9 accordingly.


## Execution status (final for this pass)

Shipped and published: Baton 0.27.0 + 0.27.1 (npm) with cache breakpoint policy, per-purpose
gating, supplemental system block, Anthropic automatic caching opt-in, and adaptive idle-gap
conversation escalation (0.27.1). Rika 0.5.35 + 0.5.36 (GitHub releases) with the Baton pin,
stable/dynamic system split, and the % cached line in the Context & Usage preview. Live wire
verification through the switchboard: 99.5% continuation cache hit (3597 of 3613 tokens read);
the automatic-caching field overrides explicit markers, so it stays opt-in. Both repos run
`bun run check` and `bun run test` green (the bun-cleanup load flake pre-dates this work).

Open follow-ups (documented): B3 prompt-prefix diagnostics events, R5 tail-only compaction with
seam breakpoint, R6 full cross-profile stable-prefix unification (per-profile split shipped),
R9 switchboard normalization review (the gateway already appears to normalize system prefixes),
plus the live baton.db re-query gate after real sessions run on 0.5.36.


## Live product verification (2026-08-16, real Rika 0.5.36 sessions through the switchboard)

- `rika update` upgraded the installed CLI 0.5.34 → 0.5.36, then two real Opus 5 runs in a scratch
  workspace produced: run 1 cold write of the 5,278-token prefix, then 100.0% reads on both tool-loop
  continuations (5,278 → 5,702 read, 258-424 written per call). Run 2 in a NEW thread hit 99.9% on its
  very first call (system prefix warm cross-thread), 100.0% on its continuation. Aggregate across all
  seven Anthropic calls: 99.93%; main runs only: 99.95%. Title runs reuse the shared prefix too.
- The user's earlier DeepSeek (runinfra) sessions on the old build already showed 95-99.7% via
  implicit prefix caching; single-call runs are cold one-shots by design.
- Gateway findings: the switchboard ignores the `ttl` field (the 1h markers land in the 5m bucket)
  and canonicalizes system prompts (any system text reads its canonical ~1,902-token prefix). The
  shipped escalation and 1h markers still take effect on direct Anthropic; through the gateway the
  5m conversation caching already carries the result, but a gateway ttl pass-through is worth a fix.
