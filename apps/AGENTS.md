# Apps

## Purpose

`apps/` contains end-user runtime applications that compose reusable packages. Apps own presentation, runtime entrypoints, and local development wiring; durable domain contracts stay in `packages/`.

## Subdirectories

| Directory | Purpose                                                           |
| --------- | ----------------------------------------------------------------- |
| `web/`    | Foldkit local web UI for shared thread sync. See `web/AGENTS.md`. |

## Current Standards

- Apps may depend on package entrypoints, but packages must not depend on apps.
- Keep browser state explicit and schema-backed when using Foldkit.
- Keep dev-only local infrastructure wiring in app config or scripts, not in shared packages.
- Do not commit generated app build output.

## Testing And Verification

- From the repository root, run `bun run typecheck`, `bun run test`, and `bun run build` after changing app code.
- App-local scripts may be run from the app directory for tighter loops.
