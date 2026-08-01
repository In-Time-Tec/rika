import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer, Schema } from "effect"
import type { ModelRegistry } from "@rika/relay-execution/model-provider-runtime"
import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import * as ModelRoute from "@rika/configuration/model-route"
import { modelRoutePlan } from "@rika/relay-execution/model-provider-runtime"
import * as ExecutionBackend from "@rika/relay-execution/relay-execution-layer"
import * as ExecutionRequest from "@rika/product/execution-request"

export const distinctModelRoutes = (routes: ReadonlyArray<ModelRouteResolution.ResolvedModelRoute>) =>
  routes.filter(
    (route, index, all) =>
      all.findIndex(
        (candidate) => modelRoutePlan(candidate).registrationKey === modelRoutePlan(route).registrationKey,
      ) === index,
  )

export const httpRoute = (route: ModelRouteResolution.ResolvedModelRoute) => {
  if (route.providerConnection.protocol === "amazon-bedrock") throw new Error("Expected an HTTP model route")
  return route as ModelRouteResolution.ResolvedModelRoute & {
    readonly providerConnection: ModelRoute.ModelRoute.HttpProviderConnection
  }
}

export const modelRouteDisplayLabel = (route: ModelRouteResolution.ResolvedModelRoute) => {
  const [provider, version, ...name] = route.model.split("-")
  const modelName = name.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ")
  return `${provider?.toUpperCase()}-${version} ${modelName} ${route.effort}`
}

export const recordingBackend = (starts: Array<ExecutionRequest.StartInput>, registrations?: Array<string>) =>
  ExecutionBackend.Service.of({
    ...(registrations === undefined
      ? {}
      : {
          registerModels: (values: ReadonlyArray<ModelRegistry.Registration>) =>
            Effect.sync(() => {
              registrations.push(...values.map((value) => value.registrationKey ?? ""))
            }),
        }),
    invokeChild: () => Effect.die("unused"),
    resolveInvocationSource: () => Effect.die("unused"),
    createFanOut: () => Effect.die("unused"),
    inspectFanOut: () => Effect.die("unused"),
    cancelFanOut: () => Effect.die("unused"),
    registerWorkflows: () => Effect.die("unused"),
    startWorkflow: () => Effect.die("unused"),
    inspectWorkflow: () => Effect.die("unused"),
    cancelWorkflow: () => Effect.die("unused"),
    start: (input) =>
      Effect.sync(() => {
        starts.push(input)
        return { turnId: input.turnId, status: "completed" as const, events: [] }
      }),
    inspect: () => Effect.sync((): undefined => undefined),
    replay: () => Effect.die("unused"),
    steer: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
  })

export class RouteOperationError extends Schema.TaggedErrorClass<RouteOperationError>()("OperationError", {
  message: Schema.String,
}) {}

export const withBunServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scopedWith((scope) =>
    Layer.buildWithScope(BunServices.layer, scope).pipe(
      Effect.flatMap((context) => effect.pipe(Effect.provide(context))),
    ),
  )
