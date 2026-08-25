import { readFile } from "node:fs/promises"
import * as os from "node:os"
import { dirname, resolve } from "node:path"

/**
 * Half the machine's cores, bounded so a laptop gets real parallelism while a four-core CI
 * runner never oversubscribes into starvation timeouts on timing-sensitive tests.
 */
const laneWorkers = (cap: number) => Math.min(cap, Math.max(2, Math.ceil(os.cpus().length / 2)))
const tenetkit = process.env.RIKA_TENETKIT_WORKTREE
const tenetkitPackage = tenetkit === undefined ? undefined : resolve(tenetkit, "packages/tenetkit/dist")
const tenetkitAliases =
  tenetkitPackage === undefined
    ? []
    : [
        { find: /^tenetkit$/, replacement: resolve(tenetkitPackage, "index.js") },
        { find: /^tenetkit\/ai$/, replacement: resolve(tenetkitPackage, "ai/index.js") },
        { find: /^tenetkit\/harness$/, replacement: resolve(tenetkitPackage, "harness/index.js") },
        { find: /^tenetkit\/mcp$/, replacement: resolve(tenetkitPackage, "mcp/index.js") },
        { find: /^tenetkit\/repl$/, replacement: resolve(tenetkitPackage, "repl/index.js") },
        { find: /^tenetkit\/repl\/bun$/, replacement: resolve(tenetkitPackage, "repl/repl/bun.js") },
        { find: /^tenetkit\/runtime$/, replacement: resolve(tenetkitPackage, "runtime/index.js") },
        { find: /^tenetkit\/runtime\/driver$/, replacement: resolve(tenetkitPackage, "runtime/driver/index.js") },
        {
          find: /^tenetkit\/runtime\/driver\/sql\/codecs$/,
          replacement: resolve(tenetkitPackage, "runtime/sql/codecs.js"),
        },
        { find: /^tenetkit\/skills$/, replacement: resolve(tenetkitPackage, "skills/index.js") },
        { find: /^tenetkit\/test$/, replacement: resolve(tenetkitPackage, "test/index.js") },
        { find: /^@tenetkit\/pg$/, replacement: resolve(tenetkit, "packages/pg/dist/postgres/index.js") },
      ]
import { defineConfig } from "vitest/config"
import { CompletionReporter } from "./test/support/vitest-run-completeness-reporter"

export default defineConfig({
  resolve: {
    dedupe: ["effect"],
    alias: tenetkitAliases,
  },
  plugins: [
    {
      name: "prompt-text",
      enforce: "pre",
      resolveId(id, importer) {
        if (!id.endsWith(".prompt.txt")) return undefined
        return importer === undefined ? id : resolve(dirname(importer), id)
      },
      async load(id) {
        if (!id.endsWith(".prompt.txt")) return undefined
        return `export default ${JSON.stringify(await readFile(id, "utf8"))}`
      },
    },
  ],
  test: {
    reporters: ["default", new CompletionReporter()],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          testTimeout: 20_000,
          include: [
            "packages/*/src/**/*.test.ts",
            "packages/*/test/**/*.test.ts",
            "apps/*/src/**/*.test.ts",
            "apps/*/test/**/*.test.ts",
            "tooling/*/src/**/*.test.ts",
            "test/**/*.test.ts",
          ],
          exclude: ["**/*.native.test.ts", "**/*.journey.test.ts", "**/*.tui.test.ts", "**/*.proc.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "tui",
          include: ["apps/*/test/**/*.tui.test.ts"],
          passWithNoTests: true,
          fileParallelism: true,
          maxWorkers: laneWorkers(5),
          sequence: { groupOrder: 1 },
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: "proc",
          include: [
            "packages/*/test/**/*.proc.test.ts",
            "apps/*/test/**/*.proc.test.ts",
            "test/process/**/*.proc.test.ts",
            "test/release/**/*.proc.test.ts",
          ],
          fileParallelism: true,
          maxWorkers: laneWorkers(6),
          sequence: { groupOrder: 2 },
        },
      },
    ],
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      include: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: ["apps/*/src/main.ts", "**/node_modules/**", "**/dist/**"],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
})
