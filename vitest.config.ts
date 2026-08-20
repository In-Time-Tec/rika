import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { defineConfig } from "vitest/config"
import { CompletionReporter } from "./test/support/vitest-run-completeness-reporter"

export default defineConfig({
  resolve: {
    dedupe: ["effect"],
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
          fileParallelism: false,
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
          ],
          fileParallelism: false,
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
