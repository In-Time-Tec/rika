# Repository scripts

Use the root commands, not the implementation files:

| Task                                           | Command                             |
| ---------------------------------------------- | ----------------------------------- |
| Work on Rika locally                           | `bun run dev`                       |
| Deploy a personal Railway stack                | `bun run dev:remote`                |
| Destroy that personal stack                    | `bun run dev:remote:destroy`        |
| Build a native release archive                 | `bun run package --target <target>` |
| Assemble checksums, evidence, and npm packages | `bun run package --aggregate`       |

Targets: `darwin-arm64`, `linux-arm64`, `linux-x64`. Packaging writes to `artifacts/`; it does not publish.
Aggregation requires all three archives and assembles the npm packages from the same verified binaries.
The publish workflow owns publication: CI gate → three native builds → one assembly/publication job.
A dry run publishes neither npm packages nor a GitHub release.

## Development

`bun run dev` runs Alchemy directly. [`alchemy.run.ts`](../alchemy.run.ts) owns the service graph:
Docker PostgreSQL and MinIO → prepare services → migrate the database → start the API.
Alchemy also starts the web server and proxy.

These are internal helpers, not extra setup commands:

| File                                 | Why it exists                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `development/prepare.ts`             | Waits for PostgreSQL and MinIO, then creates the checkpoint bucket if missing.                                  |
| `development/api.ts`                 | Runs the API; when local Orb development is configured, verifies the E2B template and owns its executor tunnel. |
| `development/caddy.ts`               | Runs the local proxy and announces readiness only after checking this process's identity.                       |
| `development/secret-service.ts`      | Linux-only D-Bus/keyring service for Amp orbs, started by `.amp/services.yaml`. Not needed on macOS.            |
| `development/owned-child-process.ts` | Shared shutdown cleanup so interrupted helpers do not leave child processes running.                            |
| `development/railway.ts`             | Personal Railway deploy/destroy only. Guards the target and preserves state for retries.                        |

Railway commands create or delete live resources. See [setup](../README.md#personal-railway-stack) for credentials.
Never delete `.alchemy` while resources may remain; it holds the identity and cleanup state.

## Packaging

| File                            | Why it exists                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packaging/package-target.ts`   | Compiles one target, or aggregates release checksums and evidence.                                 |
| `packaging/npm-package.ts`      | Internal helper called by aggregation to assemble the npm launcher and platform packages.          |
| `packaging/package-contract.ts` | Shared target names and archive inventory used by builds, tests, and CI. Not an executable script. |

Scripts do not have automated tests. Validate changes with type-checking, linting, formatting, and an explicitly
requested run of the relevant command. Keep live deployment and publication checks opt-in.
