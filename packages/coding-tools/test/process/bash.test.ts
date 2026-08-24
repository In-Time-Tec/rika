import { describe, expect, it } from "@effect/vitest"
import { Tool } from "effect/unstable/ai"
import * as Bash from "@rika/coding-tools/bash-tool"
import * as ShellStatus from "@rika/coding-tools/shell-command-status-tool"

describe("process tool contracts", () => {
  it("bounds model-selected waits and describes background polling", () => {
    expect(Tool.getJsonSchema(Bash.tool)).toMatchObject({
      properties: {
        timeout_ms: {
          type: "integer",
          minimum: 0,
          maximum: 60_000,
          description: expect.stringContaining("start in the background"),
        },
      },
    })
    expect(Tool.getJsonSchema(ShellStatus.tool)).toMatchObject({
      properties: {
        waitMillis: {
          anyOf: [
            {
              type: "integer",
              minimum: 0,
              maximum: 10_000,
              description: expect.stringContaining("blind long wait"),
            },
            { type: "null" },
          ],
        },
      },
      required: ["processId"],
    })
  })
})
