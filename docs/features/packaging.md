# Packaging

`bun run package -- --target <target>` builds one self-contained, versioned archive for `darwin-arm64`, `linux-arm64`, or `linux-x64`. A target is always explicit and a build replaces only that target's output. After all three producers finish, `bun run package -- --aggregate` validates the exact archive set without rebuilding and writes the sole `SHA256SUMS` and `release-evidence.json` under `artifacts`.

A release archive contains exactly `INSTALL` and one executable, `bin/rika`. The npm platform package contains exactly `bin/rika` as well. No private `.rika-*` runtime, kernel worker, performance helper, server sidecar, or text-result support file is shipped. The client executable owns its complete runtime in one process. The publish workflow extracts every archive, validates that inventory, and checks the public binary's `--version` and `--help` surfaces in a clean process environment before publishing.
