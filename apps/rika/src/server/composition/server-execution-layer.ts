#!/usr/bin/env bun
import * as BunServices from "@effect/platform-bun/BunServices"
import * as BatonExecution from "@rika/baton-execution/baton-execution"
import * as ScriptedModel from "@rika/baton-execution/scripted-model"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Cause, Effect, Layer } from "effect"
import { archiveIncompatibleRuntime, isSchemaChecksumMismatch } from "./server-runtime-recovery"
import { validateWebSearchProviders } from "./server-configuration-adapter"

export const configuredBackendLayer = (options: {
  readonly filename: string
  readonly agentServices?: (workspace: string) => Layer.Layer<BatonExecution.AgentToolServices, never, never>
  readonly credentialStore?: Layer.Layer<BatonExecution.ProviderCredentialStore, never, never>
  readonly testModel?: { readonly script?: string; readonly response?: string }
}) => {
  const backend = (): Layer.Layer<ExecutionGateway.Service, ExecutionGateway.StartTurnFailure> =>
    BatonExecution.layer({
      filename: options.filename,
      ...(options.agentServices === undefined ? {} : { agentServices: options.agentServices }),
      ...(options.credentialStore === undefined ? {} : { credentialStore: options.credentialStore }),
      ...(options.testModel === undefined ? {} : { modelServices: ScriptedModel.layer(options.testModel) }),
    })
  // A Baton upgrade changes the runtime schema checksum, so an install carried across
  // versions fails to start every turn. The runtime database is execution state Baton
  // rebuilds; threads and transcripts live in the product database. Archive the
  // incompatible file once and retry instead of stranding the install.
  const recovered = backend().pipe(
    Layer.catchCause((cause) =>
      isSchemaChecksumMismatch(Cause.squash(cause))
        ? Layer.unwrap(archiveIncompatibleRuntime(options.filename).pipe(Effect.as(backend()))).pipe(
            Layer.provide(BunServices.layer),
          )
        : Layer.effectContext(Effect.failCause(cause)),
    ),
  )
  return options.credentialStore === undefined ? recovered : Layer.provide(recovered, options.credentialStore)
}

export { validateWebSearchProviders }
