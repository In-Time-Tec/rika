import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

const read = (path: string) => Effect.promise(() => Bun.file(new URL(path, import.meta.url)).text())

describe("E2B template", () => {
  it.effect("starts the exported remote executor host without controller credentials", () =>
    Effect.gen(function* () {
      const dockerfile = yield* read("../../../infra/e2b/executor-v1/e2b.Dockerfile")
      expect(dockerfile).toContain("COPY packages ./packages")
      expect(dockerfile).toContain("install -d -m 0700 -o rika-executor -g rika-executor /var/lib/rika-executor")
      expect(dockerfile).toContain("Defaults:rika-executor env_reset")
      expect(dockerfile).toContain("usermod --append --groups rika-workspace rika-executor")
      expect(dockerfile).toContain("sudo -n -u rika-workspace -- test -w /home/rika-workspace/workspace")
      expect(dockerfile).toContain("RIKA_EXECUTOR_ASSIGNMENT_ID=template-readiness")
      expect(dockerfile).not.toMatch(/DATABASE_URL|E2B_API_KEY|BETTER_AUTH_SECRET/)
      const startup = yield* read("../../../infra/e2b/executor-v1/start.sh")
      expect(startup).toContain('E2B_SANDBOX_ID="$(cat /run/e2b/.E2B_SANDBOX_ID)"')
      expect(startup).toContain('E2B_SANDBOX_ID="template-readiness"')
      expect(startup.indexOf("/run/e2b/.E2B_SANDBOX_ID")).toBeLessThan(
        startup.indexOf('E2B_SANDBOX_ID="template-readiness"'),
      )
      expect(startup).toContain("export E2B_SANDBOX_ID")
      expect(startup).toContain("exec bun run /opt/rika/packages/remote-execution/src/host.ts")
      expect(startup).not.toContain("executor-host.ts")
      expect(startup).not.toMatch(/postgres|database/i)
      const host = yield* read("../../../packages/remote-execution/src/host.ts")
      expect(host).toContain('hostname: "0.0.0.0"')
      expect(host).toContain("decodeBootstrap(input)")
      expect(host).toContain("const capabilities = yield* liveCapabilities(workspaceUser)")
      expect(host).toContain('const ptyReady = config.fence.target === "e2b" && capabilities.pty')
      expect(host).toContain("capabilities: { ...capabilities, pty: ptyReady }")
      expect(host).toContain("const workspaceRoot = RemoteRepositoryRoot")
      expect(host).toContain("HostedKernel.make({")
      expect(host).toContain("KernelProfileRegistration.make({ ...kernelOptions")
      expect(host).toContain('trustMode: "trusted-local"')
    }),
  )
})
