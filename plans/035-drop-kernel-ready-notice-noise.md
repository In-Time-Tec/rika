# Plan 035: Drop the "Kernel ready at profile …" notice — it is noise the model cannot act on

> **Status**: PROPOSED (research-backed; not yet dispatched)
> **Priority**: P2 · **Effort**: S · **Risk**: LOW · **Category**: UX / model-context hygiene
> **Depends on**: none
>
> **Executor note**: this plan is written for review first. It removes the
> `KernelReady` cell notice (the `"Kernel ready at profile <digest>."` line seen
> after calls) from `eventNotice`, keeps the `KernelStarting` ("Starting the
> kernel.") signal, and adds one test that locks the contract. It deliberately
> does **not** touch the notices that carry actionable state:
> `KernelRestarted`, `StateRestored`, and `StateLost`.

## Why this matters

Every cell that triggers a fresh kernel provisioning shows a notice
`Kernel ready at profile <digest>.` in its body text. The profile digest is a
hash of the kernel profile (workspace digest, skills, servers) — an opaque
string the model cannot interpret or act on, and "ready" is a lifecycle fact the
model never consumes. Because a session's kernel idles out after 5 minutes and
is re-provisioned on the next call, the notice reappears on the first cell of
each resumed turn, so to a user it looks like it fires "after every call."

The model's only real need at a fresh-kernel boundary is: _which previously-set
state survived?_ That answer is already carried by the notices we **keep** —
`StateRestored` ("Restored total, rows."), `StateLost` ("Lost handle
(live-handle)."), and for in-session crashes `KernelRestarted` ("Kernel
restarted (reason) at epoch N"). The `KernelReady` line adds nothing to any of
these.

## Evidence — where the notice comes from (traced)

1. **Produced**: `packages/baton-execution/src/baton-recovery-projection.ts`,
   `eventNotice()`:
   - `case "KernelStarting"` → `{ kind: "starting", detail: "Starting the kernel." }`
   - `case "KernelReady"` → `{ kind: "ready", detail: `Kernel ready at profile ${optionalString(event.profileDigest)}.` }`

2. **Attached to a cell**: `packages/baton-execution/src/baton-cell-projection.ts`,
   `progressCell()` calls `appendNotice(block, eventNotice(event))` for every
   progress event, so the `KernelReady` notice lands on whichever cell is open
   when the event arrives.

3. **Shown to the model**: `packages/transcript/src/presentation/cell-presentation.ts`,
   `cellBodyText()` joins `...cell.notices.map((notice) => notice.detail)` into
   the cell body text — so `Kernel ready at profile <digest>.` is literally part
   of the transcript block the model reads (and the TUI expanded cell view).

## Why it appears "after every call"

- The kernel pool is **server-scoped, one kernel per session**, explicitly
  reused across cells (`packages/kernel/src/kernel-composition.ts`:
  "A Session must reuse its worker across Runs, so the kernel is held well beyond
  one cell.").
- Idle kernels are disposed after `defaultIdleTimeToLive = Duration.minutes(5)`
  (`kernel-composition.ts:44`); the server supplies no override, so the default
  holds.
- Each (re)provisioning emits a `KernelStarting` then `KernelReady`, so the
  ready notice fires on the **first cell of the session** and the **first cell of
  every turn that resumes after the 5-minute idle TTL**. In a long conversation
  whose turns are minutes apart, that reads as "after every call."
- `deadlinePool` in `packages/baton-execution/src/baton-route.ts` only remaps
  timeout failures; it does not dispose kernels, so this is not a per-cell
  kernel-spawn bug.

## Is it needed? — no

- The **profile digest is unactionable**: it is a hash of workspace digest +
  skills + servers. The model cannot decode it or branch on it.
- **"Ready" is not something the model acts on.** The cell cannot run until the
  kernel is ready anyway; the model only ever sees post-ready output.
- The **actionable facts are already covered** by notices this plan keeps:
  - `StateRestored` → which bindings came back.
  - `StateLost` → which bindings are gone and why.
  - `KernelRestarted` → in-session crash with reason + epoch, plus a
    transcript-level "bindings may be gone" notification.
- Therefore `KernelReady` is redundant, model-visible noise. Removing it costs
  the model nothing it can use.

## Conservative alternative (not recommended)

Drop only the digest from the message (`"Kernel ready."`) instead of removing
the whole `KernelReady` case. This still leaves a low-value "ready" line on
every resumed turn; the digest is only half the reason the line is noise. If the
reviewer prefers the smallest possible diff, this is the fallback.

## The change

On `main` (currently clean, 0 ahead / 0 behind `origin/main`):

1. **Remove the `KernelReady` case** from `eventNotice()` in
   `packages/baton-execution/src/baton-recovery-projection.ts`. Keep
   `KernelStarting`, `KernelRestarted`, `StateRestored`, `StateLost`.
   - `KernelStarting` stays as the single, cheap "fresh kernel" signal so a
     resumed thread's model still knows prior cells are history until
     `StateRestored`/{`StateLost` report what survived.
2. **Update the doc**: `docs/features/cell-presentation.md` currently says
   "the kernel starting and becoming ready at a profile digest, a restart with
   its reason and epoch, restored binding names, and lost binding names with a
   reason." Change to "the kernel starting, a restart with its reason and epoch,
   restored binding names, and lost binding names with a reason."
3. **Add one test** in `packages/baton-execution/test/baton-cell-projection.test.ts`
   asserting that a `KernelStarting` and a `KernelReady` progress event no
   longer append `starting`/{`ready`} notices to the observing cell (and that
   `KernelRestarted`/{`StateRestored`}/{`StateLost`} still do). This locks the
   contract so the noise stays gone.

## Files touched

- `packages/baton-execution/src/baton-recovery-projection.ts` (remove one case)
- `packages/baton-execution/test/baton-cell-projection.test.ts` (add test)
- `docs/features/cell-presentation.md` (one sentence)

## Verification

Run from the repo root (`/Users/dallen.pyrah/projects/Rika`):

- `bun turbo run --continue typecheck "//#test-unit" --filter=@rika/baton-execution`
- `bun vitest run packages/baton-execution/test/baton-cell-projection.test.ts`
- `bun run ast-grep-check` (no new patterns to add; confirm no regressions)
- Manual: start `bun --cwd apps/rika start`, run a cell, confirm the cell body
  no longer contains `Kernel ready at profile`, and that `Starting the kernel.`
  still shows on a fresh provisioning.

## STOP conditions

- If any in-scope file changed materially since this plan was written (drift),
  re-check the `eventNotice` excerpts against the live code before proceeding.
- If the `KernelReady` event is now consumed anywhere else for model-facing
  text (grep `KernelReady` and `kind: "ready"`), stop and reassess.
- If a test somewhere asserts the `ready` notice (git grep
  `ready at profile` / `kind: "ready"`), update or stop as appropriate.
- Do **not** remove `KernelRestarted`, `StateRestored`, or `StateLost` — they
  carry the state the model actually needs.
