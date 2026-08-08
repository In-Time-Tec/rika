import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"

const isApprovalResponseFailure = Schema.is(ExecutionGateway.ApprovalResponseFailure)

export const lazyBackendLayer = <E, R>(backendLayer: Layer.Layer<ExecutionGateway.Service, E, R>) =>
  Layer.effect(
    ExecutionGateway.Service,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const parent = yield* Effect.context<R>()
      const load = yield* Effect.cached(
        Effect.forkIn(
          Layer.buildWithScope(backendLayer, scope).pipe(
            Effect.provideContext(parent),
            Effect.map((context) => Context.get(context, ExecutionGateway.Service)),
          ),
          scope,
        ).pipe(Effect.flatMap(Fiber.join), Effect.uninterruptible),
      )
      return ExecutionGateway.Service.of({
        startTurn: (input) =>
          load.pipe(
            Effect.flatMap((backend) => backend.startTurn(input)),
            Effect.mapError((cause) => ExecutionGateway.StartTurnFailure.make({ message: String(cause) })),
          ),
        cancelTurn: (link, reason) =>
          load.pipe(
            Effect.flatMap((backend) => backend.cancelTurn(link, reason)),
            Effect.mapError((cause) => ExecutionGateway.CancelTurnFailure.make({ message: String(cause) })),
          ),
        steerTurn: (link, input) =>
          load.pipe(
            Effect.flatMap((backend) => backend.steerTurn(link, input)),
            Effect.mapError((cause) => ExecutionGateway.SteeringFailure.make({ message: String(cause) })),
          ),
        approveTurn: (link, input) =>
          load.pipe(
            Effect.flatMap((backend) => backend.approveTurn(link, input)),
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
            Effect.flatMap((backend) => backend.denyTurn(link, input)),
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
              Effect.map((backend) => backend.watchTurn(link, cursor)),
              Effect.mapError((cause) => ExecutionGateway.WatchTurnFailure.make({ message: String(cause) })),
            ),
          ),
        inspectTurn: (link) =>
          load.pipe(
            Effect.flatMap((backend) => backend.inspectTurn(link)),
            Effect.mapError((cause) => ExecutionGateway.InspectTurnFailure.make({ message: String(cause) })),
          ),
      })
    }),
  )
