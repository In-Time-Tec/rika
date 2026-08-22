import { describe, expect, test } from "vitest"
import { matchesRole, roleRuntimes } from "../src/platform/performance-platform"
import { runnerExecutorProcessRole, tuiControllerProcessRole } from "../src/private-runtime-role"

describe("performance role runtime resolution", () => {
  test("locates source role entrypoints from the performance source directory", () => {
    const runtimes = roleRuntimes({
      packaged: false,
      executable: "/usr/bin/bun",
      sourceDirectory: "/repo/apps/rika/src",
    })
    expect(runtimes.interactive).toEqual({
      executable: "/usr/bin/bun",
      arguments: ["/repo/apps/rika/src/interactive-main.ts"],
      evidencePath: "/repo/apps/rika/src/interactive-main.ts",
    })
    expect(runtimes["runner-executor"]).toEqual({
      executable: "/usr/bin/bun",
      arguments: ["/repo/apps/rika/src/client-main.ts", runnerExecutorProcessRole],
      evidencePath: "/repo/apps/rika/src/client-main.ts",
    })
  })

  test("locates packaged roles in the single launcher executable", () => {
    const runtimes = roleRuntimes({
      packaged: true,
      executable: "/install/bin/.rika-performance",
      sourceDirectory: "/install/bin",
    })
    expect(runtimes.interactive).toEqual({
      executable: "/install/bin/rika",
      arguments: [tuiControllerProcessRole],
      evidencePath: "/install/bin/rika",
    })
    expect(runtimes["runner-executor"]).toEqual({
      executable: "/install/bin/rika",
      arguments: [runnerExecutorProcessRole],
      evidencePath: "/install/bin/rika",
    })
    expect(runtimes.launcher.executable).toBe("/install/bin/rika")
  })

  test("detects hosted child roles separately from their launcher", () => {
    const runtimes = roleRuntimes({
      packaged: true,
      executable: "/install/bin/.rika-performance",
      sourceDirectory: "/install/bin",
    })
    expect(matchesRole({ command: "/install/bin/rika", runtime: runtimes.launcher })).toBe(true)
    expect(matchesRole({ command: `/install/bin/rika ${tuiControllerProcessRole}`, runtime: runtimes.launcher })).toBe(
      false,
    )
    expect(
      matchesRole({ command: `/install/bin/rika ${tuiControllerProcessRole}`, runtime: runtimes.interactive }),
    ).toBe(true)
    expect(matchesRole({ command: `/install/bin/rika ${runnerExecutorProcessRole}`, runtime: runtimes.launcher })).toBe(
      false,
    )
    expect(
      matchesRole({
        command: `/install/bin/rika ${runnerExecutorProcessRole}`,
        runtime: runtimes["runner-executor"],
      }),
    ).toBe(true)
    expect(matchesRole({ command: "/install/bin/rika", runtime: runtimes["runner-executor"] })).toBe(false)
  })
})
