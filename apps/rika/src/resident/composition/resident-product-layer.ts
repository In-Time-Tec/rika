#!/usr/bin/env bun
import * as ProductOperation from "@rika/product/product-operation"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as ResidentFeed from "@rika/product/resident-interactive-feed"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Operation from "@rika/product/product-operation-service"
import { Cause, Context, Effect, Function, Layer } from "effect"
import { lazyBackendLayer } from "./lazy-execution-backend"
import { workspacePaths } from "@rika/configuration/configuration-paths"
import * as ResidentConfiguration from "./resident-configuration-adapter"
import * as ResidentExecution from "./resident-execution-layer"
import * as ResidentAuth from "./resident-auth-layer"
import type { ResidentProductOptions } from "./resident-auth-layer"
import * as ResidentRepository from "./resident-repository-layer"
import * as ResidentProductContext from "./resident-product-context"
import { resolveLegacyRouteForBackend } from "./resident-execution-recovery"
import { BackendError } from "@rika/product/execution-service"
import * as ThreadToolService from "@rika/product/thread-tool-service"
import * as RelayExecution from "@rika/relay-execution/relay-execution-layer"
import { defaultWorkspaceToolRuntimeLayer } from "./resident-runtime-tools"

const provideLayerScoped =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scopedWith((scope) =>
      Effect.context<RIn | Exclude<R, ROut>>().pipe(
        Effect.flatMap((parent) =>
          Layer.buildWithScope(layer, scope).pipe(
            Effect.flatMap((context) => effect.pipe(Effect.provideContext(Context.merge(parent, context)))),
          ),
        ),
      ),
    )

const { loadSettingsFile, workspaceGlob } = ResidentConfiguration
const { configuredBackendLayer } = ResidentExecution
const { createExtensionLayer } = ResidentAuth

const createOperationLayerImpl = (
  options: ResidentProductOptions,
  injectedInteractive: (
    input: ResidentFeed.InteractiveInput,
    session: InteractiveSession.InteractiveSession,
  ) => Effect.Effect<void, ProductOperation.OperationUnavailable>,
) => {
  const {
    environment,
    database,
    executionDatabase,
    globalConfig,
    workspaceConfig,
    editor,
    authOperations,
    home,
    workspaceRoot,
  } = options
  const extensionLayer = createExtensionLayer(home, workspaceRoot)
  const openAiAuthLayer = authOperations.layer
  const {
    productDatabase,
    repositoryLayer,
    turnRepositoryLayer,
    threadSummaryRepositoryLayer,
    transcriptRepositoryLayer,
    usageRepositoryLayer,
    threadInteractionRepositoryLayer,
    threadSearchRepositoryLayer,
  } = ResidentRepository.makeResidentRepositoryLayers(database, executionDatabase)
  const resolvedContextLayer = ResidentProductContext.layer(workspaceGlob)
  return Layer.unwrap(
    Effect.gen(function* () {
      const threadToolGateway = yield* ThreadToolService.makeGateway
      const globalSettings = yield* loadSettingsFile(globalConfig)
      const workspaceSettings = yield* loadSettingsFile(workspaceConfig)
      const applicationConfigLayer = ResidentConfiguration.route.configurationService.liveConfigurationLayer({
        webProviders: ResidentConfiguration.route.webSearchProviderRegistry,
        global: globalSettings,
        workspace: workspaceSettings,
      })
      const effectiveConfig = yield* ResidentConfiguration.route.configurationService
        .effectiveConfiguration()
        .pipe(provideLayerScoped(applicationConfigLayer))
      const effectiveConfigForWorkspace = (workspace: string) =>
        Effect.gen(function* () {
          const settings = yield* loadSettingsFile(workspacePaths(workspace).settings)
          return yield* ResidentConfiguration.route.configurationService.effectiveConfiguration().pipe(
            provideLayerScoped(
              ResidentConfiguration.route.configurationService.liveConfigurationLayer({
                webProviders: ResidentConfiguration.route.webSearchProviderRegistry,
                global: globalSettings,
                workspace: settings,
              }),
            ),
          )
        }).pipe(
          provideLayerScoped(BunServices.layer),
          Effect.mapError((error) => BackendError.make({ message: String(error) })),
        )
      const workspaceExecutionRoutePlan = (
        mode: "low" | "medium" | "high" | "ultra",
        tuning: { readonly fastMode?: boolean } | undefined,
        workspace = process.cwd(),
      ) =>
        Effect.gen(function* () {
          const resolvedWorkspaceConfig = yield* effectiveConfigForWorkspace(workspace)
          const executionRoute = yield* RelayExecution.execution.routeForSettings(
            resolvedWorkspaceConfig.settings,
            mode,
            tuning,
          )
          return { executionRoute }
        }).pipe(
          provideLayerScoped(BunServices.layer),
          Effect.mapError((error) => BackendError.make({ message: String(error) })),
        )
      const resolveWorkspaceExecutionRoute = (
        mode: "low" | "medium" | "high" | "ultra",
        tuning: { readonly fastMode?: boolean } | undefined,
        workspace = process.cwd(),
      ) =>
        Effect.gen(function* () {
          const resolvedRoute = yield* workspaceExecutionRoutePlan(mode, tuning, workspace)
          return resolvedRoute.executionRoute
        })
      const webSearchCredentials = effectiveConfig.environment.webSearchCredentials
      const repositories = Layer.succeedContext(
        yield* Layer.build(
          Layer.mergeAll(repositoryLayer, turnRepositoryLayer, threadSummaryRepositoryLayer, transcriptRepositoryLayer),
        ),
      )
      const persistedTitleRoutes = yield* ResidentRepository.persistedTitleModelRoutesForStartup.pipe(
        provideLayerScoped(productDatabase.pipe(Layer.provide(BunServices.layer))),
      )
      const persistedModelRoutes = yield* ResidentRepository.allPersistedModelRoutesForStartup(
        persistedTitleRoutes,
      ).pipe(provideLayerScoped(repositories))
      const resolveLegacyRoute = resolveLegacyRouteForBackend({
        resolveWorkspaceExecutionRoute,
        repositories,
      })
      const backendLayer = configuredBackendLayer({
        filename: executionDatabase,
        workspace: process.cwd(),
        repositoryLayer: repositories,
        turnRepositoryLayer: repositories,
        transcriptRepositoryLayer: repositories,
        threadSearchRepositoryLayer,
        threadInteractionRepositoryLayer,
        settings: effectiveConfig.settings,
        persistedModelRoutes,
        webSearchCredentials,
        resolveLegacyRoute,
        threadToolGateway,
        providerAuthLayer: openAiAuthLayer,
        toolRuntimeLayerForWorkspace: (workspace) =>
          defaultWorkspaceToolRuntimeLayer(workspace, effectiveConfigForWorkspace),
      }).pipe(Layer.provide(BunServices.layer))
      const configAdapter = ResidentConfiguration.productConfigAdapter(editor)
      const operationLayer = Operation.productLayer({
        repositoryLayer: repositories,
        turnRepositoryLayer: repositories,
        threadSummaryRepositoryLayer: repositories,
        transcriptRepositoryLayer: repositories,
        usageRepositoryLayer,
        threadInteractionRepositoryLayer,
        threadToolGateway,
        resolvedContextLayer,
        backendLayer: lazyBackendLayer(backendLayer).pipe(
          Layer.catchCause((cause) =>
            Layer.effectContext(Effect.fail(ResidentAuth.OperationProductError.make({ message: Cause.pretty(cause) }))),
          ),
        ),
        resolveExecutionRoute: (...arguments_) =>
          resolveWorkspaceExecutionRoute(...arguments_).pipe(
            Effect.mapError((error) =>
              ResidentAuth.OperationProductError.make({
                message: error instanceof Error ? error.message : String(error),
              }),
            ),
          ),
        toolRuntimeLayer: (workspace) => defaultWorkspaceToolRuntimeLayer(workspace, effectiveConfigForWorkspace),
        defaultWorkspace: process.cwd(),
        recoveredWorkGrace: ResidentRepository.recoveredWorkGrace(
          environment.recoveryAbandon._tag === "Some" ? environment.recoveryAbandon.value : "15000",
        ),
        makeThreadId: ResidentRepository.makeThreadId,
        makeTurnId: ResidentRepository.makeTurnId,
        configOperations: {
          layer: Layer.merge(configAdapter, applicationConfigLayer).pipe(
            Layer.provide(BunServices.layer),
            Layer.merge(BunServices.layer),
            Layer.catchCause((cause) =>
              Layer.effectContext(
                Effect.fail(ResidentAuth.OperationProductError.make({ message: Cause.pretty(cause) })),
              ),
            ),
          ),
          options: {
            globalConfigPath: globalConfig,
            workspaceConfigPath: workspaceConfig,
            productDatabasePath: database,
            executionDatabasePath: executionDatabase,
          },
          forWorkspace: (workspace) =>
            Effect.gen(function* () {
              const settings = yield* loadSettingsFile(workspacePaths(workspace).settings)
              return {
                layer: Layer.merge(
                  configAdapter,
                  ResidentConfiguration.route.configurationService.liveConfigurationLayer({
                    webProviders: ResidentConfiguration.route.webSearchProviderRegistry,
                    global: globalSettings,
                    workspace: settings,
                  }),
                ).pipe(
                  Layer.provide(BunServices.layer),
                  Layer.merge(BunServices.layer),
                  Layer.catchCause((cause) =>
                    Layer.effectContext(
                      Effect.fail(ResidentAuth.OperationProductError.make({ message: Cause.pretty(cause) })),
                    ),
                  ),
                ),
                options: {
                  globalConfigPath: globalConfig,
                  workspaceConfigPath: workspacePaths(workspace).settings,
                  productDatabasePath: database,
                  executionDatabasePath: executionDatabase,
                },
              }
            }).pipe(
              provideLayerScoped(BunServices.layer),
              Effect.mapError((error) => ResidentAuth.OperationProductError.make({ message: String(error) })),
            ),
        },
        extensionOperations: {
          layer: extensionLayer,
        },
        authOperations,
        interactive: injectedInteractive,
      }).pipe(
        Layer.catchCause((cause) =>
          Layer.effectContext(Effect.fail(ResidentAuth.OperationProductError.make({ message: Cause.pretty(cause) }))),
        ),
      )
      return operationLayer as Layer.Layer<Operation.Service, ResidentAuth.OperationProductError, never>
    }),
  )
}

export const createOperationLayer: {
  (
    injectedInteractive: (
      input: ResidentFeed.InteractiveInput,
      session: InteractiveSession.InteractiveSession,
    ) => Effect.Effect<void, ProductOperation.OperationUnavailable>,
  ): (options: ResidentProductOptions) => ReturnType<typeof createOperationLayerImpl>
  (
    options: ResidentProductOptions,
    injectedInteractive: (
      input: ResidentFeed.InteractiveInput,
      session: InteractiveSession.InteractiveSession,
    ) => Effect.Effect<void, ProductOperation.OperationUnavailable>,
  ): ReturnType<typeof createOperationLayerImpl>
} = Function.dual(2, createOperationLayerImpl)
