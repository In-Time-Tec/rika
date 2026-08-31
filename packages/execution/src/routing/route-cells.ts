import { Cell, CellTool, KernelPool } from "generalist/repl"
import { ToolContext, ToolExecutor } from "generalist"
import * as ExecutorRuntime from "@rika/kernel/executor-runtime"
import { Clock, Context, DateTime, Effect, Function, Layer, Schema, Stream } from "effect"
import type { LocalCellServices, RemoteCellRoute } from "./route-domain"
import * as RemoteCells from "../remote-cells"

type ExecutionIdentity = { readonly threadId: string; readonly turnId: string }

const unsupportedCellTool = (tool: string) =>
  ToolExecutor.FrameworkFailure.make({
    stage: "handler",
    tool,
    message: `the configured cell adapter does not route ${tool}`,
  })

const unavailableCellExecutor = Layer.succeed(
  ToolExecutor.ToolExecutor,
  ToolExecutor.ToolExecutor.of({ execute: (request) => unsupportedCellTool(request.call.name) }),
)

const deadlineFailure = (failure: Cell.CellFailure, deadlineMillis: number): Cell.CellFailure => {
  if (failure._tag !== "generalist/repl/CellExecutionFailed") return failure
  const exceeded =
    failure.name === "Celltimed-out" || (failure.name === "Cellaborted" && failure.durationMillis >= deadlineMillis)
  if (!exceeded) return failure
  return Cell.CellExecutionFailed.make({
    ...failure,
    name: "CellDeadlineExceeded",
    message: `cell exceeded the ${deadlineMillis / 1_000}s deadline; split long work across cells or start it with rika.processes.start`,
  })
}

const infrastructureCellFailure = (
  failure: RemoteCells.InfrastructureFailure,
  request: RemoteCells.CancellationRequest,
): Cell.CellFailure => {
  if (failure.kind === "fenced" || failure.kind === "workspace")
    return Cell.KernelUnavailable.make({
      sessionId: request.sessionId,
      reason: failure.kind === "fenced" ? "lease-lost" : "profile-mismatch",
      message: failure.message,
    })
  if (failure.kind === "cancelled")
    return Cell.KernelUnavailable.make({
      sessionId: request.sessionId,
      reason: "closed",
      message: failure.message,
    })
  return Cell.CellOutcomeUnknown.make({
    sessionId: request.sessionId,
    cellId: request.toolCallId,
    epoch: 0,
    reason: failure.kind === "unknown" ? "transport-lost" : "host-terminated",
    message: failure.message,
  })
}

type DecodedRemoteCellResponse =
  | { readonly _tag: "Success"; readonly result: Cell.CellResult }
  | { readonly _tag: "DomainFailure"; readonly failure: Cell.CellFailure }
  | { readonly _tag: "Suspend"; readonly token: string }

const decodeRemoteCellResponse = (
  request: RemoteCells.CancellationRequest,
  response: RemoteCells.TransportResponse,
): Effect.Effect<DecodedRemoteCellResponse, ToolExecutor.FrameworkFailure> =>
  Schema.decodeUnknownEffect(RemoteCells.Response, { onExcessProperty: "error" })(response).pipe(
    Effect.mapError((cause) =>
      ToolExecutor.FrameworkFailure.make({
        stage: "placement",
        tool: CellTool.name,
        message: `remote cell response is invalid: ${String(cause)}`,
      }),
    ),
    Effect.map((decoded): DecodedRemoteCellResponse => {
      if (decoded._tag !== "DomainFailure") return decoded
      return {
        _tag: "DomainFailure",
        failure: Schema.is(Cell.CellFailure)(decoded.failure)
          ? decoded.failure
          : infrastructureCellFailure(decoded.failure, request),
      }
    }),
  )

export type RemoteCellOperationOutcome =
  | {
      readonly _tag: "Success"
      readonly result: Cell.CellResult
      readonly encodedResult: typeof Cell.CellResult.Encoded
    }
  | {
      readonly _tag: "DomainFailure"
      readonly failure: Cell.CellFailure
      readonly encodedFailure: typeof Cell.CellFailure.Encoded
    }
  | { readonly _tag: "Suspend"; readonly token: string }

const remoteCellOperationOutcomeFromDecoded = Effect.fn("RemoteCell.operationOutcome")(function* (
  decoded: DecodedRemoteCellResponse,
) {
  if (decoded._tag === "Suspend") return decoded
  if (decoded._tag === "Success") {
    const encodedResult = yield* Schema.encodeUnknownEffect(Cell.CellResult)(decoded.result)
    return { ...decoded, encodedResult }
  }
  const encodedFailure = yield* Schema.encodeUnknownEffect(Cell.CellFailure)(decoded.failure)
  return { ...decoded, encodedFailure }
})

const remoteCellOperationOutcomeImpl = (
  request: RemoteCells.CancellationRequest,
  response: RemoteCells.TransportResponse,
): Effect.Effect<RemoteCellOperationOutcome, ToolExecutor.FrameworkFailure> =>
  Effect.gen(function* () {
    const decoded = yield* decodeRemoteCellResponse(request, response)
    return yield* remoteCellOperationOutcomeFromDecoded(decoded)
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(ToolExecutor.FrameworkFailure)(cause)
        ? cause
        : ToolExecutor.FrameworkFailure.make({
            stage: "placement",
            tool: CellTool.name,
            message: `remote cell response is invalid: ${String(cause)}`,
          }),
    ),
  )

export const remoteCellOperationOutcome: {
  (
    response: RemoteCells.TransportResponse,
  ): (
    request: RemoteCells.CancellationRequest,
  ) => Effect.Effect<RemoteCellOperationOutcome, ToolExecutor.FrameworkFailure>
  (
    request: RemoteCells.CancellationRequest,
    response: RemoteCells.TransportResponse,
  ): Effect.Effect<RemoteCellOperationOutcome, ToolExecutor.FrameworkFailure>
} = Function.dual(2, remoteCellOperationOutcomeImpl)

const deadlinePool = (pool: KernelPool.Service, deadlineMillis: number): KernelPool.Service => ({
  ...pool,
  execute: (request) =>
    pool.execute(request).pipe(
      Effect.mapError((failure) => deadlineFailure(failure, deadlineMillis)),
      Effect.map((execution) => ({
        events: execution.events.pipe(Stream.mapError((failure) => deadlineFailure(failure, deadlineMillis))),
        result: execution.result.pipe(Effect.mapError((failure) => deadlineFailure(failure, deadlineMillis))),
      })),
    ),
})

/**
 * The pool arrives already built, owned by the composition root's own scope, because it outlives
 * every cell that uses it. Building it here instead would give it whichever cell forced it first,
 * and that cell's scope closes when it finishes — leaving every later cell holding a released map
 * that answers `RcMap.get` with an interrupt rather than a worker.
 *
 * Only `enter` is scoped per call: it registers this cell's identity for the duration of this cell
 * and must be removed when it ends.
 */
const cellExecutor = (
  services: Context.Context<LocalCellServices>,
  deadlineMillis: number,
): Layer.Layer<ToolExecutor.ToolExecutor> =>
  Layer.succeed(
    ToolExecutor.ToolExecutor,
    ToolExecutor.ToolExecutor.of({
      execute: (request) => {
        if (!CellTool.route.matches(request)) return unsupportedCellTool(request.call.name)
        return Effect.scoped(
          Context.get(services, ExecutorRuntime.CellContext)
            .enter(request.sessionId)
            .pipe(
              Effect.andThen(
                CellTool.route
                  .execute(request)
                  .pipe(
                    Effect.provideService(
                      KernelPool.KernelPool,
                      KernelPool.KernelPool.of(
                        deadlinePool(Context.get(services, KernelPool.KernelPool), deadlineMillis),
                      ),
                    ),
                  ),
              ),
            ),
        )
      },
    }),
  )

const remoteCellExecutor = (
  route: RemoteCellRoute,
  workspace: string,
  executionIdentity: ExecutionIdentity | undefined,
  deadlineMillis: number,
): Layer.Layer<ToolExecutor.ToolExecutor> =>
  Layer.effect(
    ToolExecutor.ToolExecutor,
    Effect.map(RemoteCells.Service, (cells) => {
      const cellRoute = ToolExecutor.route({
        tools: [CellTool.name],
        replayPolicy: () => "provider-idempotent",
        execute: (request) =>
          Effect.gen(function* () {
            const context = yield* ToolContext.ToolContext
            const authority = yield* ExecutorRuntime.capture
            const admittedAtMillis = yield* Clock.currentTimeMillis
            const cellDeadlineAt = DateTime.formatIso(DateTime.makeUnsafe(admittedAtMillis + deadlineMillis))
            const deadlineAt =
              context.deadline === undefined || cellDeadlineAt < context.deadline ? cellDeadlineAt : context.deadline
            const operationKey = context.operationKey
            if (operationKey === undefined || operationKey.length === 0)
              return yield* ToolExecutor.FrameworkFailure.make({
                stage: "placement",
                tool: request.call.name,
                message: "remote cell execution requires an operation key",
              })
            if (executionIdentity === undefined || context.runId === undefined || context.rootRunId === undefined)
              return yield* ToolExecutor.FrameworkFailure.make({
                stage: "placement",
                tool: request.call.name,
                message: "remote cell execution requires thread, turn, and run identities",
              })
            const identity = executionIdentity
            const runId = context.runId
            const rootRunId = context.rootRunId
            const parameters = yield* Schema.decodeUnknownEffect(CellTool.Parameters)(request.call.params).pipe(
              Effect.mapError((cause) =>
                ToolExecutor.FrameworkFailure.make({
                  stage: "decode-input",
                  tool: request.call.name,
                  message: String(cause),
                }),
              ),
            )
            const remoteRequest = RemoteCells.Request.make({
              operationKey,
              workspaceId: workspace,
              sessionId: request.sessionId,
              threadId: identity.threadId,
              turnId: identity.turnId,
              runId,
              rootRunId,
              toolCallId: context.toolCallId ?? request.call.id,
              code: parameters.code,
              attempt: context.attempt ?? 0,
              replayPolicy: "provider-idempotent",
              admittedAt: DateTime.formatIso(DateTime.makeUnsafe(admittedAtMillis)),
              deadlineAt,
            })
            const response = yield* cells.execute(remoteRequest, authority).pipe(
              Effect.mapError((error) =>
                ToolExecutor.FrameworkFailure.make({
                  stage: "placement",
                  tool: request.call.name,
                  message: error.message,
                }),
              ),
            )
            return yield* remoteCellOperationOutcome(remoteRequest, response)
          }),
        cancel: (request) =>
          Effect.gen(function* () {
            if (executionIdentity === undefined)
              return yield* ToolExecutor.CancellationFailure.make({
                tool: request.toolName,
                message: "remote cell cancellation requires thread and turn identities",
              })
            const parameters = yield* Schema.decodeUnknownEffect(CellTool.Parameters)(
              request.execution.call.params,
            ).pipe(
              Effect.mapError((cause) =>
                ToolExecutor.CancellationFailure.make({
                  tool: request.toolName,
                  message: `remote cell cancellation request is invalid: ${String(cause)}`,
                }),
              ),
            )
            const remoteRequest: RemoteCells.CancellationRequest = {
              operationKey: request.operationKey,
              workspaceId: workspace,
              sessionId: request.sessionId,
              threadId: executionIdentity.threadId,
              turnId: executionIdentity.turnId,
              runId: request.runId,
              rootRunId: request.rootRunId,
              toolCallId: request.toolCallId,
              code: parameters.code,
              attempt: request.attempt,
              replayPolicy: "provider-idempotent",
            }
            const response = yield* cells
              .cancel(remoteRequest)
              .pipe(
                Effect.mapError((error) =>
                  ToolExecutor.CancellationFailure.make({ tool: request.toolName, message: error.message }),
                ),
              )
            const decoded = yield* Schema.decodeUnknownEffect(RemoteCells.Response, { onExcessProperty: "error" })(
              response,
            ).pipe(
              Effect.mapError((cause) =>
                ToolExecutor.CancellationFailure.make({
                  tool: request.toolName,
                  message: `remote cell cancellation response is invalid: ${String(cause)}`,
                }),
              ),
            )
            if (decoded._tag === "Suspend")
              return yield* ToolExecutor.CancellationFailure.make({
                tool: request.toolName,
                message: "remote cell cancellation did not reach a terminal outcome",
              })
            if (decoded._tag === "DomainFailure" && !Schema.is(Cell.CellFailure)(decoded.failure)) {
              if (decoded.failure.kind === "cancelled") return { _tag: "Cancelled" } as const
              if (decoded.failure.kind === "unknown")
                return yield* ToolExecutor.CancellationFailure.make({
                  tool: request.toolName,
                  message: decoded.failure.message,
                })
            }
            const outcome = yield* remoteCellOperationOutcomeFromDecoded(
              decoded._tag === "DomainFailure"
                ? {
                    _tag: "DomainFailure",
                    failure: Schema.is(Cell.CellFailure)(decoded.failure)
                      ? decoded.failure
                      : infrastructureCellFailure(decoded.failure, remoteRequest),
                  }
                : decoded,
            ).pipe(
              Effect.mapError((error) =>
                ToolExecutor.CancellationFailure.make({ tool: request.toolName, message: error.message }),
              ),
            )
            if (outcome._tag === "Suspend")
              return yield* ToolExecutor.CancellationFailure.make({
                tool: request.toolName,
                message: "remote cell cancellation did not reach a terminal outcome",
              })
            return { _tag: "AlreadyTerminal", outcome } as const
          }),
      })
      return ToolExecutor.ToolExecutor.of({
        replayPolicy: (request) => cellRoute.replayPolicy?.(request) ?? "never",
        cancellable: cellRoute.matches,
        execute: (request) =>
          cellRoute.matches(request) ? cellRoute.execute(request) : unsupportedCellTool(request.call.name),
        cancel: (request) =>
          cellRoute.matches(request.execution)
            ? cellRoute.cancel!(request)
            : ToolExecutor.CancellationFailure.make({
                tool: request.toolName,
                message: `the configured cell adapter does not cancel ${request.toolName}`,
              }),
      })
    }),
  ).pipe(Layer.provide(route.cells))

interface CellRouting {
  readonly cellExecutor: typeof cellExecutor
  readonly remoteCellExecutor: typeof remoteCellExecutor
  readonly unavailableCellExecutor: Layer.Layer<ToolExecutor.ToolExecutor>
}

export const cellRouting: CellRouting = { cellExecutor, remoteCellExecutor, unavailableCellExecutor }
