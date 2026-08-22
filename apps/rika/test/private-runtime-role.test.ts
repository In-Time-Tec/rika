import { describe, expect, test } from "vitest"
import { localExecutorProcessRole, tuiControllerProcessRole } from "../src/private-runtime-role"

describe("private process roles", () => {
  test("keeps machine-bound client roles explicit", () => {
    expect(tuiControllerProcessRole).toBe("--internal-tui-controller")
    expect(localExecutorProcessRole).toBe("--internal-local-executor")
  })
})
