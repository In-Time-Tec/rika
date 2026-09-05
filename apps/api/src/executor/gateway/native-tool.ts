import * as NativeToolRuntime from "@rika/product/native-tool-runtime"
import type { ToolOperationResponse } from "@rika/product/tool-operation-lifecycle"
import type { AccessWire, MachineOutcome, MachineRequest } from "@rika/remote-execution/protocol"
import { Cause, Deferred, Effect, Option, Schema } from "effect"
import {
  GatewayError,
  type ExecutionOutcome,
  type ExecutionResult,
  type LifecycleStore,
  type OperationIdentity,
} from "./contract"
import type { PendingOperation } from "./rpc/model"

const jsonValue = <A>(value: A): Schema.Json => Schema.decodeUnknownSync(Schema.Json)(value)

/**
 * The wire decoder yields a `ToolError` class instance, which is not a JSON value. Encode it back to its plain
 * shape before it becomes the durable domain failure; decoding the instance directly throws and never settles.
 */
const encodeToolError = Schema.encodeSync(NativeToolRuntime.ToolError)
const toolFailureValue = (failure: NativeToolRuntime.ToolError): Schema.Json => {
  const encoded = encodeToolError(failure)
  return jsonValue(encoded)
}

interface NativeTerminal {
  readonly response: ToolOperationResponse
  readonly outcome: ExecutionOutcome
}

export const machineTerminal = (outcome: MachineOutcome): NativeTerminal => {
  switch (outcome._tag) {
    case "Success":
      return outcome.value._tag === "NativeTool"
        ? { response: { _tag: "Success", result: jsonValue(outcome.value.result) }, outcome: "completed" }
        : {
            response: {
              _tag: "DomainFailure",
              failure: { kind: "execution", message: "Remote tool returned an unrelated machine result" },
            },
            outcome: "failed",
          }
    case "Failure":
      return {
        response: { _tag: "DomainFailure", failure: toolFailureValue(outcome.failure) },
        outcome: outcome.failure.tool === "mcp" && outcome.failure.outcome === "unknown" ? "unknown" : "failed",
      }
    case "Cancelled":
      return {
        response: { _tag: "DomainFailure", failure: { kind: "cancelled", message: "Tool operation cancelled" } },
        outcome: "cancelled",
      }
    case "Unknown":
    case "Fenced":
      return {
        response: { _tag: "DomainFailure", failure: { kind: "unknown", message: outcome.message } },
        outcome: "unknown",
      }
  }
}

const attribution = (operation: OperationIdentity) => ({
  operationKey: operation.operationKey,
  workspaceId: operation.workspaceId,
  sessionId: operation.sessionId,
  threadId: operation.threadId,
  turnId: operation.turnId,
  runId: operation.runId,
  rootRunId: operation.rootRunId,
  toolCallId: operation.toolCallId,
  attempt: operation.attempt,
})

export const persistNativeStart = Effect.fn("ExecutorGateway.native.persistStart")(function* (
  lifecycle: LifecycleStore,
  access: AccessWire,
  operation: OperationIdentity,
) {
  const operationAttribution = attribution(operation)
  for (const frame of [
    { _tag: "Accepted" as const, attribution: operationAttribution, cursor: 1 },
    { _tag: "Started" as const, attribution: operationAttribution, cursor: 2 },
  ]) {
    const appended = yield* lifecycle.append(access, frame)
    if (appended._tag === "AlreadyTerminal") return appended.result
  }
  return undefined
})

export const persistNativeOutcome = Effect.fn("ExecutorGateway.native.persistOutcome")(function* (
  lifecycle: LifecycleStore,
  access: AccessWire,
  operation: OperationIdentity,
  outcome: MachineOutcome,
): Effect.fn.Return<ExecutionResult, GatewayError> {
  const terminal = machineTerminal(outcome)
  const alreadyTerminal = yield* persistNativeStart(lifecycle, access, operation)
  if (alreadyTerminal !== undefined) return alreadyTerminal
  const appended = yield* lifecycle.append(access, {
    _tag: "Terminal",
    attribution: attribution(operation),
    cursor: 3,
    outcome: terminal.outcome,
    response: terminal.response,
  })
  return appended._tag === "AlreadyTerminal" ? appended.result : terminal
})

export const runNativeTool = (options: {
  readonly operation: PendingOperation
  readonly lifecycle: LifecycleStore
  readonly machineIdFor: (operationKey: string, attempt: number) => Effect.Effect<string, GatewayError>
  readonly invoke: (
    assignmentId: string,
    operationKey: string,
    attempt: number,
    machineId: string,
    request: MachineRequest,
    deadlineAt: string,
  ) => Effect.Effect<MachineOutcome, GatewayError>
}): Effect.Effect<void> => {
  const { operation } = options
  const execution = Effect.gen(function* () {
    const alreadyTerminal = yield* persistNativeStart(options.lifecycle, operation.access, operation.request)
    if (alreadyTerminal !== undefined) return alreadyTerminal
    const outcome = yield* options.invoke(
      operation.assignmentId,
      operation.operationKey,
      operation.attempt,
      yield* options.machineIdFor(operation.operationKey, operation.attempt),
      operation.request.machineRequest,
      operation.request.deadlineAt,
    )
    return yield* persistNativeOutcome(options.lifecycle, operation.access, operation.request, outcome)
  })
  return execution.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => {
        const failure = Cause.findErrorOption(cause)
        if (Option.isSome(failure)) return Deferred.fail(operation.result, failure.value)
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
        return Effect.logError("native-operation.settle-failed").pipe(
          Effect.annotateLogs({
            "rika.operation.key": operation.operationKey,
            "rika.operation.attempt": operation.attempt,
            "rika.error.message": Cause.pretty(cause),
          }),
          Effect.andThen(
            Deferred.fail(
              operation.result,
              GatewayError.make({ kind: "transport", message: "Native operation result could not be recorded" }),
            ),
          ),
        )
      },
      onSuccess: (result) => Deferred.succeed(operation.result, result),
    }),
    Effect.asVoid,
  )
}
