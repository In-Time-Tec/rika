# Packaging

`bun run package -- --target <target>` builds one self-contained, versioned archive for `darwin-arm64`, `linux-arm64`, or `linux-x64`. A target is always explicit and a build replaces only that target's output. After all three producers finish, `bun run package -- --aggregate` validates the exact archive set without rebuilding and writes the sole `SHA256SUMS` and `release-evidence.json` under `artifacts`.

A release archive contains exactly `INSTALL`, the native `bin/rika` launcher, and its private
`.rika-client-runtime`, `.rika-kernel-runtime`, and `.rika-kernel-worker.js` files. The npm
platform package has the same `bin` inventory. The launcher paints the synchronized startup
preview only for interactive terminal invocations, then replaces itself with the client runtime;
noninteractive commands receive no preview. The client still runs as one process and starts the
private kernel runtime only for kernel work. No performance helper, server sidecar, or text-result
support file is shipped. The publish workflow extracts every archive, validates the exact
inventory and native architectures, and checks the public binary's `--version` and `--help`
surfaces in a clean process environment before publishing.
