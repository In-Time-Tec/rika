import { describe, expect, it } from "@effect/vitest"
import { Tool } from "effect/unstable/ai"
import * as Bash from "@rika/coding-tools/bash-tool"
import * as ShellStatus from "@rika/coding-tools/shell-command-status-tool"

describe("process tool contracts", () => {
  it("bounds model-selected waits and describes background polling", () => {
    const bash = JSON.stringify(Tool.getJsonSchema(Bash.tool))
    expect(bash).toContain('"minimum":0')
    expect(bash).toContain('"maximum":60000')
    expect(bash).toContain("start in the background")
    const status = JSON.stringify(Tool.getJsonSchema(ShellStatus.tool))
    expect(status).toContain('"minimum":0')
    expect(status).toContain('"maximum":10000')
    expect(status).toContain("blind long wait")
    expect(status).toContain('"required":["processId"]')
  })
})
