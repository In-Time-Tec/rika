import { describe, expect, test } from "vitest"
import { roleRuntimes } from "../src/performance-platform"

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
    expect(runtimes.server.arguments).toEqual(["/repo/apps/rika/src/server-main.ts"])
  })

  test("locates packaged role executables beside the performance executable", () => {
    const runtimes = roleRuntimes({
      packaged: true,
      executable: "/install/bin/.rika-performance",
      sourceDirectory: "/install/bin",
    })
    expect(runtimes.interactive.executable).toBe("/install/bin/.rika-interactive")
    expect(runtimes.server.executable).toBe("/install/bin/.rika-server")
    expect(runtimes.launcher.executable).toBe("/install/bin/rika")
    expect(runtimes.server.executable).not.toBe(runtimes.interactive.executable)
  })
})
