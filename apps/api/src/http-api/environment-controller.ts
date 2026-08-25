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
  environmentFailure,
} from "./access"

export const environmentHandlers = (dependencies: HttpDependencies) =>
  HttpApiBuilder.group(RikaApi, "environment", (handlers) =>
    handlers.handleAll({
      putEnvironment: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          return yield* dependencies.environment
            .put({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(access)(payload.owner),
              ...(payload.project_id === undefined ? {} : { projectId: payload.project_id }),
              scope: payload.scope,
              name: params.name,
              classification: payload.classification,
              phases: payload.phases,
              value: payload.value,
            })
            .pipe(Effect.mapError(environmentFailure))
        }),
      revokeEnvironment: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          return yield* dependencies.environment
            .revoke({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(access)(payload.owner),
              ...(payload.project_id === undefined ? {} : { projectId: payload.project_id }),
              scope: payload.scope,
              name: params.name,
            })
            .pipe(Effect.mapError(environmentFailure))
        }),
      putEnvironmentPolicy: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          yield* dependencies.environment
            .putOrganizationPolicy({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(access)(payload.owner),
              ...(payload.project_id === undefined ? {} : { projectId: payload.project_id }),
              personalOverrides: payload.personal_overrides,
            })
            .pipe(Effect.mapError(environmentFailure))
        }),
      approveEnvironmentSource: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          return yield* dependencies.environment
            .approveSource({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(access)(payload.owner),
              ...(payload.project_id === undefined ? {} : { projectId: payload.project_id }),
              sourceOwner: payload.source_owner,
              sourceCommitSha: payload.source_commit_sha,
              phase: payload.phase,
            })
            .pipe(Effect.mapError(environmentFailure))
        }),
      revokeEnvironmentSource: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          return yield* dependencies.environment
            .revokeSourceApproval({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(access)(payload.owner),
              ...(payload.project_id === undefined ? {} : { projectId: payload.project_id }),
              sourceOwner: payload.source_owner,
              sourceCommitSha: payload.source_commit_sha,
              phase: payload.phase,
            })
            .pipe(Effect.mapError(environmentFailure))
        }),
      putEgress: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          return yield* dependencies.environment
            .putEgress({
              principal: authenticatedPrincipal(access),
              owner: hostedOwner(access)(payload.owner),
              ...(payload.project_id === undefined ? {} : { projectId: payload.project_id }),
              phase: params.phase,
              allow: payload.allow,
            })
            .pipe(Effect.mapError(environmentFailure))
        }),
    }),
  )
