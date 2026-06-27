import { Config, IdGenerator, Time } from "@rika/core"
import { Database, Migration, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Registry } from "@rivetkit/effect"
import { Layer } from "effect"
import { layer as threadActorLayer } from "./thread-live"

export interface Options {
  readonly endpoint?: string
  readonly noWelcome?: boolean
}

export const defaultEndpoint = "http://127.0.0.1:6420"

export const endpointFromEnv = (env: Record<string, string | undefined> = process.env) =>
  env.RIVET_ENDPOINT ?? defaultEndpoint

const configuredDatabaseLayer = Database.layer.pipe(Layer.provideMerge(Config.layer))

export const serviceLayer = Layer.mergeAll(
  Time.layer,
  IdGenerator.layer,
  configuredDatabaseLayer,
  Migration.layer,
  ThreadEventLog.layer,
  ThreadProjection.layer,
)

export const supportLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(serviceLayer))

export const actorsLayer = () => threadActorLayer.pipe(Layer.provide(supportLayer))

export const layer = (options: Options = {}) => {
  const endpoint = options.endpoint ?? endpointFromEnv()
  return Registry.serve(actorsLayer()).pipe(
    Layer.provide(Registry.layer({ endpoint, noWelcome: options.noWelcome ?? true })),
  )
}
