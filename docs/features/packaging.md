# Packaging

`bun run package -- --target <target>` builds one self-contained, versioned archive for `darwin-arm64`, `linux-arm64`, or `linux-x64`. A target is always explicit and a build replaces only that target's output. After all three producers finish, `bun run package -- --aggregate` validates the exact archive set without rebuilding and writes `SHA256SUMS` and `release-evidence.json` under `artifacts`.

A release archive contains exactly `INSTALL` and the native `bin/rika` application. The npm platform package has the same `bin` inventory. No private worker, secondary runtime, sidecar, preview, helper, or support file is shipped. The publish workflow extracts every archive, validates the exact inventory and native architectures, and checks the public binary's `--version` and `--help` surfaces in a clean process environment before publishing.
