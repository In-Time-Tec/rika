# Open issues

## A finished subagent keeps its name on the activity line

A real session left `Running 1 subagent` on the activity line minutes after the turn that delegated had completed. Durable state was correct throughout: every turn `completed`, the `SubagentCard` read `complete`, and all Baton runs succeeded. The projection also tracked the child correctly _while_ it ran. Only the live client's own model kept a card in a running status.

Not reproduced by any harness. The in-process suite clears the line in both the single-turn and second-turn shapes, so `terminal-overlay-reducer`'s guard on a matching active turn is not the mechanism — that hypothesis was tested and refuted. `apps/rika/test/subagent-live-stream.tui.test.ts` now holds the property a reader depends on and fails when a snapshot retains a stale activity.

Reproducing it needs the real client with a child that answers, which the process harness cannot script today. See the note below.

## The process harness serves one script to every profile

`RIKA_TEST_MODEL_SCRIPT` carries a single script, registered once, and the server resolves the real execution route, so every profile reaches the same steps and a spawned child never answers. The in-process harness supports one lane per profile because `baton-test-harness` rewrites each profile's registration identity in a route it builds for tests.

Closing this means giving the scripted model the same per-profile registration and applying those identities in the server when a test script is present. That places test-only routing in production composition, which is a real cost and the reason it has not been done for a presentation defect alone.

Dispatching on the incoming prompt instead was considered and rejected: a model request carries no profile, so the only discriminator is the instruction text, and coupling a harness to prompt wording breaks the moment anyone rewords an instruction.

## Ten size findings the policy still reports

`repository-policy` reports seven export counts, three dependency counts, and one file over their limits, each printed twice because the run repeats its message in the stack trace it raises. Every export count predates this migration except one that is genuinely shared across rendering modules; the counts this migration added are the Server's kernel and product composition, which name every binding module, store, and service the runtime is built from. A composition root has high fan-in by nature, and splitting one to satisfy a count moves the wiring somewhere it reads worse.

The policy has no exemption for a composition boundary, which is the honest gap: either it grows one, or those two files are counted like any other and stay reported. Both are decisions about the rule rather than the code, so neither was made here.

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
