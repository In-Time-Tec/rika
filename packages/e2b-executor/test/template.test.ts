import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

const read = (path: string) => Effect.promise(() => Bun.file(new URL(path, import.meta.url)).text())

describe("E2B template", () => {
  it.effect("starts the exported remote executor host without controller credentials", () =>
    Effect.gen(function* () {
      expect(yield* read("../../../infra/e2b/executor-v1/e2b.Dockerfile")).toContain(
        "COPY packages/remote-execution/src ./src",
      )
      const startup = yield* read("../../../infra/e2b/executor-v1/start.sh")
      expect(startup).toContain("export E2B_SANDBOX_ID")
      expect(startup).toContain("exec bun run /opt/rika/src/host.ts")
      expect(startup).not.toContain("executor-host.ts")
      expect(startup).not.toMatch(/postgres|database/i)
    }),
  )
})
