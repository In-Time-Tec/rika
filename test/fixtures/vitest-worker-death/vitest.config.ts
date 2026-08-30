import rootConfigPromise from "../../../vitest.config"
import { defineConfig } from "vitest/config"

const rootConfig = await rootConfigPromise
const { projects: _projects, ...testConfig } = rootConfig.test ?? {}

export default defineConfig({
  ...rootConfig,
  test: {
    ...testConfig,
    include: ["test/fixtures/vitest-worker-death/*-test-worker.ts"],
    fileParallelism: false,
    pool: "forks",
  },
})
