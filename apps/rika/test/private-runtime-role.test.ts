import { describe, expect, test } from "vitest"
import {
  localExecutorProcessRole,
  serverProcessRole,
  serverProcessRuntime,
  tuiControllerProcessRole,
} from "../src/private-runtime-role"

describe("private server process role", () => {
  test("keeps the sibling client roles explicit", () => {
    expect(tuiControllerProcessRole).toBe("--internal-tui-controller")
    expect(localExecutorProcessRole).toBe("--internal-local-executor")
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
