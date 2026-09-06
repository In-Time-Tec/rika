import { describe, expect, it } from "@effect/vitest"
import { Response } from "effect/unstable/ai"
import { completeTool, makeTool } from "../../../src/projection/tool/state"
import { TreeProjector } from "../../../src/projection/tree/projector"
import {
  block,
  modelResponse,
  resetEventPosition,
  toolResultPart,
  treeEvent,
} from "../../support/projector-event.fixture"

describe("native tool projection", () => {
  it("projects observed native tool lifecycle states", () => {
    const running = makeTool("public-tool", "raw-tool", "bash", JSON.stringify({ command: "true" }), undefined)
    expect(running.status).toBe("running")
    expect(completeTool(running, {}, false).status).toBe("complete")
    expect(completeTool(running, {}, true).status).toBe("failed")
    expect(completeTool(running, { status: "rejected" }, false).status).toBe("rejected")
    expect(completeTool(running, { status: "cancelled" }, false).status).toBe("cancelled")
    expect(completeTool({ operationId: "native-operation" }, false, "bash")(running)).toEqual(
      completeTool(running, { operationId: "native-operation" }, false, "bash"),
    )
  })

  it("does not invent an operation identity for either of two running tools", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-unknown-tool", "run")
    for (const id of ["first", "second"])
      projector.apply(
        treeEvent("raw-root-run", {
          _tag: "ToolExecutionStarted",
          turn: 0,
          call: Response.toolCallPart({
            id,
            name: "bash",
            params: { command: `echo ${id}` },
            providerExecuted: false,
            metadata: {},
          }),
        }),
      )
    const tools = () =>
      projector
        .snapshot()
        .units.filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "ToolCall")
    const before = tools()
    expect(before).toHaveLength(2)
    projector.apply(treeEvent("raw-root-run", { _tag: "OperationUnknown", operationId: "op-1" }))
    expect(tools()).toEqual(before)
    expect(projector.snapshot().state.status).toBe("waiting")
  })

  it("correlates background bash polls without guessing an unknown operation belongs to the check", () => {
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
    const declaration = modelResponse("raw-root-run", bashCall)
    const started = treeEvent("raw-root-run", {
      _tag: "ToolExecutionStarted",
      turn: 0,
      call: Response.toolCallPart(bashCall),
    })
    const completion = treeEvent("raw-root-run", {
      _tag: "ToolExecutionCompleted",
      turn: 0,
      call: Response.toolCallPart(bashCall),
      result: toolResultPart({
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
    })
    projector.apply(declaration)
    projector.apply(started)
    const background = projector.apply(completion)
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
    projector = TreeProjector.make("turn-process-correlation", "run in background")
    projector.applyAll([declaration, started, completion])
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
    expect(block(unknown, "ToolCall")).toBeUndefined()
    expect(unknown.state.status).toBe("waiting")
  })

  for (const { exitCode, declareCheck } of [
    { exitCode: 0, declareCheck: true },
    { exitCode: 7, declareCheck: true },
    { exitCode: 0, declareCheck: false },
  ]) {
    it(`keeps background completion stable through checks and replay (exit ${exitCode}, declared ${declareCheck})`, () => {
      resetEventPosition()
      const projector = TreeProjector.make("turn-background", "run")
      const bash = Response.toolCallPart({
        id: "bash",
        name: "bash",
        params: { command: "echo done", timeout_ms: 0 },
        providerExecuted: false,
        metadata: {},
      })
      const check = Response.toolCallPart({
        id: "check",
        name: "shell_command_status",
        params: { processId: "1", waitMillis: 10 },
        providerExecuted: false,
        metadata: {},
      })
      const complete = (
        call: typeof bash | typeof check,
        result: { running: boolean; processId: string; exitCode?: number; operationId: string },
      ) =>
        treeEvent("raw-root-run", {
          _tag: "ToolExecutionCompleted",
          turn: 0,
          call,
          result: toolResultPart({
            id: call.id,
            name: call.name,
            result,
            encodedResult: result,
            isFailure: false,
            providerExecuted: false,
            preliminary: false,
            metadata: {},
          }),
        })
      projector.apply(treeEvent("raw-root-run", { _tag: "ToolExecutionStarted", turn: 0, call: bash }))
      const running = complete(bash, {
        running: true,
        processId: "1",
        operationId: "operation-bash",
      })
      projector.apply(running)
      if (declareCheck) projector.apply(modelResponse("raw-root-run", check))
      projector.apply(
        complete(check, {
          running: false,
          processId: "1",
          exitCode,
          operationId: "operation-status-check",
        }),
      )
      const assertCompleted = () => {
        const tools = projector
          .snapshot()
          .units.flatMap((unit) =>
            unit.content._tag === "Block" && unit.content.block._tag === "ToolCall" ? [unit.content.block] : [],
          )
        expect(tools).toHaveLength(1)
        expect(tools[0]).toMatchObject({
          name: "bash",
          toolCallId: "bash",
          operationId: "operation-bash",
          status: exitCode === 0 ? "complete" : "failed",
          process: { running: false, exitCode },
        })
      }
      assertCompleted()
      // A repeated declaration or a new read of a retained terminal result must not restart the command.
      projector.apply(modelResponse("raw-root-run", check))
      assertCompleted()
      projector.apply(modelResponse("raw-root-run", { ...check, id: "check-again" }))
      assertCompleted()
      // Generalist can re-emit completed calls while resuming a batch.
      projector.apply(running)
      assertCompleted()
    })
  }

  it("labels a read by the lines it returned when the file ends before the requested range", () => {
    const input = JSON.stringify({ path: "README.md", read_range: [1, 80] })
    const running = makeTool("public-read", "raw-read", "read", input, undefined)
    expect(running.detail).toBe("README.md L1-80")
    const short = completeTool(running, { text: "1: ```\n2: art\n3: ```", truncated: false }, false)
    expect(short.detail).toBe("README.md L1-3")
    expect(completeTool(running, { text: "" }, false).detail).toBe("README.md L1-80")
    expect(completeTool(running, { status: "rejected" }, false).detail).toBe("README.md L1-80")
  })
})
