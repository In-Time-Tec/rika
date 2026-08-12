import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"

const isApprovalResponseFailure = Schema.is(ExecutionGateway.ApprovalResponseFailure)
const isLifecycleUnavailable = Schema.is(ExecutionSessionLifecycle.Unavailable)

export const lazyBackendLayer = <E, R, ROut>(backendLayer: Layer.Layer<ExecutionGateway.Service | ROut, E, R>) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const parent = yield* Effect.context<R>()
      const load = yield* Effect.cached(
        Effect.forkIn(
          Layer.buildWithScope(backendLayer, scope).pipe(
            Effect.provideContext(parent),
            Effect.map((context) => {
              const lifecycle = Context.getOption(context, ExecutionSessionLifecycle.Service)
              return {
                gateway: Context.get(context, ExecutionGateway.Service),
                lifecycle:
                  lifecycle._tag === "Some"
                    ? lifecycle.value
                    : ExecutionSessionLifecycle.Service.of({
                        requestCancellation: () =>
                          Effect.fail(
                            ExecutionSessionLifecycle.Unavailable.make({
                              message: "The execution backend does not provide session lifecycle cleanup",
                            }),
                          ),
                        awaitTerminal: () =>
                          Effect.fail(
                            ExecutionSessionLifecycle.Unavailable.make({
                              message: "The execution backend does not provide session lifecycle cleanup",
                            }),
                          ),
                        closeKernel: () =>
                          Effect.fail(
                            ExecutionSessionLifecycle.Unavailable.make({
                              message: "The execution backend does not provide session lifecycle cleanup",
                            }),
                          ),
                        dropKernelState: () =>
                          Effect.fail(
                            ExecutionSessionLifecycle.Unavailable.make({
                              message: "The execution backend does not provide session lifecycle cleanup",
                            }),
                          ),
                      }),
              }
            }),
          ),
          scope,
        ).pipe(Effect.flatMap(Fiber.join), Effect.uninterruptible),
      )
      const gateway = ExecutionGateway.Service.of({
        startTurn: (input) =>
          load.pipe(
            Effect.flatMap((backend) => backend.gateway.startTurn(input)),
            Effect.mapError((cause) => ExecutionGateway.StartTurnFailure.make({ message: String(cause) })),
          ),
        cancelTurn: (link, reason) =>
          load.pipe(
            Effect.flatMap((backend) => backend.gateway.cancelTurn(link, reason)),
            Effect.mapError((cause) => ExecutionGateway.CancelTurnFailure.make({ message: String(cause) })),
          ),
        steerTurn: (link, input) =>
          load.pipe(
            Effect.flatMap((backend) => backend.gateway.steerTurn(link, input)),
            Effect.mapError((cause) =>
              ExecutionGateway.SteeringFailure.make({ kind: "unknown", message: String(cause) }),
            ),
          ),
        approveTurn: (link, input) =>
          load.pipe(
            Effect.flatMap((backend) => backend.gateway.approveTurn(link, input)),
            Effect.mapError((cause) =>
              isApprovalResponseFailure(cause)
                ? cause
                : ExecutionGateway.ApprovalResponseFailure.make({
                    kind: "unavailable",
                    message: String(cause),
                  }),
            ),
          ),
        denyTurn: (link, input) =>
          load.pipe(
            Effect.flatMap((backend) => backend.gateway.denyTurn(link, input)),
            Effect.mapError((cause) =>
              isApprovalResponseFailure(cause)
                ? cause
                : ExecutionGateway.ApprovalResponseFailure.make({
                    kind: "unavailable",
                    message: String(cause),
                  }),
            ),
          ),
        watchTurn: (link, cursor) =>
          Stream.unwrap(
            load.pipe(
              Effect.map((backend) => backend.gateway.watchTurn(link, cursor)),
              Effect.mapError((cause) => ExecutionGateway.WatchTurnFailure.make({ message: String(cause) })),
            ),
          ),
        inspectTurn: (link) =>
          load.pipe(
            Effect.flatMap((backend) => backend.gateway.inspectTurn(link)),
            Effect.mapError((cause) => ExecutionGateway.InspectTurnFailure.make({ message: String(cause) })),
          ),
      })
      const lifecycle = ExecutionSessionLifecycle.Service.of({
        requestCancellation: (input) =>
          load.pipe(
            Effect.flatMap((backend) => backend.lifecycle.requestCancellation(input)),
            Effect.mapError((error) =>
              isLifecycleUnavailable(error)
                ? error
                : ExecutionSessionLifecycle.Unavailable.make({ message: String(error) }),
            ),
          ),
        awaitTerminal: (input) =>
          load.pipe(
            Effect.flatMap((backend) => backend.lifecycle.awaitTerminal(input)),
            Effect.mapError((error) =>
              isLifecycleUnavailable(error)
                ? error
                : ExecutionSessionLifecycle.Unavailable.make({ message: String(error) }),
            ),
          ),
        closeKernel: (input) =>
          load.pipe(
            Effect.flatMap((backend) => backend.lifecycle.closeKernel(input)),
            Effect.mapError((error) =>
              isLifecycleUnavailable(error)
                ? error
                : ExecutionSessionLifecycle.Unavailable.make({ message: String(error) }),
            ),
          ),
        dropKernelState: (input) =>
          load.pipe(
            Effect.flatMap((backend) => backend.lifecycle.dropKernelState(input)),
            Effect.mapError((error) =>
              isLifecycleUnavailable(error)
                ? error
                : ExecutionSessionLifecycle.Unavailable.make({ message: String(error) }),
            ),
          ),
      })
      return Context.make(ExecutionGateway.Service, gateway).pipe(
        Context.add(ExecutionSessionLifecycle.Service, lifecycle),
      )
    }),
  )
