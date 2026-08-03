#!/usr/bin/env bun
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionRequest from "@rika/product/execution-request"
import * as OpenAiAuth from "@rika/product/openai-auth-service"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as ThreadSearchRepository from "@rika/product-store/sqlite-thread-search-repository"
import * as ThreadInteractionRepository from "@rika/product-store/sqlite-thread-interaction-repository"
import * as ThreadToolService from "@rika/product/thread-tool-service"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as RelayExecution from "@rika/relay-execution/relay-execution-layer"
import { Cause, Effect, Exit, Layer, pipe } from "effect"
import { resolveExecutionWorkspace } from "./resident-execution-recovery"
import { validateWebSearchProviders } from "./resident-configuration-adapter"

interface ConfiguredBackendOptions<ProviderAuthError> {
  readonly filename: string
  readonly workspace: string
  readonly repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>
  readonly turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>
  readonly transcriptRepositoryLayer: Layer.Layer<
    TranscriptRepository.Service,
    TranscriptRepository.RepositoryError,
    never
  >
  readonly threadSearchRepositoryLayer: Layer.Layer<
    ThreadSearchRepository.Service,
    ThreadSearchRepository.RepositoryError,
    never
  >
  readonly threadInteractionRepositoryLayer: Layer.Layer<
    ThreadInteractionRepository.Service,
    ThreadInteractionRepository.RepositoryError,
    never
  >
  readonly settings?: SettingsDefaults.ConfigurationSettings
  readonly persistedModelRoutes?: ReadonlyArray<ExecutionRouteSnapshot.ExecutionRouteModelSnapshot>
  readonly webSearchCredentials?: Readonly<Record<string, import("effect").Redacted.Redacted<string>>>
  readonly resolveLegacyRoute?: (
    input: ExecutionRequest.StartInput,
  ) => Effect.Effect<ExecutionRouteSnapshot.ExecutionRoutePin, ExecutionBackend.BackendError>
  readonly threadToolGateway: ThreadToolService.Gateway
  readonly providerAuthLayer: Layer.Layer<OpenAiAuth.Service, ProviderAuthError>
  readonly toolRuntimeLayerForWorkspace: (
    workspace: string,
  ) => Layer.Layer<ToolRuntime.Service, ExecutionBackend.BackendError, never>
}

export const configuredBackendLayer = <ProviderAuthError>(options: ConfiguredBackendOptions<ProviderAuthError>) => {
  const relayOptions = {
    filename: options.filename,
    workspace: options.workspace,
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.persistedModelRoutes === undefined ? {} : { persistedModelRoutes: options.persistedModelRoutes }),
    ...(options.webSearchCredentials === undefined ? {} : { webSearchCredentials: options.webSearchCredentials }),
    repositories: {
      thread: options.repositoryLayer,
      turn: options.turnRepositoryLayer,
      transcript: options.transcriptRepositoryLayer,
      search: options.threadSearchRepositoryLayer,
      interaction: options.threadInteractionRepositoryLayer,
    },
    threadToolGateway: options.threadToolGateway,
    providerAuthLayer: options.providerAuthLayer,
    ...(options.resolveLegacyRoute === undefined ? {} : { resolveLegacyRoute: options.resolveLegacyRoute }),
    toolRuntimeLayerForWorkspace: options.toolRuntimeLayerForWorkspace,
  }
  const relayLayer = pipe(relayOptions, RelayExecution.execution.configuredLayer, Layer.orDie)
  return Layer.effectContext(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const built = yield* Effect.exit(Layer.buildWithScope(relayLayer, scope))
      if (Exit.isFailure(built))
        return yield* ExecutionBackend.BackendError.make({ message: Cause.pretty(built.cause) })
      return built.value
    }),
  )
}

const executionModelRoutes = RelayExecution.execution.modelRoutes
export const execution = {
  ...RelayExecution.execution,
  executionModelRoutes,
  resolveExecutionWorkspace,
}
export { executionModelRoutes }
export { resolveExecutionWorkspace, validateWebSearchProviders }
