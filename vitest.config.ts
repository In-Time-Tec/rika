import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
          exclude: ["**/*.native.test.ts"],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "native",
          include: ["packages/*/test/**/*.native.test.ts", "apps/*/test/**/*.native.test.ts"],
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "packaged",
          include: ["test/e2e/**/*.test.ts", "test/packaging/**/*.test.ts"],
          exclude: ["test/e2e/stress-*.test.ts", "test/packaging/stress-*.test.ts"],
          fileParallelism: false,
          globalSetup: ["test/package-setup.ts"],
          sequence: { groupOrder: 2 },
        },
      },
      {
        extends: true,
        test: {
          name: "stress",
          include: ["test/e2e/stress-*.test.ts", "test/packaging/stress-*.test.ts"],
          fileParallelism: false,
          globalSetup: ["test/package-setup.ts"],
          sequence: { groupOrder: 3 },
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
