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

## Staging rules
- `package.json` files are STRIPPED so the staged code does NOT join the Rika workspace and cannot break `bun run check`. The next M3 phase adds package.json + workspace integration deliberately.
- MIT license notices preserved from upstream (see `LICENSE` files under each staged package; upstream is MIT — sst/opencode).
- Execution plan: `docs/m3-desktop-port-plan.md` (this repo).
