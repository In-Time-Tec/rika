import * as Bash from "@rika/product/bash-tool"
import * as NativeToolRuntime from "@rika/product/native-tool-runtime"
import * as Edit from "@rika/product/edit-file-tool"
import * as Read from "@rika/product/read-file-tool"
import * as ShellCommandStatus from "@rika/product/shell-command-status-tool"
import { Cause, Clock, DateTime, Effect, Layer, Option, Schema } from "effect"
import { NestedOperation, ToolContext, ToolExecutor } from "generalist"
import * as RemoteTools from "../remote-tools"
import * as NativeTools from "../tool/registry"
import { terminalUnknownKind, TerminalUnknownFailure } from "./terminal-unknown"

interface ExecutionIdentity {
  readonly threadId: string
  readonly turnId: string
}

const placementFailure = (tool: string, message: string) =>
  ToolExecutor.FrameworkFailure.make({ stage: "placement", tool, message })

const cancellationFailure = (tool: string, message: string) => ToolExecutor.CancellationFailure.make({ tool, message })

const timeoutFor = (toolName: string): number => {
  switch (toolName) {
    case "read":
    case "edit":
      return 10_000
    case "shell_command_status":
      return 15_000
    default:
      return 120_000
  }
}

const terminalOutcomeFrom = (response: RemoteTools.TerminalResponse): ToolExecutor.TerminalOutcome =>
  response._tag === "Success"
    ? { _tag: "Success", result: response.result, encodedResult: response.result }
    : { _tag: "DomainFailure", failure: response.failure, encodedFailure: response.failure }

type UnparsedToolInput = ToolExecutor.Request["call"]["params"]

const parkTerminalUnknown = (
  request: ToolExecutor.Request,
  operationKey: string,
  toolCallId: string,
  error: RemoteTools.UnknownOutcome,
) =>
  Effect.gen(function* () {
    const operations = yield* Effect.serviceOption(NestedOperation.Operations)
    if (Option.isNone(operations))
      return yield* placementFailure(
        request.call.name,
        `Generalist nested-operation host is unavailable: ${error.message}`,
      )
    return yield* operations.value
      .run(
        {
          kind: terminalUnknownKind,
          payload: { sourceOperationKey: operationKey, toolCallId, toolName: request.call.name },
          replayPolicy: "never",
          success: RemoteTools.TerminalResponse,
          failure: TerminalUnknownFailure,
        },
        Effect.interrupt,
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.fail(
            placementFailure(
              request.call.name,
              Cause.hasInterruptsOnly(cause)
                ? `Remote tool outcome is unknown: ${error.message}`
                : `Generalist could not preserve the unknown remote tool outcome: ${Cause.pretty(cause)}`,
            ),
          ),
        ),
      )
  })

const decodeFailure = (tool: string, error: Schema.SchemaError) =>
  ToolExecutor.FrameworkFailure.make({ stage: "decode-input", tool, message: String(error) })

const runtimeRequest = Effect.fn("RemoteTools.runtimeRequest")(function* (
  tool: string,
  input: UnparsedToolInput,
): Effect.fn.Return<NativeToolRuntime.Request, ToolExecutor.FrameworkFailure> {
  switch (tool) {
    case "bash": {
      const value = yield* Schema.decodeUnknownEffect(Bash.tool.parametersSchema)(input).pipe(
        Effect.mapError((error) => decodeFailure(tool, error)),
      )
      let request: Bash.Request = { _tag: "Bash", command: value.command }
      if (value.workdir !== undefined) request = { ...request, workdir: value.workdir }
      if (value.timeout_ms !== undefined) request = { ...request, timeoutMillis: value.timeout_ms }
      return request
    }
    case "edit": {
      const value = yield* Schema.decodeUnknownEffect(Edit.tool.parametersSchema)(input).pipe(
        Effect.mapError((error) => decodeFailure(tool, error)),
      )
      let request: Edit.Request = {
        _tag: "Edit",
        path: value.path,
        oldStr: value.old_str,
        newStr: value.new_str,
      }
      if (value.replace_all !== undefined) request = { ...request, replaceAll: value.replace_all }
      return request
    }
    case "read": {
      const value = yield* Schema.decodeUnknownEffect(Read.tool.parametersSchema)(input).pipe(
        Effect.mapError((error) => decodeFailure(tool, error)),
      )
      return value.read_range === undefined
        ? { _tag: "Read", path: value.path }
        : { _tag: "Read", path: value.path, readRange: value.read_range }
    }
    case "shell_command_status": {
      const value = yield* Schema.decodeUnknownEffect(ShellCommandStatus.tool.parametersSchema)(input).pipe(
        Effect.mapError((error) => decodeFailure(tool, error)),
      )
      return value.waitMillis == null
        ? { _tag: "ShellCommandStatus", processId: value.processId }
        : { _tag: "ShellCommandStatus", processId: value.processId, waitMillis: value.waitMillis }
    }
    default:
      return yield* ToolExecutor.FrameworkFailure.make({
        stage: "decode-input",
        tool,
        message: `Tool ${tool} is not a native workspace tool`,
      })
  }
})

export const remoteToolExecutor = (options: {
  readonly route: Layer.Layer<RemoteTools.Service>
  readonly workspace: string
  readonly executionIdentity: ExecutionIdentity | undefined
}): Layer.Layer<ToolExecutor.ToolExecutor> =>
  Layer.effect(
    ToolExecutor.ToolExecutor,
    Effect.map(RemoteTools.Service, (service) => {
      const base = ToolExecutor.remote({
        toolkit: NativeTools.toolkit,
        execute: (request) =>
          Effect.gen(function* () {
            const context = yield* ToolContext.ToolContext
            const operationKey = context.operationKey
            if (operationKey === undefined || operationKey.length === 0)
              return yield* placementFailure(request.call.name, "remote tool execution requires an operation key")
            if (
              options.executionIdentity === undefined ||
              context.runId === undefined ||
              context.rootRunId === undefined
            )
              return yield* placementFailure(
                request.call.name,
                "remote tool execution requires thread, turn, and run identities",
              )
            const admittedAtMillis = yield* Clock.currentTimeMillis
            const toolDeadline = DateTime.formatIso(
              DateTime.makeUnsafe(admittedAtMillis + timeoutFor(request.call.name)),
            )
            const deadlineAt =
              context.deadline === undefined || toolDeadline < context.deadline ? toolDeadline : context.deadline
            const nativeRequest = yield* runtimeRequest(request.call.name, request.call.params)
            const toolCallId = context.toolCallId ?? request.call.id
            return yield* service
              .execute({
                operationKey,
                workspaceId: options.workspace,
                sessionId: request.sessionId,
                threadId: options.executionIdentity.threadId,
                turnId: options.executionIdentity.turnId,
                runId: context.runId,
                rootRunId: context.rootRunId,
                toolCallId,
                toolName: request.call.name,
                request: nativeRequest,
                attempt: context.attempt ?? 0,
                replayPolicy: "provider-idempotent",
                admittedAt: DateTime.formatIso(DateTime.makeUnsafe(admittedAtMillis)),
                deadlineAt,
              })
              .pipe(
                Effect.catchIf(Schema.is(RemoteTools.UnknownOutcome), (error) =>
                  parkTerminalUnknown(request, operationKey, toolCallId, error),
                ),
              )
          }),
      })
      const cancel: NonNullable<ToolExecutor.Service["cancel"]> = (request) =>
        Effect.gen(function* () {
          if (options.executionIdentity === undefined)
            return yield* cancellationFailure(request.toolName, "remote tool cancellation requires thread identity")
          const nativeRequest = yield* runtimeRequest(request.toolName, request.execution.call.params).pipe(
            Effect.mapError((error) => cancellationFailure(request.toolName, error.message)),
          )
          const response = yield* service
            .cancel({
              operationKey: request.operationKey,
              workspaceId: options.workspace,
              sessionId: request.sessionId,
              threadId: options.executionIdentity.threadId,
              turnId: options.executionIdentity.turnId,
              runId: request.runId,
              rootRunId: request.rootRunId,
              toolCallId: request.toolCallId,
              toolName: request.toolName,
              request: nativeRequest,
              attempt: request.attempt,
              replayPolicy: "provider-idempotent",
            })
            .pipe(
              Effect.catchIf(Schema.is(RemoteTools.UnknownOutcome), (error) =>
                Effect.succeed({
                  _tag: "AlreadyTerminal" as const,
                  response: {
                    _tag: "DomainFailure" as const,
                    failure: { kind: "unknown", message: error.message },
                  },
                }),
              ),
              Effect.mapError((error) => cancellationFailure(request.toolName, error.message)),
            )
          return response._tag === "Cancelled"
            ? ({ _tag: "Cancelled" } as const)
            : ({ _tag: "AlreadyTerminal", outcome: terminalOutcomeFrom(response.response) } as const)
        })
      return ToolExecutor.ToolExecutor.of({
        replayPolicy: () => "provider-idempotent",
        cancellable: base.matches,
        execute: base.execute,
        cancel,
      })
    }),
  ).pipe(Layer.provide(options.route))
