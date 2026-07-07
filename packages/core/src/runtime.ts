import { type Context, type Effect, Layer, ManagedRuntime } from "effect"
import { layer as configLayer } from "./config"
import { layer as diagnosticsLayer } from "./diagnostics"
import { layer as idGeneratorLayer } from "./id-generator"
import { layer as secretRedactorLayer } from "./secret-redactor"
import { layer as timeLayer } from "./time"

const configuredDiagnosticsLayer = diagnosticsLayer.pipe(
  Layer.provideMerge(configLayer),
  Layer.provideMerge(secretRedactorLayer),
)

export const layer = Layer.mergeAll(
  configLayer,
  secretRedactorLayer,
  configuredDiagnosticsLayer,
  timeLayer,
  idGeneratorLayer,
)

export function makeRuntime<I, S, E>(service: Context.Service<I, S>, serviceLayer: Layer.Layer<I, E>) {
  let runtime: ManagedRuntime.ManagedRuntime<I, E> | undefined
  const getRuntime = () => (runtime ??= ManagedRuntime.make(serviceLayer))

  return {
    runPromise: <A, Error>(fn: (service: S) => Effect.Effect<A, Error, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromise(service.use(fn), options),
    runPromiseExit: <A, Error>(fn: (service: S) => Effect.Effect<A, Error, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromiseExit(service.use(fn), options),
    runSync: <A, Error>(fn: (service: S) => Effect.Effect<A, Error, I>) => getRuntime().runSync(service.use(fn)),
    runFork: <A, Error>(fn: (service: S) => Effect.Effect<A, Error, I>) => getRuntime().runFork(service.use(fn)),
  }
}
