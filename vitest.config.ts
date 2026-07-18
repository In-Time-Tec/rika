import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "packages/*/test/**/*.test.ts",
            "apps/*/test/**/*.test.ts",
            "scripts/test/**/*.test.ts",
            "test/**/*.test.ts",
          ],
          exclude: ["**/*.scene.test.ts", "**/*.journey.test.ts", "**/*.stress.journey.test.ts", "**/scene.test.ts"],
          maxWorkers: 2,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "scene",
          include: ["packages/*/test/**/*.scene.test.ts", "apps/*/test/**/*.scene.test.ts", "**/scene.test.ts"],
          exclude: ["repos/**"],
          fileParallelism: false,
          testTimeout: 40_000,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "journey",
          include: ["test/journey/**/*.journey.test.ts"],
          exclude: ["test/journey/**/*.stress.journey.test.ts"],
          fileParallelism: false,
          globalSetup: ["test/journey/setup-packaged-product.ts"],
          sequence: { groupOrder: 2 },
        },
      },
      {
        extends: true,
        test: {
          name: "stress",
          include: ["test/journey/**/*.stress.journey.test.ts"],
          fileParallelism: false,
          globalSetup: ["test/journey/setup-packaged-product.ts"],
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
