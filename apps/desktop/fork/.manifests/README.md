# M3 Step 2 — dependency manifest capture

Original package.json manifests from the opencode fork (upstream commit 284214c78d),
captured so Step 2 can restore exact dependency versions.

- `<pkg>.package.json` — original manifest for each staged package
- `opencode-root.package.json` — opencode root manifest (workspace config, catalog,
  engines) for dependency-resolution reference

Toolchain notes (from upstream):
- The renderer (app) builds with Vite + vite-plugin-solid; the desktop shell with
  electron-vite; UI packages use Tailwind CSS v4.
- The app depends on the vendored tarball `app/vendor/opencode-ai-client-1.17.13-v2.tgz`
  (staged) and on `@opencode-ai/sdk` (staged), `@opencode-ai/schema` (staged),
  `@opencode-ai/core` util subpaths only (staged), `@opencode-ai/ui`, `@opencode-ai/session-ui`
  (staged), plus external: solid-js, @pierre/trees, @pierre/diffs, ghostty-web, shiki, marked.
- Dependency resolution strategy for Step 2 (RECOMMENDED): a self-contained install for the
  fork (its own node_modules under apps/desktop/fork) rather than merging into Rika's
  workspace, so the fork's toolchain cannot affect Rika's gates. Reintroduce
  package.json at the package roots ONLY at that point, and keep the repo-gate exclusions
  (370b956b) until the port makes the code Rika-native.

## Known Step-2 build blocker (verified in the staged fork)

`desktop/electron.vite.config.ts` resolves `virtual:opencode-server` to
`../opencode/dist/node` (opencode's server bundle — deliberately NOT staged).
The baseline Electron build therefore needs a STUB for that virtual module
(e.g., a minimal `Server.listen`-shaped no-op or a Rika-server adapter) before
the main-process bundle will build. Plan for this in Step 2.
