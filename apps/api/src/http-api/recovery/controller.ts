import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { HttpDependencies } from "../../server/http"
import type { RecoveryResolution } from "../../hosted/execution/recovery"
import { RikaApi } from "../contract"
import {
  CurrentAccess,
  Unauthorized,
  Forbidden,
  NotFound,
  Conflict,
  Unprocessable,
  ServiceUnavailable,
  authenticatedPrincipal,
} from "../access"

export const recoveryHandlers = (dependencies: HttpDependencies) =>
  HttpApiBuilder.group(RikaApi, "recovery", (handlers) =>
    handlers.handleAll({
      inspectRecovery: ({ params }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          return yield* dependencies.recovery
            .inspect({
              principal: authenticatedPrincipal(access),
              threadId: params.threadId,
              runId: params.runId,
            })
            .pipe(
              Effect.mapError((error) => {
                if (error.kind === "not-found") return NotFound.make({ message: error.message })
                if (error.kind === "forbidden") return Forbidden.make({ message: error.message })
                return ServiceUnavailable.make({ message: error.message })
              }),
            )
        }),
      resolveRecovery: ({ headers, params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          let resolution: RecoveryResolution
          if (payload.action === "retry") resolution = { _tag: "Retry" }
          else if (payload.action === "accept") resolution = { _tag: "Accept", value: payload.value }
          else resolution = { _tag: "Abort", reason: payload.reason }
          return yield* dependencies.recovery
            .resolve({
              principal: authenticatedPrincipal(access),
              threadId: params.threadId,
              runId: params.runId,
              operationId: params.operationId,
              idempotencyKey: headers["idempotency-key"],
              resolution,
            })
            .pipe(
              Effect.mapError((error) => {
                if (error.kind === "not-found") return NotFound.make({ message: error.message })
                if (error.kind === "forbidden") return Forbidden.make({ message: error.message })
                if (error.kind === "conflict") return Conflict.make({ message: error.message })
                if (error.kind === "invalid") return Unprocessable.make({ message: error.message })
                return ServiceUnavailable.make({ message: error.message })
              }),
            )
        }),
    }),
  )
