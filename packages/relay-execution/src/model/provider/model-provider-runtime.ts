import * as ModelRoute from "@rika/configuration/model-route"
import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
export interface RuntimeModelRoute {
  readonly role:
    | "main"
    | "oracle"
    | "title"
    | "compaction"
    | "librarian"
    | "painter"
    | "review"
    | "readThread"
    | "surgeon"
    | "task"
  readonly alias: string
  readonly provider: string
  readonly model: string
  readonly registrationKey: string
  readonly providerProtocol: string
  readonly providerBaseUrl: string
  readonly providerApiKeyEnv?: string
  readonly providerRuntime?: {
    readonly adapter: string
    readonly credentialIdentity?: string
    readonly connectionIdentity?: Readonly<Record<string, string>>
  }
  readonly openAiAccountFingerprint?: string
  readonly effort: string
  readonly fast: boolean
  readonly requestVariant: string
  readonly providerOptions?: Readonly<Record<string, unknown>>
  readonly compaction: {
    readonly contextWindow: number
    readonly reserveTokens: number
    readonly keepRecentTokens: number
  }
}
import { Compaction, ModelRegistry } from "@batonfx/core"
export { TestModel } from "@batonfx/test"
import * as Anthropic from "@batonfx/providers/anthropic"
export { Anthropic }
import * as AmazonBedrock from "@batonfx/providers/amazon-bedrock"
import * as OpenAi from "@batonfx/providers/openai"
export { OpenAi }
export { ModelRegistry } from "@batonfx/core"
import * as OpenAiAuth from "@rika/product/openai-auth-service"
import { Context, Deferred, Effect, Function, Layer, Ref, Schema, Scope, Semaphore } from "effect"
import { createHash } from "node:crypto"

export type ModelRegistration = ModelRegistry.Registration

export const runtimeRouteFromSnapshot = (
  route: import("@rika/product/execution-route-snapshot").ExecutionRouteModelSnapshot,
): RuntimeModelRoute => ({
  role: route.role,
  alias: route.alias,
  provider: route.providerConnection.provider,
  model: route.model,
  registrationKey: route.registrationIdentity,
  providerProtocol: route.providerConnection.protocol,
  providerBaseUrl: route.providerConnection.baseUrl,
  ...(route.providerConnection.apiKeyEnvironment === undefined
    ? {}
    : { providerApiKeyEnv: route.providerConnection.apiKeyEnvironment }),
  ...(route.providerConnection.authentication === "account" && route.providerConnection.credentialIdentity !== undefined
    ? { openAiAccountFingerprint: route.providerConnection.credentialIdentity }
    : {}),
  effort: route.effort,
  fast: route.fast,
  requestVariant: route.requestVariant,
  ...(route.providerOptions === undefined ? {} : { providerOptions: route.providerOptions }),
  compaction: route.compaction,
})
export type ModelSelection = ModelRegistry.ModelSelection
export type CompactionOptions = Compaction.DefaultOptions
import * as BedrockAuthRefresh from "./bedrock-auth-refresh"
import { ProviderAdapters, type Adapter as ProviderAdapter } from "./provider-adapters"
const { adapters, authRefreshFingerprint, canonical, normalizePinnedRuntime, unavailableRestore } = ProviderAdapters
type Adapter = ProviderAdapter
export const bedrockAuthRefreshService = BedrockAuthRefresh.Service
export const bedrockAuthRefreshLiveLayer = BedrockAuthRefresh.liveLayer
export const bedrockAuthRefreshTestLayer = BedrockAuthRefresh.testLayer

export interface ProviderRuntimePin {
  readonly adapter: string
  readonly credentialIdentity?: string
  readonly connectionIdentity?: Readonly<Record<string, string>>
}

export class RuntimeError extends Schema.TaggedErrorClass<RuntimeError>()("ModelProviderRuntimeError", {
  message: Schema.String,
}) {}

interface Account {
  readonly fingerprint: string
  readonly auth: OpenAiAuth.ServiceInterface
}

export const normalizedBaseUrl = (value: string) => {
  const url = new URL(value)
  url.hash = ""
  url.pathname = url.pathname.replace(/\/+$/, "") || "/"
  return url.toString().replace(/\/(?=\?|$)/, "")
}

export const isNativeOpenAiRoute = (route: ModelRouteResolution.ResolvedModelRoute) =>
  route.providerId === "openai" &&
  route.providerConnection.protocol === "openai" &&
  normalizedBaseUrl(route.providerConnection.baseUrl!) ===
    normalizedBaseUrl(SettingsDefaults.Defaults.defaults.providers.openai!.baseUrl!)

const accountStatus = (auth: OpenAiAuth.ServiceInterface) =>
  auth.status.pipe(
    Effect.flatMap((status) => {
      if (status._tag === "Present" || status._tag === "RefreshRequired")
        return Effect.succeed({ fingerprint: status.fingerprint, auth })
      if (status._tag === "Unauthenticated") return Effect.void.pipe(Effect.as(undefined as Account | undefined))
      return Effect.fail(
        RuntimeError.make({ message: "OpenAI account credentials are corrupt; log out, then log in again" }),
      )
    }),
    Effect.mapError((error) =>
      Schema.is(RuntimeError)(error)
        ? error
        : RuntimeError.make({ message: "OpenAI account credentials could not be read" }),
    ),
  )

export interface PreparedRoutes {
  readonly routes: ReadonlyArray<ModelRouteResolution.ResolvedModelRoute>
  readonly plans: ReadonlyArray<ReturnType<typeof plan>>
  readonly registrations: ReadonlyArray<ModelRegistry.Registration>
}

const plan = (route: ModelRouteResolution.ResolvedModelRoute, adapter: Adapter, account?: Account) => {
  const runtime = adapter.resolve(route, account)
  const options = adapter.options(route)
  const registrationKey = `sha256:${createHash("sha256")
    .update(
      canonical({
        adapter: runtime.adapter,
        credentialIdentity: runtime.credentialIdentity,
        provider: route.providerId,
        connection:
          runtime.connectionIdentity ??
          (route.providerConnection.protocol === "amazon-bedrock"
            ? {}
            : { baseUrl: normalizedBaseUrl(route.providerConnection.baseUrl) }),
        model: route.model,
        effort: route.effort,
        fast: route.fast,
        options,
      }),
    )
    .digest("hex")}`
  return {
    registrationKey,
    selection: { provider: route.providerId, model: route.model, registrationKey },
    compaction: {
      contextWindow: route.compaction.contextWindow ?? SettingsDefaults.Defaults.defaultCompaction.contextWindow,
      reserveTokens: route.compaction.reserveTokens ?? SettingsDefaults.Defaults.defaultCompaction.reserveTokens,
      keepRecentTokens:
        route.compaction.keepRecentTokens ?? SettingsDefaults.Defaults.defaultCompaction.keepRecentTokens,
    } satisfies Compaction.DefaultOptions,
    runtime,
    providerRuntime: runtime,
    options,
  }
}

const purePlan = (route: ModelRouteResolution.ResolvedModelRoute, fingerprint?: string) => {
  const available = adapters({} as OpenAiAuth.ServiceInterface)
  const adapter =
    fingerprint !== undefined && isNativeOpenAiRoute(route)
      ? available.find((candidate) => candidate.id === "openai-account")!
      : available.find((candidate) => candidate.id === route.providerConnection.protocol)!
  return plan(
    route,
    adapter,
    fingerprint === undefined ? undefined : { fingerprint, auth: {} as OpenAiAuth.ServiceInterface },
  )
}

export const modelRoutePlan = Function.dual((args) => typeof args[0] === "object", purePlan) as {
  (route: ModelRouteResolution.ResolvedModelRoute, fingerprint?: string): ReturnType<typeof plan>
  (fingerprint?: string): (route: ModelRouteResolution.ResolvedModelRoute) => ReturnType<typeof plan>
}
export const providerRuntimePin = Function.dual(
  (args) => typeof args[0] === "object",
  (route: ModelRouteResolution.ResolvedModelRoute, fingerprint?: string) => purePlan(route, fingerprint).runtime,
) as {
  (route: ModelRouteResolution.ResolvedModelRoute, fingerprint?: string): ProviderRuntimePin
  (fingerprint?: string): (route: ModelRouteResolution.ResolvedModelRoute) => ProviderRuntimePin
}
export const requestOptions = Function.dual(
  (args) => typeof args[0] === "object",
  (route: ModelRouteResolution.ResolvedModelRoute, fingerprint?: string) => purePlan(route, fingerprint).options,
) as {
  (route: ModelRouteResolution.ResolvedModelRoute, fingerprint?: string): Readonly<Record<string, unknown>>
  (fingerprint?: string): (route: ModelRouteResolution.ResolvedModelRoute) => Readonly<Record<string, unknown>>
}

export interface ServiceInterface {
  readonly prepare: (
    routes: ReadonlyArray<ModelRouteResolution.ResolvedModelRoute>,
  ) => Effect.Effect<PreparedRoutes, RuntimeError>
  readonly restore: (
    routes: ReadonlyArray<RuntimeModelRoute>,
  ) => Effect.Effect<ReadonlyArray<ModelRegistry.Registration>, RuntimeError>
  readonly restoreOne: (route: RuntimeModelRoute) => Effect.Effect<ModelRegistry.Registration, RuntimeError>
  readonly normalizePinned: (route: RuntimeModelRoute) => ProviderRuntimePin
}

export class Service extends Context.Service<Service, ServiceInterface>()(
  "@rika/relay-execution/model/provider/model-provider-runtime/Service",
) {
  static readonly layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const auth = yield* OpenAiAuth.Service
      const authRefresh = yield* BedrockAuthRefresh.Service
      const scope = yield* Effect.scope
      const trustedRefreshCommands = new Map<string, ModelRoute.ModelRoute.BedrockAuthRefresh>()
      const refreshes = yield* Ref.make(new Map<string, Deferred.Deferred<void, BedrockAuthRefresh.Failure>>())
      const refresh = (fingerprint: string, command: ModelRoute.ModelRoute.BedrockAuthRefresh) =>
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<void, BedrockAuthRefresh.Failure>()
          const current = yield* Ref.modify(refreshes, (entries) => {
            const existing = entries.get(fingerprint)
            if (existing !== undefined) return [existing, entries] as const
            const updated = new Map(entries)
            updated.set(fingerprint, deferred)
            return [undefined, updated] as const
          })
          if (current !== undefined) return yield* Deferred.await(current)
          return yield* Deferred.complete(deferred, authRefresh.run(command)).pipe(
            Effect.andThen(Deferred.await(deferred)),
            Effect.ensuring(
              Ref.update(refreshes, (entries) => {
                if (entries.get(fingerprint) !== deferred) return entries
                const updated = new Map(entries)
                updated.delete(fingerprint)
                return updated
              }),
            ),
          )
        })
      const bedrockRecovery = (runtime: ProviderRuntimePin): AmazonBedrock.Recovery | undefined => {
        const fingerprint = runtime.connectionIdentity?.authRefreshFingerprint
        if (fingerprint === undefined) return undefined
        const command = trustedRefreshCommands.get(fingerprint)
        return command === undefined
          ? undefined
          : {
              recover: () =>
                refresh(fingerprint, command).pipe(
                  Effect.mapError(() =>
                    AmazonBedrock.RecoveryFailure.make({
                      description: "Amazon Bedrock authentication refresh failed",
                    }),
                  ),
                ),
            }
      }
      const available = adapters(auth, bedrockRecovery)
      const registrationAdmission = yield* Semaphore.make(1)
      const registrationCache = new Map<string, ModelRegistry.Registration>()
      const inScope = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, Scope.Scope, scope)
      const cachedRegistration = (
        key: string,
        acquire: Effect.Effect<ModelRegistry.Registration, RuntimeError, Scope.Scope>,
      ) =>
        registrationAdmission.withPermits(1)(
          Effect.gen(function* () {
            const existing = registrationCache.get(key)
            if (existing !== undefined) return existing
            const registration = yield* inScope(acquire)
            registrationCache.set(key, registration)
            return registration
          }),
        )
      const prepare: ServiceInterface["prepare"] = (routes) =>
        Effect.gen(function* () {
          for (const route of routes) {
            const connection = route.providerConnection
            if (connection.protocol !== "amazon-bedrock" || connection.authRefresh === undefined) continue
            trustedRefreshCommands.set(authRefreshFingerprint(connection.authRefresh), connection.authRefresh)
          }
          const account = routes.some(isNativeOpenAiRoute) ? yield* accountStatus(auth) : undefined
          const resolutions = yield* Effect.forEach(routes, (route) => {
            const adapter = available.find((candidate) => candidate.matchesConfigured(route, account))
            if (adapter === undefined)
              return Effect.fail(
                RuntimeError.make({
                  message: `No model provider adapter supports protocol ${route.providerConnection.protocol} for provider ${route.providerId}`,
                }),
              )
            return Effect.succeed({ route, adapter, plan: plan(route, adapter, account) })
          })
          const distinct = resolutions.filter(
            (item, index, all) =>
              all.findIndex((other) => other.plan.registrationKey === item.plan.registrationKey) === index,
          )
          const registrations = yield* Effect.forEach(
            distinct,
            (item) =>
              cachedRegistration(
                `${item.route.providerId}\0${item.route.model}\0${item.plan.registrationKey}`,
                item.adapter.register(item.route, item.plan, account),
              ),
            { concurrency: 1 },
          )
          return { routes, plans: resolutions.map((item) => item.plan), registrations }
        })
      const restoreOne: ServiceInterface["restoreOne"] = (route) => {
        const runtime = normalizePinnedRuntime(route)
        const adapter = available.find(
          (candidate) => candidate.id === runtime.adapter && candidate.matchesPinned(route),
        )
        return adapter === undefined
          ? unavailableRestore(route)
          : cachedRegistration(
              `${route.provider}\0${route.model}\0${route.registrationKey}`,
              adapter.restore(route, runtime),
            )
      }
      return Service.of({
        prepare,
        normalizePinned: normalizePinnedRuntime,
        restoreOne,
        restore: (routes) =>
          Effect.forEach(
            routes.filter(
              (route, index, all) =>
                route.providerProtocol !== "test" &&
                all.findIndex((other) => other.registrationKey === route.registrationKey) === index,
            ),
            restoreOne,
            { concurrency: 1 },
          ),
      })
    }),
  )
}

export const bypassLayer = Layer.succeed(
  Service,
  Service.of({
    prepare: () => Effect.die("Model provider runtime is unavailable for test models"),
    restore: () => Effect.die("Model provider runtime is unavailable for test models"),
    restoreOne: () => Effect.die("Model provider runtime is unavailable for test models"),
    normalizePinned: normalizePinnedRuntime,
  }),
)
