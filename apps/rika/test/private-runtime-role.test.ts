import { describe, expect, test } from "vitest"
import { isServerProcessRole, serverProcessRole, serverProcessRuntime } from "../src/private-runtime-role"

describe("private server process role", () => {
  test("accepts only the exact private argv", () => {
    expect(isServerProcessRole([serverProcessRole])).toBe(true)
    expect(isServerProcessRole([])).toBe(false)
    expect(isServerProcessRole([serverProcessRole, "run"])).toBe(false)
    expect(isServerProcessRole(["run", serverProcessRole])).toBe(false)
  })

  test("gives the normal client and interactive runtime the same public server launch", () => {
    const input = {
      executable: "/usr/bin/bun",
      packagedEntrypoint: "/install/bin/rika",
      sourceEntrypoint: "/repo/apps/rika/src/client-main.ts",
    }
    expect(serverProcessRuntime({ ...input, packaged: false })).toEqual({
      executable: "/usr/bin/bun",
      arguments: ["/repo/apps/rika/src/client-main.ts", serverProcessRole],
    })
    expect(serverProcessRuntime({ ...input, packaged: true })).toEqual({
      executable: "/install/bin/rika",
      arguments: [serverProcessRole],
    })
  })
})
