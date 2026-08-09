# Rika desktop fork (staging)

One-time fork of the upstream desktop application, taken on 2026-08-08 and owned by Rika from this point on. No upstream tracking, no sync script.

Rika is the product name used by desktop packaging and user-facing copy. OpenCode spellings that remain below are intentional technical contracts: `@opencode-ai/*` package names, `OPENCODE_*` environment variables, SDK/API/schema identifiers, upstream paths, and compatibility protocol or storage names must not be renamed as branding work.

- **Upstream repo:** github.com/anomalyco/opencode (fork of sst/opencode)
- **Upstream commit:** 284214c78d32a09fd9c729bdefc07be50f74eb40
- **Upstream HEAD:** 2026-08-07 feat(app): open project menu on right-click (#41013)

## What is staged here (source only)
- `desktop/` — the Electron shell (main/preload/renderer)
- `app/` — the SolidJS renderer (the UI we keep)
- `ui/` — shared UI components
- `session-ui/` — session components (diffs, review)
- `schema/` — retained data-model types (used as view-model types during the port)
- `core/src/util/` — ONLY the util subpaths the renderer imports (encode/path/binary/retry/array); no engine code
- `app/vendor/opencode-ai-client-1.17.13-v2.tgz` — vendored OpenCode client tarball (type contract only; runtime replaced by @rika/client)
- `sdk/` — the OpenCode v2 SDK client (app's server-client layer; replaced by @rika/client during the port)
- `script/` — build-tooling package (imported only by desktop/ui build scripts)

## Staging rules
- `package.json` files are STRIPPED so the staged code does NOT join the Rika workspace and cannot break `bun run check`. The next M3 phase adds package.json + workspace integration deliberately.
- MIT license notices preserved from upstream (see `LICENSE` files under each staged package; upstream is MIT — sst/opencode).
- Execution plan: `docs/m3-desktop-port-plan.md` (this repo).

## Step 2 status (workspace integration + baseline build) — DONE

- Original package.json manifests restored at package roots (from `.manifests/`);
  `sdk/js/package.json` restored from upstream; `core/package.json` is a minimal
  manifest (the app only imports `@opencode-ai/core/util/*` — zero-dep pure utils).
- Fork root `package.json`: private workspace (`rika-desktop-fork`) with the
  upstream catalog (nested in `workspaces.catalog`), bun@1.3.14, and
  `trustedDependencies` (electron + esbuild).
- The fork has its OWN `bun install` (own node_modules + bun.lock) and does NOT
  join Rika's workspace — Rika gates untouched (23/23, 1548 tests).
- The former `opencode/dist/node/node.js` stub and `virtual:opencode-server` path
  have been removed; the native Rika server now owns desktop lifecycle and
  transport. The upstream server bundle is not vendored.
- Baseline build: `cd desktop && bunx electron-vite build` — green in ~18s
  (main + preload + renderer bundles).
- Baseline launch: `bunx electron .` — window opens; Electron main starts the
  native Rika server through the publication/token contract, and the renderer
  connects through one authenticated Rika connection. Electron 42.3.3 binary installed via the cached package's install.js
  (bun does not run electron's postinstall by default).

## Phase A status (Rika transport proof) — DONE

The initial proof established browser-safe `@rika/client` connection and
interactive-feed support against a real Server. Its renderer-owned
`server.json`/token discovery was transitional and has now been deleted.

## Phase B status (native lifecycle and renderer adapter) — IN PROGRESS

- Electron main owns the Rika profile/data root, starts the built Rika Server
  through its fd-3 spawn contract, validates the canonical publication/token,
  and exposes only `{url, token, identity}` to the trusted renderer main frame.
- `GlobalProvider` owns one scoped physical Rika Connection. Cached directory
  runtimes own one `InteractiveSession` and one feed consumer per workspace.
- `app/src/rika/{projection,projection-events,adapter}.ts` translate revisioned
  Rika Thread Views into the retained view-store Message/Part/Permission
  shapes. Full Unit upserts replace complete Parts; gaps resync.
- `context/server-sdk.tsx` no longer constructs OpenCode clients or subscribes
  to OpenCode HTTP/SSE events. Its temporary local facade executes native Rika
  operations and rejects unsupported calls without a transport fallback.
- Question, Todo, revert/share/compact, auto-accept, terminal/PTY, old MCP,
  LSP, and provider-OAuth controls are cut from active session paths. Rika
  OpenRouter API-key login is exposed through native `Auth` operations.
- Projection/adapter and endpoint/IPC tests are focused under `app/src/rika`
  and `desktop/src/main`; the canonical Electron build is
  `cd desktop && bunx electron-vite build`.
