import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          setupFiles: ["test/unit/setup-relay-polling.ts"],
          include: [
            "packages/*/test/**/*.test.ts",
            "apps/*/test/**/*.test.ts",
            "scripts/test/**/*.test.ts",
            "test/**/*.test.ts",
          ],
          exclude: [
            "**/*.native.test.ts",
            "**/*.journey.test.ts",
            "**/*.tui.test.ts",
            "**/*.proc.test.ts",
            "test/live/**",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "tui",
          setupFiles: ["test/unit/setup-relay-polling.ts"],
          include: ["apps/*/test/**/*.tui.test.ts"],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "proc",
          setupFiles: ["test/unit/setup-relay-polling.ts"],
          include: ["packages/*/test/**/*.proc.test.ts", "apps/*/test/**/*.proc.test.ts"],
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
