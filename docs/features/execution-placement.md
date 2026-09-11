# Runner and Orb execution

Every Thread has one immutable Execution Target chosen at creation: **Runner** or **Orb**. Placement never moves
implicitly, and an Orb never silently becomes a Runner.

## Runner

A Runner is a registered user-controlled process executing assigned Threads in an approved local checkout.

- `rika --workspace "$PWD"` opens the TUI and creates a Runner Thread by default; the same process registers that
  checkout as its Runner.
- `rika --no-tui --workspace "$PWD" --allow-remote-thread-creation` keeps the checkout available for remotely
  created Runner Threads; `--deny-remote-thread-creation` forbids that explicitly.
- Runner enrollment is per-Thread over a WebSocket upgrade at `/api/v2/threads/:threadId/executor` on the deployed
  API. Runner work is not isolated from the developer's machine.

## Orb

An Orb is a Rika-managed remote Executor in a Box machine and snapshot lineage, created only for a Thread that
explicitly targets an Orb.

- Choose `new in Orb` from the TUI command palette, or run `rika thread new`; the CLI command creates an Orb
  Thread from the current workspace seed and prints its ID.
- An Orb is prepared only after its first prompt. Preparation provisions a Box from the pinned template
  (`RIKA_BOX_TEMPLATE_BOX_ID`/`RIKA_BOX_TEMPLATE_SNAPSHOT_ID`), applies the staged workspace input, and completes
  one narrowed enrollment before the workspace is usable.
- Box executors enroll over `/api/v2/boxes/:boxId/executor`. The Box lifecycle — create, fork, resume, stop,
  snapshot — is owned by `packages/box-executor` behind Generalist durable operations; the API never contacts Box
  outside an accepted durable lifecycle intent.

## Seeds and repository inputs

Creating an Orb preserves the local workspace instead of discarding it. The CLI stages an archive through
`POST /api/v2/workspace-seeds` (or captures an authorized pinned repository checkout) before the Thread is
created, and Orb preparation restores exactly that staged input into the remote workspace. `packages/workspace-input`
owns the archive, seed vault, and repository-input authority; seed bytes are encrypted under the API-held
`RIKA_WORKSPACE_INPUT_KEY` and stored through the configured runtime object store. A Thread whose seed staging
failed is not created.
