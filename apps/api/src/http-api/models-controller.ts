import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { HttpDependencies } from "../http"
import { RikaApi } from "./contract"
import {
  CurrentAccess,
  Unauthorized,
  ServiceUnavailable,
  authenticatedPrincipal,
  hostedOwner,
  providerCredentialFailure,
} from "./access"

export const modelsHandlers = (dependencies: HttpDependencies) =>
  HttpApiBuilder.group(RikaApi, "models", (handlers) =>
    handlers.handleAll({
      models: () =>
        dependencies.models === undefined
          ? Effect.fail(ServiceUnavailable.make({ message: "Model registry unavailable" }))
          : Effect.succeed({ modes: [...dependencies.models.modes] }),
      putProviderCredential: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined) {
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          }
          if (dependencies.credentials === undefined) {
            return yield* ServiceUnavailable.make({ message: "Provider credential service unavailable" })
          }
          return yield* dependencies.credentials
            .put({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(access)(payload.owner),
              provider: params.provider,
              apiKey: payload.api_key,
            })
            .pipe(Effect.mapError(providerCredentialFailure))
        }),
      revokeProviderCredential: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined) {
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          }
          if (dependencies.credentials === undefined) {
            return yield* ServiceUnavailable.make({ message: "Provider credential service unavailable" })
          }
          return yield* dependencies.credentials
            .revoke({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(access)(payload.owner),
              provider: params.provider,
            })
            .pipe(Effect.mapError(providerCredentialFailure))
        }),
      listProviderCredentials: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined) {
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          }
          if (dependencies.credentials === undefined) {
            return yield* ServiceUnavailable.make({ message: "Provider credential service unavailable" })
          }
          const credentials = yield* dependencies.credentials
            .list({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(access)(payload.owner),
            })
            .pipe(Effect.mapError(providerCredentialFailure))
          return { credentials: [...credentials] }
        }),
      putOpenAiAccount: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined) {
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          }
          if (dependencies.credentials === undefined) {
            return yield* ServiceUnavailable.make({ message: "Provider credential service unavailable" })
          }
          return yield* dependencies.credentials
            .putOpenAiAccount({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(access)(payload.owner),
              accessToken: payload.access_token,
              idToken: payload.id_token,
              refreshToken: payload.refresh_token,
            })
            .pipe(Effect.mapError(providerCredentialFailure))
        }),
      getOpenAiAccount: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined) {
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          }
          if (dependencies.credentials === undefined) {
            return yield* ServiceUnavailable.make({ message: "Provider credential service unavailable" })
          }
          return yield* dependencies.credentials
            .openAiAccountStatus({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(access)(payload.owner),
            })
            .pipe(Effect.mapError(providerCredentialFailure))
        }),
      revokeOpenAiAccount: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined) {
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          }
          if (dependencies.credentials === undefined) {
            return yield* ServiceUnavailable.make({ message: "Provider credential service unavailable" })
          }
          return yield* dependencies.credentials
            .revokeOpenAiAccount({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(access)(payload.owner),
            })
            .pipe(Effect.mapError(providerCredentialFailure))
        }),
    }),
  )
