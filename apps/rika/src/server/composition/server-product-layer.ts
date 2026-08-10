#!/usr/bin/env bun
import * as ProductOperation from "@rika/product/product-operation"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as ServerFeed from "@rika/product/server-interactive-feed"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Operation from "@rika/product/product-operation-service"
import { Cause, Context, Effect, Function, Layer, Option } from "effect"
import { lazyBackendLayer } from "./lazy-execution-backend"
import { workspacePaths } from "@rika/configuration/configuration-paths"
import * as ServerConfiguration from "./server-configuration-adapter"
import * as ServerExecution from "./server-execution-layer"
import { kernelPoolFor, pinnedCapabilities } from "./server-pinned-capabilities"
import * as ServerAuth from "./server-auth-layer"
import { resolvedContextLayer, workspaceExecutionRoute } from "./server-execution-route"
import type { ServerProductOptions } from "./server-auth-layer"
import * as ServerRepository from "./server-repository-layer"
import * as GoalService from "@rika/product/goal-service"
import * as ThreadQuery from "@rika/product/thread-query-service"
import { makeAgentServices } from "./server-agent-services"
import { defaultWorkspaceToolRuntimeLayer } from "./server-runtime-tools"

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

const { loadSettingsFile, workspaceGlob } = ServerConfiguration
const { configuredBackendLayer } = ServerExecution
const { createExtensionLayer } = ServerAuth

const createOperationLayerImpl = (
  options: ServerProductOptions,
  injectedInteractive: (
    input: ServerFeed.InteractiveInput,
    session: InteractiveSession.InteractiveSession,
  ) => Effect.Effect<void, ProductOperation.OperationUnavailable>,
) => {
  const { environment, database, globalConfig, workspaceConfig, editor, authOperations, home, workspaceRoot } = options
  const extensionLayer = createExtensionLayer(home, workspaceRoot)
  const {
    repositoryLayer,
    turnRepositoryLayer,
    threadSummaryRepositoryLayer,
    threadSearchRepositoryLayer,
    transcriptRepositoryLayer,
    goalRepositoryLayer,
  } = ServerRepository.makeServerRepositoryLayers(database)
  const contextLayer = resolvedContextLayer(workspaceGlob)
  return Layer.unwrap(
    Effect.gen(function* () {
      const globalSettings = yield* loadSettingsFile(globalConfig)
      const workspaceSettings = yield* loadSettingsFile(workspaceConfig)
      const applicationConfigLayer = ServerConfiguration.route.configurationService.liveConfigurationLayer({
        webProviders: ServerConfiguration.route.webSearchProviderRegistry,
        global: globalSettings,
        workspace: workspaceSettings,
      })
      const effectiveConfigForWorkspace = (workspace: string) =>
        Effect.gen(function* () {
          const settings = yield* loadSettingsFile(workspacePaths(workspace).settings)
          return yield* ServerConfiguration.route.configurationService.effectiveConfiguration().pipe(
            provideLayerScoped(
              ServerConfiguration.route.configurationService.liveConfigurationLayer({
                webProviders: ServerConfiguration.route.webSearchProviderRegistry,
                global: globalSettings,
                workspace: settings,
              }),
            ),
          )
        }).pipe(
          provideLayerScoped(BunServices.layer),
          Effect.mapError((error) => ServerAuth.OperationProductError.make({ message: String(error) })),
        )
      const testModelScript = Option.getOrUndefined(environment.testModelScript)
      const testModelResponse = Option.getOrUndefined(environment.testModelResponse)
      if (testModelScript !== undefined && testModelResponse !== undefined)
        return yield* ServerAuth.OperationProductError.make({
          message: "RIKA_TEST_MODEL_RESPONSE and RIKA_TEST_MODEL_SCRIPT cannot both be set",
        })
      const testModel =
        testModelScript === undefined && testModelResponse === undefined
          ? undefined
          : {
              ...(testModelScript === undefined ? {} : { script: testModelScript }),
              ...(testModelResponse === undefined ? {} : { response: testModelResponse }),
            }
      const resolveRoute = workspaceExecutionRoute({ testModel, effectiveConfigForWorkspace })
      const resolveWorkspaceExecutionRoute = (
        mode: "low" | "medium" | "high" | "ultra",
        tuning: { readonly fastMode?: boolean } | undefined,
        workspace = workspaceRoot,
      ) => resolveRoute(mode, tuning, workspace)
      const repositories = Layer.succeedContext(
        yield* Layer.build(
          Layer.mergeAll(
            repositoryLayer,
            turnRepositoryLayer,
            threadSummaryRepositoryLayer,
            threadSearchRepositoryLayer,
            transcriptRepositoryLayer,
          ),
        ),
      )
      const queryFactory = Layer.succeedContext(
        yield* Layer.build(ThreadQuery.Runtime.factoryLayer.pipe(Layer.provide(repositories))),
      )
      const agentServices = makeAgentServices({ effectiveConfigForWorkspace, queryFactory })
      const goalRepositories = Layer.succeedContext(yield* Layer.build(goalRepositoryLayer))
      const kernelOptions = {
        workspace: workspaceRoot,
        home,
        dataRoot: ServerRepository.dataRootOf(options.batonDatabase),
        runtimeVersion: Bun.version,
        goalRepositoryLayer: goalRepositories,
        queryFactory,
        toolRuntimeLayer: defaultWorkspaceToolRuntimeLayer(workspaceRoot, effectiveConfigForWorkspace),
      }
      /**
       * One pool for the Server, built here rather than inside an Agent environment or a cell.
       * Baton builds a resolved Agent's environment once per Run, and a cell's own scope ends with
       * that cell, so a pool owned by either would be released while later turns still needed it.
       * This scope is the Server's, which is the lifetime the pool actually has.
       */
      const kernelPool = yield* kernelPoolFor(kernelOptions)
      const { harnessSnapshot, skills } = yield* pinnedCapabilities(kernelOptions)
      const backendLayer = configuredBackendLayer({
        filename: options.batonDatabase,
        kernelPool,
        skills,
        harnessSnapshot,
        agentServices,
        credentialStore: ServerAuth.createProviderCredentialStoreLayer(options.database, options.profileIdentity),
        ...(testModel === undefined ? {} : { testModel }),
      })
      const configAdapter = ServerConfiguration.productConfigAdapter(editor)
      const goals = Context.get(
        yield* Layer.build(GoalService.layer.pipe(Layer.provide(goalRepositories))),
        GoalService.GoalService,
      )
      const operationLayer = Operation.productLayer({
        goals,
        repositoryLayer: repositories,
        turnRepositoryLayer: repositories,
        threadSummaryRepositoryLayer: repositories,
        transcriptRepositoryLayer: repositories,
        resolvedContextLayer: contextLayer,
        backendLayer: lazyBackendLayer(backendLayer).pipe(
          Layer.catchCause((cause) =>
            Layer.effectContext(Effect.fail(ServerAuth.OperationProductError.make({ message: Cause.pretty(cause) }))),
          ),
        ),
        resolveExecutionRoute: (...arguments_) =>
          resolveWorkspaceExecutionRoute(...arguments_).pipe(
            Effect.mapError((error) =>
              ServerAuth.OperationProductError.make({
                message: error instanceof Error ? error.message : String(error),
              }),
            ),
          ),
        toolRuntimeLayer: (workspace) => defaultWorkspaceToolRuntimeLayer(workspace, effectiveConfigForWorkspace),
        defaultWorkspace: workspaceRoot,
        recoveredWorkGrace: ServerRepository.recoveredWorkGrace(
          environment.recoveryAbandon._tag === "Some" ? environment.recoveryAbandon.value : "15000",
        ),
        makeThreadId: ServerRepository.makeThreadId,
        makeTurnId: ServerRepository.makeTurnId,
        configOperations: {
          layer: Layer.merge(configAdapter, applicationConfigLayer).pipe(
            Layer.provide(BunServices.layer),
            Layer.merge(BunServices.layer),
            Layer.catchCause((cause) =>
              Layer.effectContext(Effect.fail(ServerAuth.OperationProductError.make({ message: Cause.pretty(cause) }))),
            ),
          ),
          options: {
            globalConfigPath: globalConfig,
            workspaceConfigPath: workspaceConfig,
            productDatabasePath: database,
          },
          forWorkspace: (workspace) =>
            Effect.gen(function* () {
              const settings = yield* loadSettingsFile(workspacePaths(workspace).settings)
              return {
                layer: Layer.merge(
                  configAdapter,
                  ServerConfiguration.route.configurationService.liveConfigurationLayer({
                    webProviders: ServerConfiguration.route.webSearchProviderRegistry,
                    global: globalSettings,
                    workspace: settings,
                  }),
                ).pipe(
                  Layer.provide(BunServices.layer),
                  Layer.merge(BunServices.layer),
                  Layer.catchCause((cause) =>
                    Layer.effectContext(
                      Effect.fail(ServerAuth.OperationProductError.make({ message: Cause.pretty(cause) })),
                    ),
                  ),
                ),
                options: {
                  globalConfigPath: globalConfig,
                  workspaceConfigPath: workspacePaths(workspace).settings,
                  productDatabasePath: database,
                },
              }
            }).pipe(
              provideLayerScoped(BunServices.layer),
              Effect.mapError((error) => ServerAuth.OperationProductError.make({ message: String(error) })),
            ),
        },
        extensionOperations: {
          layer: extensionLayer,
        },
        authOperations,
        interactive: injectedInteractive,
      }).pipe(
        Layer.catchCause((cause) =>
          Layer.effectContext(Effect.fail(ServerAuth.OperationProductError.make({ message: Cause.pretty(cause) }))),
        ),
      )
      return operationLayer as Layer.Layer<Operation.Service, ServerAuth.OperationProductError, never>
    }),
  )
}

export const createOperationLayer: {
  (
    injectedInteractive: (
      input: ServerFeed.InteractiveInput,
      session: InteractiveSession.InteractiveSession,
    ) => Effect.Effect<void, ProductOperation.OperationUnavailable>,
  ): (options: ServerProductOptions) => ReturnType<typeof createOperationLayerImpl>
  (
    options: ServerProductOptions,
    injectedInteractive: (
      input: ServerFeed.InteractiveInput,
      session: InteractiveSession.InteractiveSession,
    ) => Effect.Effect<void, ProductOperation.OperationUnavailable>,
  ): ReturnType<typeof createOperationLayerImpl>
} = Function.dual(2, createOperationLayerImpl)
