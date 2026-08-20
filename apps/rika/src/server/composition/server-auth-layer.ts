#!/usr/bin/env bun
import * as ProductOperation from "@rika/product/product-operation"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import * as ConfigurationService from "@rika/configuration/configuration-service"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Operation from "@rika/product/product-operation-service"
import * as OpenAiAuth from "@rika/product/openai-auth-service"
import * as ExtensionOperations from "@rika/product/extension-operation"
import * as McpOAuthService from "@rika/extensions/mcp-oauth-service"
import * as SkillRegistry from "@rika/extensions/skill-registry"
import * as WebSearchProvider from "@rika/coding-tools/web-search-provider"
import { FetchHttpClient } from "effect/unstable/http"
import { Context, Effect, Function, Layer, Option, Schema } from "effect"
import { globalPaths, workspacePaths } from "@rika/configuration/configuration-paths"
import * as OpenAiProviderAuth from "../../provider/openai/openai-provider-auth"
import * as OpenRouterProviderAuth from "../../provider/openrouter/openrouter-provider-auth"
import { loadSettingsFile } from "./server-configuration-adapter"
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

export class OperationProductError extends Schema.TaggedError<OperationProductError>()("OperationError", {
  message: Schema.String,
}) {}

export interface ServerProductEnvironment {
  readonly testModelResponse: Option.Option<string>
  readonly testModelScript: Option.Option<string>
  readonly recoveryAbandon: Option.Option<string>
}

export interface ServerProductOptions {
  readonly environment: ServerProductEnvironment
  readonly database: string
  readonly tenetkitDatabase: string
  readonly profileIdentity: string
  readonly globalConfig: string
  readonly workspaceConfig: string
  readonly editor: string | undefined
  readonly authOperations: Operation.AuthOperationOptions
  readonly home: string
  readonly workspaceRoot: string
}

const createExtensionLayerImpl = (home: string, workspace: string) => {
  const globalLayout = globalPaths(home)
  const workspaceLayout = workspacePaths(workspace)
  return Layer.mergeAll(
    ExtensionOperations.layer({
      globalRoot: globalLayout.skills,
      workspaceRoot: workspaceLayout.skills,
      configPath: workspaceLayout.mcpConfig,
      generationsPath: workspaceLayout.extensionGenerations,
    }),
    SkillRegistry.layer,
    McpOAuthService.layer.pipe(
      Layer.provide(McpOAuthService.OAuthHost.hostLayer),
      Layer.provide(McpOAuthService.OAuthHost.tokenStoreLayer(globalLayout.mcpOAuth)),
    ),
  ).pipe(Layer.provide(BunServices.layer), Layer.merge(BunServices.layer), Layer.merge(FetchHttpClient.layer))
}

export const createExtensionLayer: {
  (workspace: string): (home: string) => ReturnType<typeof createExtensionLayerImpl>
  (home: string, workspace: string): ReturnType<typeof createExtensionLayerImpl>
} = Function.dual(2, createExtensionLayerImpl)

const createOpenAiAuthLayerImpl = (database: string, profileIdentity: string) =>
  OpenAiProviderAuth.createLayer(database, profileIdentity)

const createOpenAiAuthLayer: {
  (profileIdentity: string): (database: string) => ReturnType<typeof createOpenAiAuthLayerImpl>
  (database: string, profileIdentity: string): ReturnType<typeof createOpenAiAuthLayerImpl>
} = Function.dual(2, createOpenAiAuthLayerImpl)

export const resolveOpenAiAccountAuth = (authOperations: Operation.AuthOperationOptions) =>
  Layer.build(authOperations.layer).pipe(
    Effect.map((context) => Context.get(context, OpenAiAuth.Service)),
    Effect.mapError((error) => OperationProductError.make({ message: error.message })),
  )

const createOpenRouterAuthLayerImpl = (database: string, profileIdentity: string) =>
  OpenRouterProviderAuth.createLayer(database, profileIdentity)

const createOpenRouterAuthLayer: {
  (profileIdentity: string): (database: string) => ReturnType<typeof createOpenRouterAuthLayerImpl>
  (database: string, profileIdentity: string): ReturnType<typeof createOpenRouterAuthLayerImpl>
} = Function.dual(2, createOpenRouterAuthLayerImpl)

export const createProviderCredentialStoreLayer: {
  (profileIdentity: string): (database: string) => ReturnType<typeof OpenRouterProviderAuth.credentialStoreLayer>
  (database: string, profileIdentity: string): ReturnType<typeof OpenRouterProviderAuth.credentialStoreLayer>
} = Function.dual(2, (database: string, profileIdentity: string) =>
  OpenRouterProviderAuth.credentialStoreLayer(database, profileIdentity),
)

export const createAuthOperations = (options: {
  readonly globalConfig: string
  readonly database: string
  readonly profileIdentity: string
}): Operation.AuthOperationOptions => ({
  layer: createOpenAiAuthLayer(options.database, options.profileIdentity),
  openRouterLayer: createOpenRouterAuthLayer(options.database, options.profileIdentity),
  assertOpenAiDirect: (workspace) =>
    Effect.gen(function* () {
      const globalSettings = yield* loadSettingsFile(options.globalConfig)
      const settings = yield* loadSettingsFile(workspacePaths(workspace).settings)
      const workspaceConfigLayer = ConfigurationService.liveConfigurationLayer({
        webProviders: WebSearchProvider.providerRegistry,
        global: globalSettings,
        workspace: settings,
      })
      const resolved = yield* ConfigurationService.effectiveConfiguration().pipe(
        provideLayerScoped(workspaceConfigLayer),
      )
      if (
        resolved.settings.providers.openai?.baseUrl !== SettingsDefaults.Defaults.defaults.providers.openai?.baseUrl
      ) {
        return yield* OperationProductError.make({
          message:
            "OpenAI account login cannot be used while providers.openai.baseUrl is customized; remove the override first",
        })
      }
    }).pipe(
      provideLayerScoped(BunServices.layer),
      Effect.mapError((error) =>
        Schema.is(OperationProductError)(error) ? error : OperationProductError.make({ message: String(error) }),
      ),
    ),
})

const runServerAuthImpl = (
  input: Extract<ProductOperation.Input, { readonly _tag: "Auth" }>,
  options: {
    readonly globalConfig: string
    readonly database: string
    readonly profileIdentity: string
  },
  defaultWorkspace: string,
) => Operation.runAuth(input, createAuthOperations(options), defaultWorkspace)

export const runServerAuth: {
  (
    options: {
      readonly globalConfig: string
      readonly database: string
      readonly profileIdentity: string
    },
    defaultWorkspace: string,
  ): (input: Extract<ProductOperation.Input, { readonly _tag: "Auth" }>) => ReturnType<typeof runServerAuthImpl>
  (
    input: Extract<ProductOperation.Input, { readonly _tag: "Auth" }>,
    options: {
      readonly globalConfig: string
      readonly database: string
      readonly profileIdentity: string
    },
    defaultWorkspace: string,
  ): ReturnType<typeof runServerAuthImpl>
} = Function.dual(3, runServerAuthImpl)
