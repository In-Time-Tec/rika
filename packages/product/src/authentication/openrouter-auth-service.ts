import { Context, Effect, Layer, Option, Redacted } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { OpenRouterAuthError } from "./openrouter-auth-contract"
import { ProviderCredentialStore } from "./provider-credential-store"

export const credentialIdentity = "openrouter"

const validationUrl = "https://openrouter.ai/api/v1/key"

const validateApiKey = (client: HttpClient.HttpClient, apiKey: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const response = yield* client
      .execute(HttpClientRequest.get(validationUrl).pipe(HttpClientRequest.bearerToken(Redacted.value(apiKey))))
      .pipe(
        Effect.mapError(() =>
          OpenRouterAuthError.make({ kind: "network", message: "OpenRouter could not be reached" }),
        ),
      )
    if (response.status >= 200 && response.status < 300) return
    return yield* OpenRouterAuthError.make({
      kind: "invalid-key",
      message: "OpenRouter rejected the API key",
    })
  })

export interface OpenRouterAuthServiceShape {
  readonly login: (apiKey: Redacted.Redacted<string>) => Effect.Effect<void, OpenRouterAuthError>
  readonly status: Effect.Effect<"authenticated" | "unauthenticated" | "corrupt", OpenRouterAuthError>
  readonly logout: Effect.Effect<boolean, OpenRouterAuthError>
}

export class OpenRouterAuthService extends Context.Service<OpenRouterAuthService, OpenRouterAuthServiceShape>()(
  "@rika/product/authentication/openrouter-auth-service/OpenRouterAuthService",
) {}

const storeError = (cause: unknown): OpenRouterAuthError =>
  OpenRouterAuthError.make({ kind: "store", message: cause instanceof Error ? cause.message : String(cause) })

export const layer = Layer.effect(
  OpenRouterAuthService,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const store = yield* ProviderCredentialStore
    const service: OpenRouterAuthServiceShape = {
      login: (apiKey) =>
        validateApiKey(client, apiKey).pipe(
          Effect.flatMap(() => store.save(credentialIdentity, apiKey)),
          Effect.mapError(storeError),
        ),
      status: store.load(credentialIdentity).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            error.kind === "corrupt" ? Effect.succeed("corrupt" as const) : Effect.fail(storeError(error)),
          onSuccess: (entry) =>
            Effect.succeed(Option.isSome(entry) ? ("authenticated" as const) : ("unauthenticated" as const)),
        }),
      ),
      logout: store.remove(credentialIdentity).pipe(Effect.mapError(storeError)),
    }
    return OpenRouterAuthService.of(service)
  }),
)

export const login = Effect.fn("OpenRouterAuthService.login")(function* (apiKey: Redacted.Redacted<string>) {
  const service = yield* OpenRouterAuthService
  return yield* service.login(apiKey)
})

export const status = Effect.fn("OpenRouterAuthService.status")(function* () {
  const service = yield* OpenRouterAuthService
  return yield* service.status
})

export const logout = Effect.fn("OpenRouterAuthService.logout")(function* () {
  const service = yield* OpenRouterAuthService
  return yield* service.logout
})
