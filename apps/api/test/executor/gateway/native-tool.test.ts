import { expect, it } from "@effect/vitest"
import * as NativeToolRuntime from "@rika/product/native-tool-runtime"
import { RunnerMessage, type AccessWire, type MachineOutcome } from "@rika/remote-execution/protocol"
import { Deferred, Effect, Schema } from "effect"
import { GatewayError, type ExecutionResult, type LifecycleStore } from "../../../src/executor/gateway"
import { machineTerminal, runNativeTool } from "../../../src/executor/gateway/native-tool"
import type { PendingOperation } from "../../../src/executor/gateway/rpc/model"

const decodeRunnerMessage = Schema.decodeUnknownSync(Schema.fromJsonString(RunnerMessage))
const encodeRunnerMessage = Schema.encodeSync(Schema.fromJsonString(RunnerMessage))

const access: AccessWire = {
  version: 1,
  leaseEpoch: 1,
  sessionToken: "a".repeat(64),
  fence: {
    target: "runner",
    assignmentId: "assignment",
    assignmentGeneration: 1,
    instanceId: "instance",
    executorId: "executor",
    processIncarnation: "incarnation",
  },
}

const editFailure = NativeToolRuntime.ToolError.make({
  tool: "edit",
  message: "edit could not find old_str in README.md. The call did not change state.",
  kind: "operation",
  category: "operation",
  outcome: "known",
  recovery: "after_change",
  nextAction: "Read the file and retry with the exact text",
})

/** A Runner reports a failed tool through the wire, so the API sees the decoded `ToolError` class instance. */
const receivedFailure = (): MachineOutcome => {
  const message = decodeRunnerMessage(
    encodeRunnerMessage({
      _tag: "MachineResult",
      access,
      operationKey: "run:tool:0:call:edit",
      attempt: 1,
      machineId: "b".repeat(64),
      requestDigest: "c".repeat(64),
      outcome: { _tag: "Failure", failure: editFailure },
    }),
  )
  if (message._tag !== "MachineResult") throw new Error("expected a MachineResult")
  return message.outcome
}

it("records a Runner tool failure received over the wire as a failed domain result", () => {
  const terminal = machineTerminal(receivedFailure())
  expect(terminal.outcome).toBe("failed")
  expect(terminal.response).toEqual({
    _tag: "DomainFailure",
    failure: {
      _tag: "ToolError",
      tool: "edit",
      message: editFailure.message,
      kind: "operation",
      category: "operation",
      outcome: "known",
      recovery: "after_change",
      nextAction: editFailure.nextAction,
    },
  })
})

const pendingOperation = (result: Deferred.Deferred<ExecutionResult, GatewayError>): PendingOperation => {
  const request = {
    assignmentId: "assignment",
    operationKey: "run:tool:0:call:edit",
    workspaceId: "workspace",
    sessionId: "session",
    threadId: "thread",
    turnId: "turn",
    runId: "run",
    rootRunId: "run",
    toolCallId: "call",
    code: "edit",
    attempt: 1,
    replayPolicy: "provider-idempotent" as const,
    machineRequest: {
      _tag: "NativeTool" as const,
      request: { _tag: "Edit" as const, path: "README.md", oldStr: "old", newStr: "new" },
    },
    admittedAt: "2026-09-02T18:17:44.000Z",
    deadlineAt: "2026-09-02T18:18:14.000Z",
  }
  return {
    assignmentId: request.assignmentId,
    operationKey: request.operationKey,
    attempt: request.attempt,
    request,
    socket: { send: () => undefined, close: () => undefined },
    access,
    result,
    waiters: 1,
  }
}

const lifecycle = (append: LifecycleStore["append"]): LifecycleStore => ({
  append,
  load: () => Effect.succeed([]),
  prepare: () => Effect.die("unused"),
  inspect: () => Effect.die("unused"),
  cancel: () => Effect.die("unused"),
  dispatch: () => Effect.die("unused"),
})

it.effect("settles the pending operation with the tool failure returned by the Runner", () =>
  Effect.gen(function* () {
    const result = yield* Deferred.make<ExecutionResult, GatewayError>()
    yield* runNativeTool({
      operation: pendingOperation(result),
      lifecycle: lifecycle(() => Effect.succeed({ _tag: "Appended" })),
      machineIdFor: () => Effect.succeed("b".repeat(64)),
      invoke: () => Effect.succeed(receivedFailure()),
    })
    const settled = yield* Deferred.await(result)
    expect(settled.outcome).toBe("failed")
    expect(settled.response).toMatchObject({ _tag: "DomainFailure", failure: { _tag: "ToolError", tool: "edit" } })
  }),
)

it.effect("fails the pending operation instead of hanging when recording the result dies", () =>
  Effect.gen(function* () {
    const result = yield* Deferred.make<ExecutionResult, GatewayError>()
    yield* runNativeTool({
      operation: pendingOperation(result),
      lifecycle: lifecycle(() => Effect.die(new Error("persistence exploded"))),
      machineIdFor: () => Effect.succeed("b".repeat(64)),
      invoke: () => Effect.succeed(receivedFailure()),
    })
    const error = yield* Effect.flip(Deferred.await(result))
    expect(error).toBeInstanceOf(GatewayError)
    expect(error.kind).toBe("transport")
    expect(error.message).toBe("Native operation result could not be recorded")
  }),
)
