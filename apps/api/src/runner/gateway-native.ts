import type { HostedExecutionOperationsService } from "@rika/product-store/executor-operations"
import type { ToolOperationLifecycleFrame, ToolOperationResponse } from "@rika/product/tool-operation-lifecycle"
import type { MachineOutcome, MachineRequest } from "@rika/remote-execution/protocol"
import { Deferred, Effect, Ref, Schema } from "effect"
import type { GatewayError } from "../executor/gateway"
import { gatewayModel, type FinalResult, type Pending } from "./gateway-model"

interface NativeDependencies {
  readonly operations: HostedExecutionOperationsService
  readonly pending: Ref.Ref<Map<string, Pending>>
  readonly invokeMachine: (
    assignmentId: string,
    operationKey: string,
    attempt: number,
    machineId: string,
    request: MachineRequest,
  ) => Effect.Effect<MachineOutcome, GatewayError>
  readonly machineIdFor: (operationKey: string, attempt: number) => Effect.Effect<string, GatewayError>
  readonly finalize: (input: {
    readonly access: Pending["access"]
    readonly operationKey: string
    readonly attempt: number
    readonly response: ToolOperationResponse
    readonly state: "completed" | "unknown"
  }) => Effect.Effect<FinalResult, GatewayError>
  readonly settlePending: (
    assignmentId: string,
    operationKey: string,
    attempt: number,
    result: FinalResult,
  ) => Effect.Effect<void>
}

const jsonValue = <A>(value: A): Schema.Json => Schema.decodeUnknownSync(Schema.Json)(value)

const machineTerminal = (outcome: MachineOutcome): Pick<FinalResult, "response" | "outcome"> => {
  switch (outcome._tag) {
    case "Success":
      return { response: { _tag: "Success", result: jsonValue(outcome.value.result) }, outcome: "completed" }
    case "Failure":
      return { response: { _tag: "DomainFailure", failure: jsonValue(outcome.failure) }, outcome: "failed" }
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

const make = (
  operations: NativeDependencies["operations"],
  pending: NativeDependencies["pending"],
  invokeMachine: NativeDependencies["invokeMachine"],
  machineIdFor: NativeDependencies["machineIdFor"],
  finalize: NativeDependencies["finalize"],
  settlePending: NativeDependencies["settlePending"],
) => {
  const dependencies: NativeDependencies = { operations, pending, invokeMachine, machineIdFor, finalize, settlePending }
  const { failure } = gatewayModel
  const append = (operation: Pending, frame: ToolOperationLifecycleFrame) =>
    dependencies.operations
      .appendFrame(operation.assignmentId, frame)
      .pipe(Effect.mapError(() => failure("transport", "Could not persist Runner tool lifecycle")))
  const currentAccess = (operation: Pending) =>
    Ref.get(dependencies.pending).pipe(
      Effect.map(
        (current) =>
          current.get(gatewayModel.operationKey(operation.assignmentId, operation.operationKey, operation.attempt))
            ?.access ?? operation.access,
      ),
    )
  const settleDurable = Effect.fn("RunnerGateway.native.settleDurable")(function* (operation: Pending) {
    const durable = yield* dependencies.operations
      .findOperation(operation)
      .pipe(Effect.mapError(() => failure("transport", "Could not read Runner tool result")))
    if (
      durable === undefined ||
      (durable.state !== "completed" && durable.state !== "unknown") ||
      durable.response === null ||
      durable.terminalOutcome === null
    )
      return yield* failure("transport", "Persisted Runner tool terminal is incomplete")
    const result = gatewayModel.finalResult(durable.response, durable.terminalOutcome, yield* currentAccess(operation))
    yield* dependencies.settlePending(operation.assignmentId, operation.operationKey, operation.attempt, result)
  })

  const run = (operation: Pending): Effect.Effect<void> => {
    const attribution = {
      operationKey: operation.operationKey,
      workspaceId: operation.request.workspaceId,
      sessionId: operation.request.sessionId,
      threadId: operation.request.threadId,
      turnId: operation.request.turnId,
      runId: operation.request.runId,
      rootRunId: operation.request.rootRunId,
      toolCallId: operation.request.toolCallId,
      attempt: operation.attempt,
    }
    const execute = Effect.gen(function* () {
      for (const frame of [
        { _tag: "Accepted" as const, attribution, cursor: 1 },
        { _tag: "Started" as const, attribution, cursor: 2 },
      ]) {
        const disposition = yield* append(operation, frame)
        if (disposition === "already-terminal") return yield* settleDurable(operation)
        if (disposition === "invalid-sequence")
          return yield* failure("fenced", "Runner tool lifecycle conflicts with durable state")
      }
      const machine = yield* dependencies.invokeMachine(
        operation.assignmentId,
        operation.operationKey,
        operation.attempt,
        yield* dependencies.machineIdFor(operation.operationKey, operation.attempt),
        operation.request.machineRequest,
      )
      const terminal = machineTerminal(machine)
      const disposition = yield* append(operation, {
        _tag: "Terminal",
        attribution,
        cursor: 3,
        outcome: terminal.outcome,
        response: terminal.response,
      })
      if (disposition === "already-terminal") return yield* settleDurable(operation)
      if (disposition === "invalid-sequence")
        return yield* failure("fenced", "Runner tool terminal conflicts with durable state")
      const result = yield* dependencies.finalize({
        access: yield* currentAccess(operation),
        operationKey: operation.operationKey,
        attempt: operation.attempt,
        response: terminal.response,
        state: terminal.outcome === "unknown" ? "unknown" : "completed",
      })
      yield* dependencies.settlePending(operation.assignmentId, operation.operationKey, operation.attempt, result)
    })
    return execute.pipe(
      Effect.matchEffect({
        onFailure: (error) => Deferred.fail(operation.result, error),
        onSuccess: () => Effect.void,
      }),
      Effect.asVoid,
    )
  }

  return { run }
}

export const runnerGatewayNative = { make }
