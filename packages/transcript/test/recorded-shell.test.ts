import { describe, expect, it } from "@effect/vitest"
import { recordedShellProjection, settleRecordedShellProjection, unitOrder } from "@rika/transcript/transcript-unit"

describe("recorded shell transcript projection", () => {
  it("projects a running shell turn as one intrinsic tool call without a user unit", () => {
    const projection = recordedShellProjection({ id: "turn-7", command: "printf '%s' hello", status: "running" })
    const key = "tool:turn-7:recorded-shell"

    expect(projection).toEqual({
      revision: 0,
      modelPhase: -1,
      units: [
        {
          key,
          turnId: "turn-7",
          order: unitOrder(key, 0),
          revision: 0,
          content: {
            _tag: "Block",
            block: {
              _tag: "ToolCall",
              id: "turn-7:recorded-shell",
              name: "bash",
              input: JSON.stringify({ command: "printf '%s' hello" }),
              status: "running",
              presentation: {
                family: "shell",
                action: "command",
                activeLabel: "Running",
                completeLabel: "Ran",
                outputDisplay: "inline",
              },
              detail: "printf '%s' hello",
              files: [],
            },
          },
        },
      ],
    })
    expect(projection.units.some((unit) => unit.content._tag === "Entry" && unit.content.role === "user")).toBe(false)
  })

  it.each([
    ["completed", "complete"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ] as const)("settles %s while preserving identity and order", (status, expectedStatus) => {
    const running = recordedShellProjection({ id: "turn-8", command: "exit 23", status: "running" })
    const settled = settleRecordedShellProjection(running, {
      id: "turn-8",
      command: "exit 23",
      status,
      result: { text: "terminal output", truncated: true, exitCode: 23 },
    })
    const runningUnit = running.units[0]!
    const settledUnit = settled.units[0]!

    expect(settled).toEqual({
      revision: 1,
      modelPhase: -1,
      units: [
        {
          key: runningUnit.key,
          turnId: "turn-8",
          order: runningUnit.order,
          revision: 1,
          content: {
            _tag: "Block",
            block: {
              _tag: "ToolCall",
              id: "turn-8:recorded-shell",
              name: "bash",
              input: JSON.stringify({ command: "exit 23" }),
              status: expectedStatus,
              presentation: {
                family: "shell",
                action: "command",
                activeLabel: "Running",
                completeLabel: "Ran",
                outputDisplay: "inline",
              },
              detail: "exit 23",
              output: "terminal output",
              process: { truncated: true, exitCode: 23 },
              files: [],
            },
          },
        },
      ],
    })
    expect(settledUnit.key).toBe(runningUnit.key)
    expect(settledUnit.order).toBe(runningUnit.order)
    expect(settledUnit).not.toHaveProperty("executionOutcome")
    expect(settled).not.toHaveProperty("oldestCursor")
    expect(settled).not.toHaveProperty("costUsd")
    expect(settled).not.toHaveProperty("usageCursors")
  })

  it("omits absent exit metadata", () => {
    const running = recordedShellProjection({ id: "turn-9", command: "echo ok", status: "running" })
    const settled = settleRecordedShellProjection(running, {
      id: "turn-9",
      command: "echo ok",
      status: "completed",
      result: { text: "ok\n", truncated: false },
    })

    expect(settled.units[0]).toMatchObject({
      content: { block: { process: { truncated: false } } },
    })
    expect(settled.units[0]?.content._tag === "Block" ? settled.units[0].content.block : {}).not.toHaveProperty(
      "process.exitCode",
    )
  })
})
