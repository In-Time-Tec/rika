# Packaging

`bun run package -- --target <target>` builds one self-contained, versioned archive for `darwin-arm64`, `linux-arm64`, or `linux-x64`. A target is always explicit and a build replaces only that target's output. After all three producers finish, `bun run package -- --aggregate` validates the exact archive set without rebuilding and writes the sole `SHA256SUMS` and `release-evidence.json` under `artifacts`.

A release archive contains exactly `INSTALL`, the native `bin/rika` client, and its private
`.rika-kernel-runtime` and `.rika-kernel-worker.js` files. The npm platform package has the same
`bin` inventory. `bin/rika` is the client runtime rather than a launcher for a second executable;
OpenTUI owns the first and every subsequent interactive frame. The client starts the private
kernel runtime only for kernel work. No startup preview, client sidecar, performance helper,
server sidecar, or text-result support file is shipped. The publish workflow extracts every
archive, validates the exact inventory and native architectures, and checks the public binary's
`--version` and `--help` surfaces in a clean process environment before publishing.
