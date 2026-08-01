import { Catalog as ToolCatalog } from "@rika/coding-tools/coding-tool-catalog"
import * as ProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as RikaToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import { ToolRuntime as RelayToolRuntime } from "@relayfx/sdk"
import { Cause, Clock, Context, Effect, Layer, LayerMap, Option, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { BackendError } from "@rika/product/execution-service"

const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  if (failure instanceof Error) return failure.name
  return typeof failure
}

const toolFailureAnnotations = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  return Schema.is(RikaToolRuntime.ToolError)(failure)
    ? {
        "rika.failure.category": failure.category,
        "rika.failure.outcome": failure.outcome,
        "rika.failure.interrupted": false,
      }
    : { "rika.failure.interrupted": Cause.hasInterrupts(cause) }
}

export const routedToolRuntimeLayer = <E, R>(input: {
  readonly layerForWorkspace: (workspace: string) => Layer.Layer<RikaToolRuntime.Service, E, R>
  readonly resolveWorkspace: (executionId: string) => Effect.Effect<string, BackendError>
}): Layer.Layer<
  RikaToolRuntime.Service,
  E,
  ChildProcessSpawner.ChildProcessSpawner | Exclude<R, ProcessRegistry.Service>
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const externalContext = yield* Effect.context<Exclude<R, ProcessRegistry.Service>>()
      const dependencies = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>()
      const processes = yield* LayerMap.make(() => ProcessRegistry.layer, { idleTimeToLive: "15 minutes" })
      const run: RikaToolRuntime.Interface["run"] = (request) =>
        Effect.scoped(
          Effect.gen(function* () {
            const call = yield* Effect.serviceOption(RelayToolRuntime.ToolCallInfo).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      RikaToolRuntime.ToolError.make({
                        tool: request._tag,
                        message: "Tool execution context is unavailable",
                        kind: "operation",
                        category: "operation",
                        outcome: "known",
                        recovery: "never",
                        nextAction: "Retry after the tool execution context is restored",
                      }),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            )
            const workspace = yield* input.resolveWorkspace(String(call.executionId))
            const processContext = yield* processes.contextEffect(workspace)
            const suppliedContext = Context.merge(
              Context.merge(Context.merge(externalContext, dependencies), processContext),
              Context.make(RelayToolRuntime.ToolCallInfo, call),
            ) as Context.Context<R>
            const runtimeContext: Context.Context<RikaToolRuntime.Service> = yield* Layer.build(
              input.layerForWorkspace(workspace).pipe(Layer.provide(Layer.succeedContext(suppliedContext))),
            )
            const runtime = Context.get(runtimeContext, RikaToolRuntime.Service)
            const startedAt = yield* Clock.currentTimeMillis
            const deadline = ToolCatalog.get(String(call.call.name))?.timeoutMillis
            yield* Effect.logInfo("tool.started").pipe(
              Effect.annotateLogs({
                "rika.execution.id": String(call.executionId),
                "rika.tool.call.id": String(call.call.id),
                ...(deadline === undefined ? {} : { "rika.tool.deadline.ms": deadline }),
                "rika.tool.name": String(call.call.name),
              }),
            )
            return yield* Effect.provideService(runtime.run(request), RelayToolRuntime.ToolCallInfo, call).pipe(
              Effect.tap(() =>
                Clock.currentTimeMillis.pipe(
                  Effect.flatMap((completedAt) =>
                    Effect.logInfo("tool.completed").pipe(
                      Effect.annotateLogs("rika.duration.ms", completedAt - startedAt),
                    ),
                  ),
                ),
              ),
              Effect.tapCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.void
                return Clock.currentTimeMillis.pipe(
                  Effect.flatMap((failedAt) =>
                    Effect.logError("tool.failed").pipe(
                      Effect.annotateLogs({
                        "rika.duration.ms": failedAt - startedAt,
                        ...toolFailureAnnotations(cause),
                        "rika.failure.kind": failureKind(cause),
                      }),
                    ),
                  ),
                )
              }),
              Effect.annotateLogs({
                "rika.execution.id": String(call.executionId),
                "rika.tool.call.id": String(call.call.id),
                ...(deadline === undefined ? {} : { "rika.tool.deadline.ms": deadline }),
                "rika.tool.name": String(call.call.name),
              }),
            )
          }),
        ).pipe(
          Effect.mapError(
            (cause): RikaToolRuntime.ToolError =>
              Schema.is(RikaToolRuntime.ToolError)(cause)
                ? cause
                : RikaToolRuntime.ToolError.make({
                    tool: request._tag,
                    message:
                      "The tool failed before Rika could classify it. The call may have changed state. Next action: inspect current state before deciding whether another call is safe.",
                    kind: "operation",
                    category: "operation",
                    outcome: "unknown",
                    recovery: "never",
                    nextAction: "Inspect current state before deciding whether another call is safe",
                  }),
          ),
        )
      return Layer.succeed(RikaToolRuntime.Service, RikaToolRuntime.Service.of({ run }))
    }),
  )

export const toolExecutionPolicy = { concurrency: "unbounded" as const }
export const allowAllPermissionRules = { rules: [], fallback: "allow" } as const
export const relayToolCallInfo = RelayToolRuntime.ToolCallInfo
