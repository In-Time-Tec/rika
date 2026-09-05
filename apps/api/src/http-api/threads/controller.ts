import { Effect } from "effect"
import { ThreadId } from "@rika/product/thread-record"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { HttpDependencies } from "../../server/http"
import { RikaApi } from "../contract"
import { CurrentAccess, Forbidden, NotFound, ServiceUnavailable, authenticatedPrincipal, hostedOwner } from "../access"

const authorizationFailure = (error: { readonly kind?: string; readonly message: string }) => {
  if (error.kind === "not-found") return NotFound.make({ message: "Thread is unavailable" })
  if (error.kind === "forbidden") return Forbidden.make({ message: "Thread is unavailable" })
  return ServiceUnavailable.make({ message: "Thread service unavailable" })
}

const ownerAuthorizationFailure = (error: { readonly kind?: string; readonly message: string }) =>
  error.kind === "not-found" || error.kind === "forbidden"
    ? Forbidden.make({ message: "Thread owner is unavailable" })
    : ServiceUnavailable.make({ message: "Thread service unavailable" })

export const threadsHandlers = (dependencies: HttpDependencies) =>
  HttpApiBuilder.group(RikaApi, "thread-list", (handlers) =>
    handlers.handleAll({
      listThreads: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (dependencies.threadApplication === undefined)
            return yield* ServiceUnavailable.make({ message: "Thread service unavailable" })
          const device = access.deviceId !== undefined && access.principal.clientId !== undefined
          const principal = { userId: access.principal.userId }
          const owner = yield* (
            device
              ? dependencies.product.authorizeOwner(authenticatedPrincipal(access), hostedOwner(access)(payload.owner))
              : dependencies.product.authorizeReadOwner(principal, hostedOwner(access)(payload.owner))
          ).pipe(Effect.mapError(ownerAuthorizationFailure))
          const candidates = yield* dependencies.threadApplication
            .threads(owner.ownerId, payload.project_id)
            .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "Thread service unavailable" })))
          const threads = yield* Effect.filter(candidates, (summary) =>
            (device
              ? dependencies.product.authorizeThread(authenticatedPrincipal(access), String(summary.id), "thread:view")
              : dependencies.product.authorizeReadThread(principal, String(summary.id))
            ).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                error.kind === "forbidden" || error.kind === "not-found"
                  ? Effect.succeed(false)
                  : Effect.fail(ServiceUnavailable.make({ message: "Thread service unavailable" })),
              ),
            ),
          )
          return { threads }
        }),
      previewThread: ({ params }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (dependencies.threadApplication === undefined)
            return yield* ServiceUnavailable.make({ message: "Thread service unavailable" })
          const authority = yield* (
            access.deviceId !== undefined && access.principal.clientId !== undefined
              ? dependencies.product.authorizeThread(
                  authenticatedPrincipal(access),
                  String(params.threadId),
                  "thread:view",
                )
              : dependencies.product.authorizeReadThread({ userId: access.principal.userId }, String(params.threadId))
          ).pipe(Effect.mapError(authorizationFailure))
          const units = yield* dependencies.threadApplication
            .preview(authority.ownerId, ThreadId.make(params.threadId))
            .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "Thread preview unavailable" })))
          return { units }
        }),
    }),
  )
