# opencode desktop fork (staging)

One-time fork of the opencode desktop application, taken on 2026-08-08 and owned by Rika from this point on. No upstream tracking, no sync script.

- **Upstream repo:** github.com/anomalyco/opencode (fork of sst/opencode)
- **Upstream commit:** 284214c78d32a09fd9c729bdefc07be50f74eb40
- **Upstream HEAD:** 2026-08-07 feat(app): open project menu on right-click (#41013)

## What is staged here (source only)
- `desktop/` — the Electron shell (main/preload/renderer)
- `app/` — the SolidJS renderer (the UI we keep)
- `ui/` — shared UI components
- `session-ui/` — session components (diffs, review)
- `schema/` — opencode data-model types (used as view-model types during the port)
- `core/src/util/` — ONLY the util subpaths the renderer imports (encode/path/binary/retry/array); no engine code
- `app/vendor/opencode-ai-client-1.17.13-v2.tgz` — vendored client tarball (type contract only; runtime replaced by @rika/client)
- `sdk/` — the opencode v2 SDK client (app's server-client layer; replaced by @rika/client during the port)
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
  `trustedDependencies` (electron + node-pty + esbuild).
- The fork has its OWN `bun install` (own node_modules + bun.lock) and does NOT
  join Rika's workspace — Rika gates untouched (23/23, 1548 tests).
- `opencode/dist/node/node.js` is a STUB for `virtual:opencode-server` (the
  desktop main's sidecar imports `Server.listen`); opencode's server bundle is
  not vendored by design. The M3 port replaces this with Rika's server.
- Baseline build: `cd desktop && bunx electron-vite build` — green in ~18s
  (main + preload + renderer bundles).
- Baseline launch: `bunx electron .` — window opens; main + renderer + sidecar
  processes run; logs show "server ready" + the expected stub-era
  `global-sdk event stream failed` (that layer is exactly what the Rika port
  replaces). Electron 42.3.3 binary installed via the cached package's install.js
  (bun does not run electron's postinstall by default).

## Phase A status (Rika transport in the fork) — DONE

- `app/src/rika/` — `endpoint.ts` (server.json/token resolution + identity),
  `connection.ts` (`connectRika`: @rika/client connect, clientKind "desktop",
  WebCrypto-backed effect Crypto, WebSocket factory), `events.ts`
  (`runThreadFeed`: interactive session attach).
- `app/tsconfig.json` paths + `desktop/electron.vite.config.ts` renderer
  aliases map `@rika/client/*` and `@rika/product/*` into Rika's packages and
  unify `effect` on the Rika instance (4.0.0-beta.98; fork catalog bumped from
  beta.83). `effect/<sub>` subpaths resolve via a small resolveId plugin
  (vite cannot apply effect's `./*` exports wildcard; string aliases match
  prefixes, so the bare `effect` alias is a regex).
- Verification: `bun test app/src/rika/connection.test.ts` — 2/2 green
  (spawns the REAL Rika Server, connects with clientKind "desktop", pings).
  Renderer build green; desktop app launches.
- Test spawns `apps/server/dist/server-main.js` with an isolated HOME
  (settings-file decode requires a clean profile) and waits for server.json.
