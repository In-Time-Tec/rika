import { BaseServiceLayer } from "@rika/tools"
import { Config, SecretRedactor } from "@rika/core"
import { Client, Registry } from "@rivetkit/effect"
import { Effect, Layer } from "effect"
import * as HostConfig from "./host-config"
import * as ThreadClient from "./thread-client"
import { layer as threadActorLayer } from "./thread-live"

export interface Options extends HostConfig.ResolveOptions {}

export const defaultEndpoint = HostConfig.defaultLocalEndpoint

export const endpointFromEnv = (env: Record<string, string | undefined> = process.env) =>
  env.RIKA_RIVET_ENDPOINT ?? env.RIVET_ENDPOINT ?? defaultEndpoint

type ServiceLayerOutput = BaseServiceLayer.CommonOutput

type ServiceLayerError = BaseServiceLayer.Error

export const serviceLayerFromEnv = (
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): Layer.Layer<ServiceLayerOutput, ServiceLayerError> => {
  const configLayer = Config.layerFromEnv(env, cwd)
  const redactorLayer = SecretRedactor.layerFromEnv(env)

  return BaseServiceLayer.fromEnv({ env, workspaceRoot: cwd, configLayer, redactorLayer }).agentLoopLayer
}

export const serviceLayer: Layer.Layer<ServiceLayerOutput, ServiceLayerError> = serviceLayerFromEnv()

export const supportLayer: Layer.Layer<ServiceLayerOutput, ServiceLayerError> = serviceLayer

export const supportLayerFromEnv = (
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): Layer.Layer<ServiceLayerOutput, ServiceLayerError> => serviceLayerFromEnv(env, cwd)

export const actorsLayerFromEnv = (env: Record<string, string | undefined> = process.env, cwd = process.cwd()) =>
  threadActorLayer.pipe(Layer.provide(supportLayerFromEnv(env, cwd)))

export const actorsLayer = () => actorsLayerFromEnv()

export const clientLayer = (options: Options = {}) =>
  Layer.unwrap(
    HostConfig.resolveOptions(options).pipe(Effect.map((host) => Client.layer(HostConfig.toClientOptions(host)))),
  )

export const threadClientLayer = (options: Options = {}) => ThreadClient.layer.pipe(Layer.provide(clientLayer(options)))

export const layerFromEnv = (
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
  options: Options = {},
) =>
  Layer.unwrap(
    HostConfig.resolveOptions(options, env).pipe(
      Effect.map((host) =>
        Registry.serve(actorsLayerFromEnv(env, cwd)).pipe(
          Layer.provide(Registry.layer(HostConfig.toRegistryOptions(host))),
        ),
      ),
    ),
  )

export const layer = (options: Options = {}) => layerFromEnv(process.env, process.cwd(), options)
