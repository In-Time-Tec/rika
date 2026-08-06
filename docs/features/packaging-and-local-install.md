# Packaging and local installation

`bun run package -- --target <target>` builds one self-contained, versioned archive for `darwin-arm64`, `linux-arm64`, or `linux-x64`. A target is always explicit and a build replaces only that target's output. After all three producers finish, `bun run package -- --aggregate` validates the exact archive set without rebuilding and writes the sole `SHA256SUMS` and `release-evidence.json` under `artifacts`.

Before an exact Baton catalog version is published, `bun run release-local -- --baton-release <directory>` validates a locally built Baton release payload, copies the current Rika worktree into an isolated consumer, replaces only its Baton catalog entries with the matching tarballs, and performs a clean install, Baton-dependent package typechecks, host package, and packaged release smoke. The proof rejects registry or sibling-worktree Baton resolution and never mutates the source worktree.

`bun run install-local` installs an existing host archive under `~/.local/share/rika/current` and links `~/.local/bin/rika`; `RIKA_PACKAGE_TARGET`, `RIKA_INSTALL_ROOT`, and `RIKA_BIN_DIR` override target or paths. Installation replaces a prior owned install but refuses to overwrite an unrelated command. `bun run uninstall-local` removes only the owned command and installed program, preserving Rika state and configuration.
