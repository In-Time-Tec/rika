import { describe, expect, test } from "vitest"
import { serverProcessRole, serverProcessRuntime } from "../src/private-runtime-role"

describe("private server process role", () => {
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
