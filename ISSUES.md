# Open issues

## A finished subagent kept its name on the activity line, once

A real session left `Running 1 subagent` on the line minutes after the turn that delegated had completed, while durable state was correct throughout. A later session on the packaged binary, delegating the same way with a live model, did not reproduce it: the card settled to its terminal label and the line returned to idle within seconds and stayed there.

So this is either fixed by something landed since, or it needs a condition the second run did not meet. `apps/rika/test/subagent-live-stream.tui.test.ts` holds the property either way and fails when a snapshot retains a stale activity, which is the shape the original observation had.

## The process harness serves one script to every profile

`RIKA_TEST_MODEL_SCRIPT` carries a single script, registered once, and the server resolves the real execution route, so every profile reaches the same steps and a spawned child never answers. The in-process harness supports one lane per profile because `baton-test-harness` rewrites each profile's registration identity in a route it builds for tests.

Closing this means giving the scripted model the same per-profile registration and applying those identities in the server when a test script is present. That places test-only routing in production composition, which is a real cost and the reason it has not been done for a presentation defect alone.

Dispatching on the incoming prompt instead was considered and rejected: a model request carries no profile, so the only discriminator is the instruction text, and coupling a harness to prompt wording breaks the moment anyone rewords an instruction.

## Ten size findings the policy still reports

`repository-policy` reports seven export counts, three dependency counts, and one file over their limits, each printed twice because the run repeats its message in the stack trace it raises. Every export count predates this migration except one that is genuinely shared across rendering modules; the counts this migration added are the Server's kernel and product composition, which name every binding module, store, and service the runtime is built from. A composition root has high fan-in by nature, and splitting one to satisfy a count moves the wiring somewhere it reads worse.

The policy has no exemption for a composition boundary, which is the honest gap: either it grows one, or those two files are counted like any other and stay reported. Both are decisions about the rule rather than the code, so neither was made here.

## A process that finishes quickly cannot be named again

Polling a process reaps it: `shell-process-registry.ts:179` drops the entry as soon as a poll observes an exit, and starting a process polls once to return its first output. A command that finishes in that window is therefore gone before the id it returned can be used, and `status` or `stop` naming it reports an unknown process. Verified against the packaged binary: `echo hi` cannot be watched, while `sleep 3; echo done` can be started, watched to completion, and reports its output.

Reaping on exit is deliberate and tested — `process-registry.test.ts:61` names it "retires completed ids" — and it is what keeps the registry from growing without bound. The tension is that a binding surface hands a cell an id whose lifetime it does not explain: `start` returns one, and whether it still means anything depends on how fast the command was. Either the id stays nameable until the caller that holds it has read the output once, or `start` says plainly that a finished command has already been reported and its id is spent.

Confirmed by the same runs: `stop` works. A `sleep 30` started and then stopped reports "Stopped process 1", so start, status, and stop do reach the same registry after all — an earlier note here claimed otherwise and was wrong.

## Workspace search needs a tool the product does not ship

`rika.workspace.search` shells out to ripgrep, which a machine that installed Rika has not necessarily installed. Under a bare `PATH` the call fails, and a live subagent asked to find a file worked around it with a shell `find` before reading the file directly — it recovered, but it spent turns doing so and told the user about it.

The kernel worker and its runtime ship with the product for exactly this reason. Search is the remaining binding that reaches for something outside the archive, so it either ships too, falls back to a search the product owns, or says plainly in its failure that ripgrep is missing rather than reporting a grep error.

## The workspace boundary is proved against a stand-in for path

`workspace-boundary.test.ts` builds its own `relative`, `resolve`, and `isAbsolute` rather than using the platform's. It proves the containment logic given those, which is a real property, but a difference between them and the real implementation would pass. The boundary itself is exercised for real by the interactive suite, so this is a gap in the unit proof rather than in the behaviour.

## A tool a server gains mid-cell is not reachable until the next one

The `rika.mcp` proxy reads a server's tool names once per kernel and keeps them, so a name it has not
seen is refused without asking. The binding behind it re-reads the server on every call and resolves
against the current list, so a tool that is renamed or withdrawn is caught by the server rather than
by the cache — the staleness only costs a tool the server has newly gained, and only until the cell
that cached the list is done.

## What a model is told is proved by running it, not by a unit test

`harnessSupplement` and `agentInstructionsWith` are each held by tests, but nothing unit-level holds the line that joins them: an agent's instructions live in its closure, and the manifest a configured route exposes carries tools and pins rather than prompt text. A test asserting the join by composing the two functions itself passes when the product stops composing them, which is the shape that let the harness stay disconnected through this whole migration.

The join is covered by running the packaged binary: a memory written in one turn appears four times in the next turn's prompt, and zero times with the wiring removed. That is a real proof and it is not a gate, so a regression here fails only when someone runs it.

## Rolling back anything but the newest refinement fails, and says the wrong thing

`harness.rollback` derives its proposal from the stored event, and the derivation pins `baseSnapshot` to the snapshot as it stood immediately after that refinement (`refinement.js:175`), then applies it against the current state. Verified against the packaged binary: create `m1`, update `m1`, then roll back the create, and the call fails with `entry already exists` — the inverse of a create is a delete, and it is being applied to a state where the entry has since been edited rather than to the one it was derived against.

So rollback is usable for the most recent refinement and nothing else, and the reason it gives describes the entry rather than the ordering. Either the derived proposal should not carry a historical baseline, or a non-latest rollback should say that plainly.

Worth noting for whoever fixes it: `rollback` is the one binding operation reaching `applyTrustedProposal` rather than `applyProposal`, which is correct — the inverse of a delete has to restore the original version and timestamps — and it is safe because the proposal is derived from a stored event rather than from cell input.

## The stream shows what a model did, not what it was told

`--stream-json` carries the projection: turns, tool calls, cell source, cell results. It never carries the system prompt. `available on rika`, which is in every agent's instructions, appears zero times in it.

That matters because a marker written by a cell appears in the stream anyway — echoed back inside the source of the turn that wrote it. Counting occurrences of a marker across two runs therefore proves nothing about the prompt, and reads as a convincing pass. The release-smoke round trip asserts on a value the second cell computed by reading the harness back, which is a claim the stream can actually support: a refinement one run stores is readable by the next.

The last hop, that the supplement reaches the model's instructions, is asserted in `baton-route.test.ts` by reading `resolverEntries[0].agent.instructions` — an agent carries its instructions as a readable property, so the composition is reachable after all. An earlier note here claimed it was not; that was wrong, and it was wrong because a first attempt recreated the composition rather than looking for it.

## A bounded refinement history costs a rollback

Refinement events are now capped at 200 per scope, because each one copies every entry it touched and retaining them all grows a scope by its own past. The prompt was never at risk: `HarnessOverview` already bounds what it reads to eight entries per kind.

The cost is that a refinement older than the bound can no longer be rolled back — its event is gone. That compounds with the rollback limitation above, where only the newest refinement can be undone in practice, so the reachable window is already far smaller than 200.

Entry counts are deliberately left unbounded. Capacity is checked against the entries a proposal would leave behind, so binding it would start refusing a model's writes once a scope filled up, which is a worse failure than a large file.

## Artifacts are shared across sessions on purpose, and now fail loudly on a collision

Every Session on a machine reads and writes one `<dataRoot>/artifacts` directory, and an id is a 64-bit hash of the encoded content. That is content addressing: the same value stored twice yields one id and one file, which is deduplication rather than a defect. The directory is `0o700` and each file `0o600`, so another user cannot read them.

Reading another session's artifact requires guessing a 64-bit id derived from content you would have to already know, so the guessability concern is weak. The real hazard was that two different values hashing alike would silently overwrite, and a later read would return a value its own id did not describe. A put that finds a different value already under its id now fails instead.

What remains open is per-session isolation. It is a real boundary and not a small change, and nothing about the current layout makes one session's artifacts discoverable by another.

## The TUI worker dies partway through a file, and the reporter says nothing

Running `subagent-live-stream.tui.test.ts` as a whole file exits 1 with five of eight lanes reported passed, no failures, and `Worker exited unexpectedly`. `app.tui.test.ts` behaves the same at six of fourteen. The default reporter prints no summary line at all in this state, so the run reads as a pass unless the exit code is checked; `--reporter=json` gives truthful counts.

The lane it dies in is the largest one, and it dies after its renderer starts and before teardown. It passes alone, four times out of four. With its five predecessors it fails three times out of three, and with one or two predecessors it is intermittent, so the earlier lanes push something over a threshold rather than any pair being wrong together.

Ruled out: renderer height, transcript volume, JS heap size, pool isolation, leaked kernel worker processes, a native crash, the OpenTUI test renderer itself, and the kernel pool's scope.

Eight identical lanes in a scratch file measure the residue directly, and it scales with what a lane does rather than how large it is. A lane that builds the app and quits leaves about five megabytes behind, a lane that runs one turn leaves about thirty, and a lane whose turn spawns a child leaves about fifty-five and kills the worker on the eighth.

A heap snapshot taken after a forced collection at the second and sixth of those lanes settles where it is not: the JavaScript heap shrank by twenty-seven megabytes while resident memory grew by three hundred, and the largest single class differed by a third of a megabyte. Nothing is retained in JavaScript, so the growth is native — SQLite pages, terminal buffers, process resources, or memory an allocator never returns. The SQLite repositories and the renderer are both already released with the lane's scope.

Worth stating plainly: the shipped product runs one session per process, while this suite builds up to fourteen complete product stacks inside one worker. Per-lane runs pass, which is how this was previously recorded as a green gate; it is not one.

The product carries a smaller version of it. A real interactive session holding one thread grows steadily: server RSS across twelve turns runs 305, 547, 572, 597, 628, 653, 677, 713, 747, 762, 774, 790 MiB. The first step is lazy initialisation, and everything after it is a steady twenty-five megabytes a turn that has not flattened by the twelfth.

An earlier measurement here claimed a plateau. It was taken with repeated `rika run` invocations, which are fresh clients against a Server that has already warmed, so the thing that grows was never held across the turns being counted. The interactive gate holds one session, which is the shape a user has.
