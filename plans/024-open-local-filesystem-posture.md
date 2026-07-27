# Plan 024: Wide-open local filesystem posture with a hardcoded circuit breaker

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row in
> `plans/README.md`.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH (deliberate reduction in safety posture)
- **Depends on**: none. **Supersedes plans 001, 002, and 010** — see "Interaction with existing plans".
- **Category**: direction

## Why this matters

Rika confines every file and process tool to the Workspace directory. Two
consequences hit the owner constantly:

- A path that resolves outside the Workspace fails hard with
  `Path escapes workspace`, so the agent cannot read a sibling repo, a
  dotfile, or an absolute path the user just pasted.
- Path casing is unforgiving. There is no casing tolerance anywhere in the
  code, and on a case-insensitive macOS volume the raw-vs-canonical Workspace
  asymmetry in `tool-runtime.ts` produces _spurious_ escape errors. Reads
  accidentally survive through the workspace-index fuzzy fallback; writes and
  edits do not.

The target posture is Pi's: the agent runs with the permissions of the user
who started it, the Workspace is a _scope_, not a _security boundary_, and the
only hard refusals are a tiny set of actions no one ever wants.

**Pi's real model, for reference** (verified against pi.dev docs and the
`earendil-works/pi` repo): Pi core has no workspace confinement, no permission
system, no deny-list, and no per-tool prompts — "No permission popups. Run in
a container, or build your own confirmation flow with extensions." Its project
trust gate covers only loading project-local config/extensions and is
explicitly "not a sandbox." Pi's dangerous-command matching lives in an
_example extension_, not core. Claude Code, by contrast, keeps `rm -rf /` and
`rm -rf ~` prompting even in `bypassPermissions` mode as a circuit breaker.
This plan takes Pi's posture plus Claude Code's circuit-breaker idea.

## The honest framing (must appear in docs and in the PR)

With unrestricted `bash -lc`, **no string deny-list is a sandbox**. Any rule is
bypassable through variables, `eval`, aliases, an interpreter, a generated
script, or an alternate utility. The circuit breaker is a guard against
_catastrophic mistakes_, not against a hostile model. Anyone needing a real
boundary must run Rika in a container. Do not describe the deny list as
security anywhere in the product or docs.

## Current state

### Containment sites (five, all independent implementations)

| Site                                                                                                    | What it does                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/tools/src/tool-runtime.ts:456-551`                                                            | `resolve` / `resolveCwd` / `resolveEdit` / `resolveContained` / `resolveRead` — the agent tool surface |
| `packages/tools/src/media-view.ts:98-136`                                                               | `view_media` containment, `MediaPathError`                                                             |
| `apps/rika/src/main.ts:213-259`                                                                         | `resolveWorkspacePathImpl`, `resolveWorkspaceFileImpl`; toast at `:2377`                               |
| `packages/app/src/resolved-context.ts:43-131`                                                           | `@`-references and guidance discovery; `PathOutsideWorkspace` diagnostics                              |
| `packages/extensions/src/skill-registry.ts:143-180`, `packages/app/src/extension-operations.ts:211-219` | skill-package integrity                                                                                |

`tool-runtime.ts` specifics that must change:

```ts
// 455
const canonicalWorkspace = yield* fileSystem.realPath(workspace).pipe(Effect.orDie)
// 456-471 resolve: lexical prefix check against the RAW workspace string
if (target !== workspace && !target.startsWith(`${workspace}${path.sep}`))
  throw runtimeError({ category: "access_denied", message: `Path escapes workspace: ${value}`, ... })
// 493-517 resolveEdit: fails on ANY symlink path segment
// 537-551 resolveRead: on miss, falls back to workspaceIndex.fileSearch and reads the best match
```

Call sites: `Grep` result mapping `:576` (`resolveContained`), `Read` `:597`
(`resolveRead`), `Write` `:607` and `Edit` `:618` (`resolveEdit`), `Bash` `:666`
and `Shell` `:677` (`resolveCwd`). `Bash` runs `/bin/bash -lc <command>` at `:667`
with only the cwd contained — the command string is unchecked today.

### Permissions

- `packages/config/src/config-contract.ts:10` `PermissionDecision = "allow" | "ask" | "deny"`; `:153` open string-keyed map; `:625-631` validates values only, never keys; `:712` defaults `{read, search, write, shell, external}` all `"allow"`.
- **Only `shell` is enforced.** `apps/rika/src/main.ts:1380-1389` and `:1445-1460` emit the Relay ruleset `[{pattern:"*",level:"allow"},{pattern:"bash",level:shellPermission}]` as `permission_rules`.
- `packages/app/src/operation.ts:2272-2276, 4043-4075, 4339-4346`: user-typed shell; `deny` short-circuits, `ask` raises `ShellPermissionRequested`, `always` latches a session flag.
- `packages/tools/src/tool-policy.ts:3` `Permission = Schema.Literals(["allow","ask"])`, `Policy.allow()` the only constructor.
- **No deny-list or dangerous-command detection exists anywhere in the repo.**

## Decisions

### D1 — Which sites open up

| Site                           | Decision                                                                                                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool-runtime.ts`              | **Remove containment** for `Read`, `Write`, `Edit`, `Bash.workdir`, and `Shell.cwd`. Also drop the symlink-write prohibition: following a symlink is ordinary filesystem behavior and protects nothing once external paths are allowed.                                         |
| `media-view.ts`                | **Remove containment.** Keep existence, regular-file, size, and type checks. Otherwise the agent can read a file but not view it.                                                                                                                                               |
| `main.ts` TUI open             | **Remove containment.** Keep "must be an existing regular file". Replace the containment toast with the real typed error.                                                                                                                                                       |
| `resolved-context.ts`          | **Split.** _Explicit_ `@`-references may point anywhere (an agent that can `read /other/repo/x.ts` but a user who cannot `@` it is incoherent). _Automatic_ discovery of `AGENTS.md`/`AGENT.md`/`CLAUDE.md`, workspace settings, and project extensions stays Workspace-scoped. |
| skill registry / extension ops | **Unchanged.** These are package-integrity and traversal checks (`remove("../outside")` must not delete an arbitrary directory), not the Workspace sandbox.                                                                                                                     |

The `resolved-context.ts` split mirrors Pi's project trust: arbitrary
filesystem _access_ must not imply automatic _trust_ of arbitrary local
instructions or config.

`Grep` stays Workspace-scoped because its schema has no root argument and it
is backed by the workspace index. That is a query scope, not a security rule.
Do not silently rebuild the index for arbitrary roots. Note the gap in docs.

### D2 — Casing tolerance

Removing containment alone is **not** sufficient. It fixes the macOS
raw-vs-canonical false rejection, and a case-insensitive volume forgives the
rest — but on a case-sensitive filesystem nothing improves. Ship a real
resolver.

New module `packages/tools/src/local-path.ts` (exported for `@rika/app` and
the CLI, which already depend on `@rika/tools`), over a small filesystem
lookup interface so `resolved-context.ts` can adapt its testable
`ContextFileSystem`:

```ts
resolveExistingPath(input, { base, kind: "file" | "directory" })
resolveWriteTarget(input, { base })
```

`resolveExistingPath` algorithm:

1. Resolve relative input against the session Workspace.
2. Try the requested path exactly. **Exact spelling always wins.**
3. Only on a genuine `NotFound`/`ENOENT`, walk components from the filesystem root.
4. At each missing component: read the parent directory, compare
   case-insensitively, accept a **unique** match.
5. Two or more case variants → fail with a typed ambiguity error.
6. Propagate `EACCES` and I/O errors untouched. Never turn a permission error
   into a case scan.

Correction must be **component-by-component**, not a final-sibling scan:
`SRC/Components/button.ts` can be miscased in several segments.

`resolveWriteTarget` needs two modes because `Write` both overwrites and
creates:

1. Correct casing for every existing **parent** component.
2. Final name exists exactly → use it.
3. Final name has one unique case-insensitive existing match → overwrite it.
4. No match → **preserve the requested spelling** and create.
5. Ambiguous → fail.

So with `src/File.ts` present: `write("SRC/file.ts")` overwrites `src/File.ts`;
`write("SRC/NewFile.ts")` creates `src/NewFile.ts` — and never creates a
parallel `SRC/` directory.

Per-tool wiring:

- `Read` → `resolveExistingPath`. Keep the workspace-index fuzzy fallback, but
  only after exact/case resolution fails **and** only when the lexical target
  is under the Workspace. Never run workspace fuzzy search for an unresolved
  absolute/external path — `read /tmp/missing.ts` must not silently return an
  unrelated workspace file.
- `Edit` → `resolveExistingPath` only. **Never** fuzzy filename selection for a
  mutation.
- `Write` → `resolveWriteTarget`.
- Do not conflate case folding with Unicode normalization.

Support leading `~` / `~/...` expansion consistently across the local path
APIs (today `~` is a literal directory name). No other shell expansion.

### D3 — The always-deny circuit breaker

**Path-target guard: not a sensitive-directory blacklist.** `~/.ssh`,
`/etc`, and shell profiles all have legitimate edits in a wide-open agent, and
`/` and `$HOME` are directories that regular-file validation already rejects.
Instead use robust operation-domain checks:

- `Edit` requires an existing **regular file**.
- `Write` targets a new path or an existing **regular file**.
- Reject existing directories, block/char devices, FIFOs, sockets. (This also
  removes today's hazard of `readFileString` on a device before typing it.)
- Symlinks are allowed when the target is a regular file.

**Shell circuit breaker: three classes only.**

1. Recursive deletion of the filesystem root.
2. Recursive deletion of the current user's home directory.
3. The canonical shell fork bomb.

For (1) and (2) recognize the high-confidence static variants — `rm -r /`,
`rm -rf -- /`, `rm -rf /*`, `rm -rf ~`, `rm --recursive "$HOME"`,
`rm -rf "$HOME"/*`, `/bin/rm` as well as `rm`, and `rm -rf .` when the cwd is
`/` or `$HOME`. Recursion is the signal; `-f` is not required.

Use a quote-aware lexer, not substring regex, so `echo 'rm -rf /'` and
`grep 'rm -rf /' docs.md` are not blocked. **Unknown or complex syntax defaults
to allow.** Incomplete with low false positives beats complete and annoying.

**Explicitly NOT denied**: `sudo`, `chmod 777`, `chown`, `mkfs*`, `dd`,
`curl | sh`, `git push --force`, `git reset --hard`. These are Pi's example
heuristics, not universally catastrophic — `mkfs.ext4 /tmp/img`,
`dd of=/dev/null`, and preparing a removable disk are all real. They fail the
"no one would ever want this" bar.

A circuit-breaker refusal is `access_denied`, `outcome: "known"`,
`recovery: "never"`, clearly labelled a non-overridable Rika circuit breaker.
It must never become an `ask` prompt.

### D4 — Where the check lives

Relay's `permission_rules` are tool-_name_ admission rules and cannot express
"allow Bash except recursive deletion of home." Enforce in Rika's tool runtime.

Both paths already converge on `ToolRuntime.Service.run` — model-issued Bash
becomes a `Bash` request, user-typed shell becomes a `Shell` request — and both
reach `ProcessRegistry.start`. Add a pure classifier in
`packages/tools/src/local-safety-policy.ts`:

```ts
checkProcessInvocation({ executable, args, cwd, home, shellScript })
```

and one checked process-start helper used by both the `Bash` and `Shell`
branches immediately before `ProcessRegistry.start`. Keep `ProcessRegistry`
generic — product command policy there would affect internal maintenance
processes and future callers.

The runtime check is authoritative. `operation.ts` may later call the same pure
classifier as a preflight so a doomed shell prompt is never shown, but the
rules live in exactly one module.

Scope limit to state in docs: MCP servers, extensions, editor launches, and
notification commands do not route through `ToolRuntime` and are **not**
covered.

### D5 — Config surface

Four of the five permission categories (`read`, `search`, `write`, `external`)
are read, merged, and displayed but **never enforced**. A setting that claims
to deny and does not is worse than no setting.

- Keep exactly one typed policy: `permissions.shell: "allow" | "ask" | "deny"`, default `"allow"`.
- Remove `read`, `search`, `write`, `external` from defaults, validation, and the `doctor`/`config list` display.
- Emit a migration warning when a config still sets them; do not silently ignore them.
- Do **not** reinterpret `external` as "outside workspace".
- Keep the approval-card infrastructure — it also serves durable tool approvals.
- The circuit breaker is **hardcoded**, versioned with Rika, not bypassable by `allow`/`always`, and not configurable downward. Additive user rules can come later; no arbitrary regex config in v1.

This is "wide open by default with an opt-in shell gate" — not literally Pi's
no-permission-system model. Say so plainly in the docs.

### D6 — What `workspace` still means

It remains: base for relative paths, default process cwd, workspace-index and
`grep` root, automatic guidance root, settings scope, extension/skill trust
scope, thread/persistence scope, UI project identity. Traps to avoid:

- Reading or editing `/other/project/file.ts` must **not** load that project's
  `.rika/settings.json`, extensions, or change the thread's workspace identity.
- Keep fuzzy lookup workspace-local; the index is not a global filesystem search.
- Resolve relative input against `path.resolve(workspace)`; do **not** substitute
  `realPath(workspace)` first, because a symlinked workspace then gives
  different `..` semantics. Canonical paths are for identity and display only.
- Display: relative paths inside the Workspace, **normalized absolute** paths
  outside — not `../../../../other/project/file.ts`. Applies to diffs and TUI
  click-to-open.

## Scope

**In scope**

- `packages/tools/src/tool-runtime.ts`, new `packages/tools/src/local-path.ts`, new `packages/tools/src/local-safety-policy.ts`, `packages/tools/src/media-view.ts`, and the `@rika/tools` index export.
- `apps/rika/src/main.ts` — TUI file open (`:213-259`, toast `:2377`), permission policy (`:1380-1389`, `:1445-1460`).
- `packages/app/src/resolved-context.ts` — explicit-vs-automatic split.
- `packages/config/src/config-contract.ts`, `packages/config/src/config-service.ts`, `packages/app/src/config-operations.ts` — collapse to `shell` only.
- `packages/app/src/operation.ts` — only if the preflight in D4 is taken.
- Tests and docs listed below.

**Out of scope**

- `packages/extensions/src/skill-registry.ts`, `packages/app/src/extension-operations.ts` — unchanged.
- `packages/runtime/src/execution-backend.ts` — the `permission_rules` plumbing is fine; only rule _content_ changes upstream.
- `repos/*` — never read, import, or edit.
- Any container/sandbox runner. Out of scope for this plan.

## Steps

### Step 1 — `local-path.ts`, pure and tested first

Implement `resolveExistingPath` and `resolveWriteTarget` per D2 with typed
errors (`NotFound`, `AmbiguousCase`, passthrough I/O). Unit-test against a real
temp filesystem: exact wins over a case variant; multi-segment correction;
ambiguity failure; `EACCES` passthrough; write creates with the requested
spelling; write overwrites the unique case variant; `~` expansion.

**Verify**: `bun --bun vitest run packages/tools/test/local-path.test.ts` → pass.

### Step 2 — `local-safety-policy.ts`, pure and tested first

Implement `checkProcessInvocation` per D3 with a quote-aware lexer. Test both
directions hard: every deny variant listed in D3 denies; and
`echo 'rm -rf /'`, `grep 'rm -rf /' docs.md`, `rm -rf ./build`,
`rm -rf node_modules`, `sudo apt install x`, `dd of=/dev/null`,
`mkfs.ext4 /tmp/img`, `git push --force` all **allow**.

**Verify**: `bun --bun vitest run packages/tools/test/local-safety-policy.test.ts` → pass.

### Step 3 — Rewire `tool-runtime.ts`

Delete `resolve`, `resolveCwd`, `resolveEdit`, `resolveContained`,
`isContained`, `canonicalWorkspace`, and the symlink-segment walk. Wire each
tool to the D2 resolvers, add the D3 file-type guards to `Write`/`Edit`, and
route `Bash`/`Shell` through the checked process-start helper. Keep the `Read`
fuzzy fallback gated to workspace-lexical targets only.

**Verify**: `bun run typecheck` → exit 0.

### Step 4 — `media-view.ts` and the TUI open path

Drop containment from both. In `main.ts`, remove `resolveWorkspacePathImpl`
(confirm it is unused), relax and rename `resolveWorkspaceFileImpl` to
`resolveLocalFile`, and replace the `:2377` toast with the typed error.

**Verify**: `bun run typecheck` → exit 0.

### Step 5 — `resolved-context.ts` split

Explicit references resolve anywhere through `resolveExistingPath`; automatic
guidance discovery stays Workspace-rooted. Drop `PathOutsideWorkspace` for
explicit references; keep the rest of the diagnostic union. Absolute display
paths for external sources.

**Verify**: `bun --bun vitest run packages/app/test/resolved-context.test.ts` → pass with inverted cases.

### Step 6 — Config collapse

Per D5. Include the migration warning for removed keys.

**Verify**: `bun --bun vitest run packages/config` → pass.

### Step 7 — Invert tests and rewrite docs

See the two tables below.

**Verify**: `bun run check` → exit 0.

## Tests to invert or delete

| File                                                                                                                                       | Change                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `packages/tools/test/tool-runtime.test.ts:506` "rejects escaped paths"                                                                     | **Invert** — an outside read now succeeds                                                                 |
| `packages/tools/test/tool-runtime-filesystem.proc.test.ts:34` (`escapedRead`, `escapedGrep`, `symlinkCreate`, `symlinkEdit`, `escapedCwd`) | **Invert** all five; the `result.outside === "outside"` assertion at `:139` now expects the write to land |
| `packages/tools/test/media-view.test.ts:123`                                                                                               | **Invert** the `../escape` and `outside-link.png` cases; keep missing/directory/unsupported/oversized     |
| `packages/app/test/resolved-context.test.ts:233` "rejects reference symlinks that escape the workspace"                                    | **Invert** for explicit refs; add a case that automatic guidance discovery still stops at the Workspace   |
| `packages/tools/test/workspace-index.test.ts:20-21`                                                                                        | **Keep** — index scope is a query scope                                                                   |
| `packages/app/test/extension-operations.test.ts:170-178`                                                                                   | **Keep unchanged**                                                                                        |
| `apps/rika/test/prompt-parts.test.ts:242`                                                                                                  | **Invert** — outside symlinks now open                                                                    |

New: `local-path.test.ts`, `local-safety-policy.test.ts`, plus a
`tool-runtime` case proving a circuit-breaker denial is `recovery: "never"` and
never prompts.

## Docs to rewrite

| File                                            | Current line                                                            | New contract                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `docs/features/file-discovery-and-reading.md:5` | "Paths cannot escape the Workspace."                                    | Paths may point anywhere the user can read; casing is corrected when unambiguous; fuzzy fallback is Workspace-only |
| `docs/features/workspace-edits.md:5`            | "Outside-Workspace paths and edit paths containing symbolic links fail" | Edits may target any regular file; symlinks are followed; directories and devices are refused                      |
| `docs/features/shell-processes.md:5`            | "Working directories stay inside the Workspace."                        | Working directories may be anywhere; a hardcoded circuit breaker refuses a few catastrophic commands               |
| `docs/features/tool-permissions.md`             | five categories implied                                                 | only `shell` is a policy; the circuit breaker is hardcoded and non-overridable; **this is not a sandbox**          |
| `docs/features/media-inspection.md`             | containment                                                             | any readable media file; external media is sent to the analyzer                                                    |
| `docs/features/context-resolution.md`           | —                                                                       | explicit `@` refs anywhere; automatic guidance Workspace-only                                                      |
| `docs/features/configuration.md`                | —                                                                       | removed permission keys + migration warning                                                                        |

Add `docs/decisions/open-local-filesystem-posture.md`: the Workspace is a scope,
not a security boundary; containment was removed because it blocked ordinary
work; the circuit breaker is a mistake guard, not security; containers are the
real boundary. Add `docs/tradeoffs/circuit-breaker-over-sandbox.md`: gain
(friction-free local work), cost (a compromised or confused model can read
credentials and overwrite any user-writable file, and file contents leave the
machine to the model provider), rejected options (per-tool prompts, OS sandbox,
path allow-lists).

## Interaction with existing plans

- **001** (workspace settings can only tighten) — the categories it tightens are being deleted. Mark **REJECTED** with the rationale, or reduce it to `shell` alone.
- **002** (enforce all five categories) — directly contradicted. Mark **REJECTED**; D5 takes its documented fallback (delete the fake controls) as the primary path.
- **010** (workspace provider trust gate) — still valid and now _more_ important: automatic trust of workspace-local config is the remaining boundary. Keep TODO.
- **005** (typed error for the `realPath` defect at `:455`) — resolved incidentally; `canonicalWorkspace` disappears. Mark **DONE via 024**.
- **014** (tool failure recovery) — its "path casing and workspace-containment errors" failure class is largely removed; re-scope after this lands.

## Done criteria

- [ ] `bun run typecheck` exits 0; `bun run check` exits 0.
- [ ] `grep -rn "escapes workspace" packages apps` returns nothing.
- [ ] `grep -rn "Refusing to open a path outside the workspace" apps` returns nothing.
- [ ] A read, an edit, a write, a `view_media`, and a `bash` cwd all succeed against an absolute path outside the Workspace (proc test).
- [ ] A miscased path resolves for read, edit, and write on a case-sensitive filesystem; an ambiguous case fails.
- [ ] `rm -rf ~` and `rm -rf /` are refused with `recovery: "never"`; `echo 'rm -rf /'` and `rm -rf ./build` run.
- [ ] `packages/config` exposes only `permissions.shell`, and a config setting a removed key produces a migration warning.
- [ ] Skill-registry and extension-operations tests are unchanged and pass.
- [ ] Every doc row above is rewritten; the decision and tradeoff records exist.
- [ ] `plans/README.md` updated, including the 001/002/005 status changes.

## STOP conditions

- Removing `resolveContained` from `Grep` result mapping changes index behavior in a way the workspace-index tests do not cover — report rather than widening the index.
- The quote-aware lexer cannot distinguish `echo 'rm -rf /'` from `rm -rf /` without a dependency outside the allowed package set — report; do not fall back to substring regex.
- Deleting the four permission categories breaks a scene test that asserts on `doctor` or `config list` output in a way that suggests an undocumented consumer — report.
- Any step's verification fails twice after a reasonable fix attempt.
