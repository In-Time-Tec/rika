import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Block, Presentation } from "../../src/schema/presentation"

describe("Presentation contract", () => {
  it("owns the durable tool presentation metadata", () => {
    expect(
      Schema.is(Presentation)({
        family: "direct",
        action: "status",
        activeLabel: "Waiting for",
        completeLabel: "Waited for",
        failedLabel: "Command wait failed",
        rowDisplay: "continuation",
        outputDisplay: "inline",
        counter: "thread",
      }),
    ).toBe(true)
    expect(
      Schema.is(Presentation)({
        family: "unsupported",
        action: "status",
        activeLabel: "Waiting for",
        completeLabel: "Waited for",
      }),
    ).toBe(false)
  })
})

describe("native projection blocks", () => {
  it("decodes unknown tools with durable process and check correlation", () => {
    const block = Schema.decodeSync(Block)({
      _tag: "ToolCall",
      id: "tool-public",
      name: "bash",
      input: "{}",
      status: "unknown",
      presentation: {
        family: "shell",
        action: "command",
        activeLabel: "Running",
        completeLabel: "Ran",
      },
      detail: "bun test",
      operationId: "operation-1",
      toolCallId: "bash-call",
      process: {
        processId: "process-1",
        command: "bun test",
        workdir: "packages/execution",
        background: true,
        elapsedMillis: 42,
        checks: [
          {
            toolCallId: "status-call",
            operationId: "operation-2",
            processId: "process-1",
            waitMillis: 10,
          },
        ],
      },
      files: [],
    })
    expect(block).toMatchObject({ status: "unknown", process: { checks: [{ toolCallId: "status-call" }] } })
  })

  it("decodes an ordered neutral child-group aggregate with mixed counts", () => {
    const block = Schema.decodeSync(Block)({
      _tag: "SubagentGroup",
      id: "group-1",
      name: "3 agents",
      status: "running",
      settled: false,
      memberIds: ["one", "two", "three"],
      counts: {
        total: 3,
        queued: 0,
        running: 1,
        waiting: 0,
        cancelling: 0,
        complete: 1,
        failed: 1,
        cancelled: 0,
      },
    })
    expect(block).toMatchObject({ memberIds: ["one", "two", "three"], counts: { complete: 1, failed: 1 } })
  })
})
