/* oxlint-disable effecttsgo/missing-pipeable-signature, anti-slop-effect/no-service-constructor-imports -- this is the explicit per-call Generalist executor boundary. */

import * as NativeResult from "@rika/product/native-tool-result"
import { Effect, Layer, Schema } from "effect"
import { Pins, ToolContext, ToolExecutor, ToolPlacement } from "generalist"
import * as Hooks from "generalist/hooks"
import { RunStore } from "generalist/runtime"

import { workspaceComponentJournal, nativeOperationAuthority } from "./component"
import { ExecutorFenceError, ExecutorTransportError } from "./executor"
import type { ExecutorBoundary, WorkspaceExecutorService } from "./executor"
import { CanonicalResult, NativeOperationError, NativeOperationIntent, makeNativeOperationCoordinator } from "./operation"
import { toolkit, tools } from "./tools"

const toolFailure = (
  tool: string,
  message: string,
  category: NativeResult.FailureCategory,
  outcome: "known" | "unknown" = "known",
): NativeResult.ToolFailure => ({
  _tag: "ToolError",
  tool,
  message,
  kind: "operation",
  category,
  outcome,
  recovery: outcome === "unknown" ? "never" : "after_change",
  nextAction:
    outcome === "unknown"
      ? "Inspect the workspace and process state before deciding whether another call is safe"
      : "Correct the input or workspace condition and retry",
})

const unknownFailure = (tool: string, reason: string): NativeResult.ToolFailure =>
  toolFailure(tool, reason, "operation", "unknown")

const failureFrom = (
  tool: string,
  error: NativeOperationError | ExecutorTransportError | ExecutorFenceError,
): NativeResult.ToolFailure => {
  if (Schema.is(ExecutorTransportError)(error))
    return toolFailure(tool, error.message, "dependency_unavailable", "unknown")
  if (Schema.is(ExecutorFenceError)(error)) return toolFailure(tool, error.message, "access_denied")
  if (error.kind === "unresolved") return unknownFailure(tool, error.message)
  return toolFailure(tool, error.message, error.kind === "fenced" ? "access_denied" : "conflict")
}

const outcomeFrom = (tool: string, result: CanonicalResult): ToolExecutor.Outcome => {
  switch (result._tag) {
    case "Completed":
      return { _tag: "Success", result: result.result, encodedResult: result.result }
    case "DomainFailure":
      return { _tag: "DomainFailure", failure: result.failure, encodedFailure: result.failure }
    case "Accepted": {
      const failure = unknownFailure(tool, "Executor accepted the operation without a terminal result")
      return { _tag: "DomainFailure", failure, encodedFailure: failure }
    }
    case "Unknown": {
      const failure = unknownFailure(tool, result.reason)
      return { _tag: "DomainFailure", failure, encodedFailure: failure }
    }
  }
}

const terminalOutcome = (tool: string, result: CanonicalResult): ToolExecutor.TerminalOutcome => {
  const outcome = outcomeFrom(tool, result)
  if (outcome._tag !== "Suspend") return outcome
  const failure = unknownFailure(tool, "Executor cancellation returned a suspended outcome")
  return { _tag: "DomainFailure", failure, encodedFailure: failure }
}

const frameworkFailure = (tool: string, message: string) =>
  ToolExecutor.FrameworkFailure.make({ stage: "decode-input", tool, message })

const cancellationFailure = (tool: string, message: string) => ToolExecutor.CancellationFailure.make({ tool, message })

export const nativeBindingLayer = (workspace: Pick<WorkspaceExecutorService, "binding">) =>
  Hooks.layer([
    Hooks.onToolCall({
      key: "rika/runner-binding",
      version: "1",
      replayPolicy: "provider-idempotent",
      hook: (input) =>
        Effect.gen(function* () {
          if (!tools.some((tool) => tool.name === input.tool)) return
          yield* Schema.decodeUnknownEffect(Schema.Json)(input.args)
          const binding = workspace.binding
          yield* workspaceComponentJournal.bind(binding, `bind:${Pins.digest(binding)}`)
        }),
    }),
  ])

const nativeRoute = (workspace: WorkspaceExecutorService) =>
  ToolExecutor.route<ToolContext.ToolContext | RunStore.RunStore>({
    tools: Object.keys(toolkit.tools),
    replayPolicy: () => "never",
    execute: (request) =>
      Effect.gen(function* () {
        const context = yield* ToolContext.ToolContext
        const store = yield* RunStore.RunStore
        const input = yield* Schema.decodeUnknownEffect(Schema.Json)(request.call.params).pipe(
          Effect.mapError(() => frameworkFailure(request.call.name, "Tool parameters must be JSON")),
        )
        const operationId = context.operationKey?.trim()
        if (operationId === undefined || operationId.length === 0)
          return yield* frameworkFailure(request.call.name, "Native Tool execution requires a stable operation key")
        const intent = yield* Schema.decodeEffect(NativeOperationIntent)({
          operationId,
          tool: request.call.name,
          inputDigest: Pins.digest(input),
          binding: workspace.binding,
        }).pipe(
          Effect.mapError(() => frameworkFailure(request.call.name, "Native Tool execution identity is invalid")),
        )
        const boundary: ExecutorBoundary = {
          handshake: workspace.handshake,
          dispatch: (operation, handshake) => workspace.dispatch(operation, input, handshake),
          receipt: workspace.receipt,
        }
        const result = yield* Effect.result(
          makeNativeOperationCoordinator(nativeOperationAuthority({ context, store }), boundary).dispatch(intent),
        )
        if (result._tag === "Failure") {
          const failure = failureFrom(request.call.name, result.failure)
          return { _tag: "DomainFailure" as const, failure, encodedFailure: failure }
        }
        return outcomeFrom(request.call.name, result.success)
      }),
    cancel: (request) =>
      workspace.cancel(request.operationKey).pipe(
        Effect.map((result) =>
          result._tag === "Cancelled"
            ? ({ _tag: "Cancelled" } as const)
            : ({ _tag: "AlreadyTerminal", outcome: terminalOutcome(request.toolName, result.result) } as const),
        ),
        Effect.mapError((error) => cancellationFailure(request.toolName, error.message)),
      ),
  })

export const nativeToolExecutionLayer = <R = never>(
  workspace: WorkspaceExecutorService,
  additionalRoutes: ReadonlyArray<ToolPlacement.RouteInput<ToolContext.ToolContext | R>> = [],
): Layer.Layer<
  ToolExecutor.ToolExecutor | Hooks.Hooks,
  never,
  ToolContext.ToolContext | RunStore.RunStore | R
> =>
  Layer.merge(
    ToolExecutor.layerRouter<ToolContext.ToolContext | RunStore.RunStore | R>([
      nativeRoute(workspace),
      ...additionalRoutes,
    ]),
    nativeBindingLayer(workspace),
  )
