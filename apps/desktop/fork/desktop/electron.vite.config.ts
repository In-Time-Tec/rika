import { sentryVitePlugin } from "@sentry/vite-plugin"
import * as path from "node:path"
import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import * as fs from "node:fs/promises"

const OPENCODE_SERVER_DIST = "../opencode/dist/node"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
        // Keep this identical to electron-vite's Node 20.11+ shim. Its regex insertion can
        // corrupt bundled TypeScript, while a Rollup banner places the shim safely.
        output: {
          banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
        },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:opencode-server") return this.resolve(`${OPENCODE_SERVER_DIST}/node.js`)
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${OPENCODE_SERVER_DIST}/${l}`))
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: [
        { find: /^effect$/, replacement: path.resolve(__dirname, "../../../../node_modules/effect") },
        { find: "@rika/client/connection", replacement: path.resolve(__dirname, "../../../../packages/client/src/connection.ts") },
        { find: "@rika/client/session", replacement: path.resolve(__dirname, "../../../../packages/client/src/session.ts") },
        { find: "@rika/client/feed", replacement: path.resolve(__dirname, "../../../../packages/client/src/feed.ts") },
        { find: "@rika/client/reconnect", replacement: path.resolve(__dirname, "../../../../packages/client/src/reconnect.ts") },
        { find: "@rika/client/sha256", replacement: path.resolve(__dirname, "../../../../packages/client/src/sha256.ts") },
        { find: "@rika/config/behavior-mode", replacement: path.resolve(__dirname, "../../../../packages/config/src/model-routing/behavior-mode.ts") },
        { find: "@rika/product/execution-request", replacement: path.resolve(__dirname, "../../../../packages/product/src/execution/contract/execution-request.ts") },
        { find: "@rika/product/interactive-command", replacement: path.resolve(__dirname, "../../../../packages/product/src/operation/interactive/interactive-command.ts") },
        { find: "@rika/product/interactive-event", replacement: path.resolve(__dirname, "../../../../packages/product/src/operation/interactive/interactive-event.ts") },
        { find: "@rika/product/interactive-session", replacement: path.resolve(__dirname, "../../../../packages/product/src/operation/interactive/interactive-session.ts") },
        { find: "@rika/product/product-operation", replacement: path.resolve(__dirname, "../../../../packages/product/src/operation/contract/product-operation.ts") },
        { find: "@rika/product/server-interactive-feed", replacement: path.resolve(__dirname, "../../../../packages/product/src/server/server-interactive-feed.ts") },
        { find: "@rika/product/server-service", replacement: path.resolve(__dirname, "../../../../packages/product/src/server/server-service.ts") },
        { find: "@rika/product/server-service-handshake", replacement: path.resolve(__dirname, "../../../../packages/product/src/server/server-service-handshake.ts") },
        { find: "@rika/product/server-service-sha256", replacement: path.resolve(__dirname, "../../../../packages/product/src/server/server-service-sha256.ts") },
        { find: "@rika/product/server-service-sha256-bun", replacement: path.resolve(__dirname, "../../../../packages/product/src/server/server-service-sha256-bun.ts") },
        { find: "@rika/product/server-service-sha256-node", replacement: path.resolve(__dirname, "../../../../packages/product/src/server/server-service-sha256-node.ts") },
        { find: "@rika/product/server-service-sha256-web", replacement: path.resolve(__dirname, "../../../../packages/product/src/server/server-service-sha256-web.ts") },
        { find: "@rika/product/thread-record", replacement: path.resolve(__dirname, "../../../../packages/product/src/thread/model/thread-record.ts") },
        { find: "@rika/product/thread-summary", replacement: path.resolve(__dirname, "../../../../packages/product/src/thread/model/thread-summary.ts") },
        { find: "@rika/product/thread-view", replacement: path.resolve(__dirname, "../../../../packages/product/src/thread/model/thread-view.ts") },
        { find: "@rika/product/turn-record", replacement: path.resolve(__dirname, "../../../../packages/product/src/thread/model/turn-record.ts") },
      ],
    },
    plugins: [
      {
        name: "rika:effect-subpaths",
        resolveId(source) {
          if (source.startsWith("effect/")) {
            const target = path.resolve(
              __dirname,
              `../../../../node_modules/effect/dist/${source.slice("effect/".length)}.js`,
            )
            return target
          }
        },
      },
      appPlugin,
      sentry,
    ],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
})
