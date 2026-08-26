import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { HttpDependencies } from "../../server/http"
import { RikaApi } from "../contract"
import {
  CurrentAccess,
  Unauthorized,
  ServiceUnavailable,
  authenticatedPrincipal,
  hostedOwner,
  environmentFailure,
} from "../access"

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
          const input = {
            principal: authenticatedPrincipal(access),
            owner: hostedOwner(access)(payload.owner),
            scope: payload.scope,
            name: params.name,
            classification: payload.classification,
            phases: payload.phases,
            value: payload.value,
          }
          if (payload.project_id !== undefined) Object.assign(input, { projectId: payload.project_id })
          return yield* dependencies.environment.put(input).pipe(Effect.mapError(environmentFailure))
        }),
      revokeEnvironment: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          const input = {
            principal: authenticatedPrincipal(access),
            owner: hostedOwner(access)(payload.owner),
            scope: payload.scope,
            name: params.name,
          }
          if (payload.project_id !== undefined) Object.assign(input, { projectId: payload.project_id })
          return yield* dependencies.environment.revoke(input).pipe(Effect.mapError(environmentFailure))
        }),
      putEnvironmentPolicy: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          const input = {
            principal: authenticatedPrincipal(access),
            owner: hostedOwner(access)(payload.owner),
            personalOverrides: payload.personal_overrides,
          }
          if (payload.project_id !== undefined) Object.assign(input, { projectId: payload.project_id })
          yield* dependencies.environment.putOrganizationPolicy(input).pipe(Effect.mapError(environmentFailure))
        }),
      approveEnvironmentSource: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          const input = {
            principal: authenticatedPrincipal(access),
            owner: hostedOwner(access)(payload.owner),
            sourceOwner: payload.source_owner,
            sourceCommitSha: payload.source_commit_sha,
            phase: payload.phase,
          }
          if (payload.project_id !== undefined) Object.assign(input, { projectId: payload.project_id })
          return yield* dependencies.environment.approveSource(input).pipe(Effect.mapError(environmentFailure))
        }),
      revokeEnvironmentSource: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          const input = {
            principal: authenticatedPrincipal(access),
            owner: hostedOwner(access)(payload.owner),
            sourceOwner: payload.source_owner,
            sourceCommitSha: payload.source_commit_sha,
            phase: payload.phase,
          }
          if (payload.project_id !== undefined) Object.assign(input, { projectId: payload.project_id })
          return yield* dependencies.environment.revokeSourceApproval(input).pipe(Effect.mapError(environmentFailure))
        }),
      putEgress: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.environment === undefined)
            return yield* ServiceUnavailable.make({ message: "Environment service unavailable" })
          const input = {
            principal: authenticatedPrincipal(access),
            owner: hostedOwner(access)(payload.owner),
            phase: params.phase,
            allow: payload.allow,
          }
          if (payload.project_id !== undefined) Object.assign(input, { projectId: payload.project_id })
          return yield* dependencies.environment.putEgress(input).pipe(Effect.mapError(environmentFailure))
        }),
    }),
  )
