# Starting Environment

Captured: 2026-07-14T18:01:22Z

| Field | Value |
| --- | --- |
| Repository revision | `cdb91e54cb2f8b4022684652cecc93bd9a7f64b4` |
| Branch | `main` |
| Host | macOS 26.1 arm64 |
| Bun executable | `1.3.5` |
| Declared package manager | `bun@1.3.14` |
| Effect | `4.0.0-beta.93` |
| Baton core | `0.4.3` |
| Relay SDK installed variants | `0.2.14`, `0.2.15` |
| OpenTUI | `0.4.2` |
| Packaged archive SHA-256 | `ef1c659660e0a212f9d88c58e3b5fc3ab68c012404ce3a074eb8663061dff412` |
| Installed `rika` version | `0.0.0` |
| Pilotty | `0.0.11` through `bunx` |
| agent-tty | `0.5.0` through `bunx` |

## Starting dirty paths

These changes existed before the first stress run and must not be reverted or claimed by autoresearch:

```text
.github/workflows/ci.yml
.github/workflows/release-proof.yml
apps/rika/test/resident-transport.native.test.ts
package.json
packages/runtime/src/thread-host.ts
tsconfig.json
```

`TASK.md` contains the user-requested autoresearch mandate from the current thread.

## Environment findings

- `bun run upstream:status` failed because the command verifies sibling development links while the current install resolves registry packages. This does not show a broken registry install.
- Requiring `node_modules/@opentui/core/package.json` from the workspace root failed because Bun installed the package beneath its package store; the pinned installed package is `0.4.2`.
- The existing packaged archive and the installed `~/.local/bin/rika` have different SHA-256 digests. The stress baseline uses the extracted packaged archive, not the installed binary.
- Two pre-existing Pilotty sessions were active. Autoresearch did not stop or modify them.

## Continuation snapshot

Captured: 2026-07-14 after revision `a67703464bca934f51037f2978d74c8631b2c67c`

- The tracked worktree is clean at this revision. Existing untracked `.claude/`, `CLAUDE.md`, package guidance files, and `artifacts/autoresearch/` remain outside the autoresearch change set unless explicitly created by this loop.
- Direct submodules: Baton `faf22a572d56bf8bb172fd0b1ea582ffe5b3e137`, Effect `3a1128c7684e04d34d9f541f77adaac38a513056`, Relay `9c78e27400277403f3d285da7c296aea172093d9`.
- The registry install resolves Baton `0.4.3` and Relay `0.2.15`; `bun run upstream:status` still reports failure because that command currently verifies the optional sibling-link overlay rather than registry mode.
