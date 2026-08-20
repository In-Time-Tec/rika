#!/usr/bin/env bun
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Execution from "@rika/execution"
import * as ScriptedModel from "@rika/execution/scripted-model"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import { Cause, Effect, Layer } from "effect"
import { archiveIncompatibleRuntime, isSchemaChecksumMismatch } from "./server-runtime-recovery"
import { validateWebSearchProviders } from "./server-configuration-adapter"

export const configuredBackendLayer = (options: {
  readonly filename: string
  readonly kernelPool?: Execution.LocalCellsOptions
  readonly capabilities?: Execution.LocalOptions["capabilities"]
  readonly credentialStore?: Layer.Layer<Execution.ProviderCredentialStore, never, never>
  readonly openAiAccountAuth?: Execution.LocalOptions["openAiAccountAuth"]
  readonly testModel?: { readonly script?: string; readonly response?: string }
}) => {
  const backend = (): Layer.Layer<
    ExecutionGateway.Service | ExecutionSessionLifecycle.Service,
    ExecutionGateway.StartTurnFailure
  > =>
    Execution.layerLocal({
      filename: options.filename,
      ...(options.kernelPool === undefined ? {} : { cells: Execution.localCells(options.kernelPool) }),
      ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      ...(options.credentialStore === undefined ? {} : { credentialStore: options.credentialStore }),
      ...(options.openAiAccountAuth === undefined ? {} : { openAiAccountAuth: options.openAiAccountAuth }),
      ...(options.testModel === undefined ? {} : { modelServices: ScriptedModel.layer(options.testModel) }),
    })
  // A TenetKit upgrade changes the runtime schema checksum, so an install carried across
  // versions fails to start every turn. The runtime database is execution state TenetKit
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
