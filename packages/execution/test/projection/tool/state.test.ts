import { describe, expect, it } from "@effect/vitest"
import { Response } from "generalist"
import { completeTool, makeTool } from "../../../src/projection/tool/state"
import { TreeProjector } from "../../../src/projection/tree/projector"
import { block, modelResponse, resetEventPosition, treeEvent } from "../../support/projector-event.fixture"

describe("native tool projection", () => {
  it("projects all six durable native tool lifecycle states", () => {
    const running = makeTool("public-tool", "raw-tool", "bash", JSON.stringify({ command: "true" }), undefined)
    expect(running.status).toBe("running")
    expect(completeTool(running, {}, false).status).toBe("complete")
    expect(completeTool(running, {}, true).status).toBe("failed")
    expect(completeTool(running, { status: "rejected" }, false).status).toBe("rejected")
    expect(completeTool(running, { status: "cancelled" }, false).status).toBe("cancelled")

    const projector = TreeProjector.make("turn-unknown-tool", "run")
    const call = {
      type: "tool-call" as const,
      id: "unknown-call",
      name: "bash",
      params: { command: "do-something" },
      providerExecuted: false,
      metadata: {},
    }
    projector.apply(modelResponse("raw-root-run", call))
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionStarted",
        turn: 0,
        call: Response.toolCallPart(call),
      }),
    )
    expect(
      block(projector.apply(treeEvent("raw-root-run", { _tag: "OperationUnknown", operationId: "op-1" })), "ToolCall"),
    ).toMatchObject({ _tag: "Block", block: { status: "unknown", operationId: "op-1" } })
  })

  it("correlates background bash polls and settles the active check as unknown", () => {
    resetEventPosition()
    let projector = TreeProjector.make("turn-process-correlation", "run in background")
    const bashCall = {
      type: "tool-call" as const,
      id: "bash-background",
      name: "bash",
      params: { command: "bun test", workdir: "packages/execution", timeout_ms: 0 },
      providerExecuted: false,
      metadata: {},
    }
    projector.apply(modelResponse("raw-root-run", bashCall))
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionStarted",
        turn: 0,
        call: Response.toolCallPart(bashCall),
      }),
    )
    const background = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionCompleted",
        turn: 0,
        call: Response.toolCallPart(bashCall),
        result: Response.toolResultPart({
          id: bashCall.id,
          name: bashCall.name,
          isFailure: false,
          result: {
            running: true,
            processId: "process-1",
            elapsedMillis: 25,
            stdout: "started",
            stderr: "",
            truncated: false,
          },
          encodedResult: {},
          providerExecuted: false,
          preliminary: false,
          metadata: {},
        }),
      }),
    )
    expect(block(background, "ToolCall")).toMatchObject({
      _tag: "Block",
      block: {
        name: "bash",
        toolCallId: "bash-background",
        status: "running",
        process: {
          processId: "process-1",
          command: "bun test",
          workdir: "packages/execution",
          background: true,
          elapsedMillis: 25,
        },
      },
    })
    projector = TreeProjector.make(
      "turn-process-correlation",
      "run in background",
      background.checkpoint,
      projector.snapshot().units,
    )

    const statusCall = {
      type: "tool-call" as const,
      id: "status-check",
      name: "shell_command_status",
      params: { processId: "process-1", waitMillis: 10 },
      providerExecuted: false,
      metadata: {},
    }
    const declared = projector.apply(modelResponse("raw-root-run", statusCall))
    expect(declared.upsert).toHaveLength(1)
    expect(block(declared, "ToolCall")).toMatchObject({
      _tag: "Block",
      block: {
        name: "bash",
        toolCallId: "bash-background",
        process: {
          processId: "process-1",
          checks: [{ toolCallId: "status-check", processId: "process-1", waitMillis: 10 }],
        },
      },
    })
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionStarted",
        turn: 0,
        call: Response.toolCallPart(statusCall),
      }),
    )
    const unknown = projector.apply(
      treeEvent("raw-root-run", { _tag: "OperationUnknown", operationId: "operation-status" }),
    )
    expect(block(unknown, "ToolCall")).toMatchObject({
      _tag: "Block",
      block: {
        name: "bash",
        status: "unknown",
        process: { checks: [{ toolCallId: "status-check", operationId: "operation-status" }] },
      },
    })
  })
})
