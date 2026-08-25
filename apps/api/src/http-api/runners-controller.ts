import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ExecutorAssignmentId } from "@rika/product/hosted-model"
import type { HttpDependencies } from "../http"
import { websocketUrl } from "../websocket-url"
import { RikaApi } from "./contract"
import {
  CurrentAccess,
  Unauthorized,
  Forbidden,
  NotFound,
  Conflict,
  ServiceUnavailable,
  authenticatedPrincipal,
} from "./access"

export const runnersHandlers = (dependencies: HttpDependencies) =>
  HttpApiBuilder.group(RikaApi, "runners", (handlers) =>
    handlers.handleAll({
      issueThreadTicket: () =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.threads === undefined)
            return yield* ServiceUnavailable.make({ message: "Hosted Thread service unavailable" })
          const serverRequest = yield* HttpServerRequest.HttpServerRequest
          const request = yield* HttpServerRequest.toWeb(serverRequest).pipe(
            Effect.mapError(() => ServiceUnavailable.make({ message: "Request is unavailable" })),
          )
          const issued = yield* dependencies.threads
            .issueTicket(authenticatedPrincipal(access))
            .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "Thread ticket issuance failed" })))
          return {
            ...issued,
            websocketUrl: websocketUrl("/api/v1/threads/socket", request.url),
            protocol: "rika.thread.v1" as const,
          }
        }),
      admitRunner: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          const serverRequest = yield* HttpServerRequest.HttpServerRequest
          const request = yield* HttpServerRequest.toWeb(serverRequest).pipe(
            Effect.mapError(() => ServiceUnavailable.make({ message: "Request is unavailable" })),
          )
          return yield* dependencies.executor
            .admitRunner({
              threadId: params.threadId,
              workspaceFingerprint: payload.workspace_fingerprint,
              executorUrl: websocketUrl("/api/v1/runners", request.url),
              principal: authenticatedPrincipal(access),
            })
            .pipe(
              Effect.mapError((error) => {
                if (error.kind === "assignment-missing") return NotFound.make({ message: "Thread is unavailable" })
                if (error.kind === "assignment-conflict" || error.kind === "fenced")
                  return Conflict.make({ message: "Runner admission is unavailable" })
                return Forbidden.make({ message: "Runner admission was rejected" })
              }),
            )
        }),
      registerRunner: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          yield* dependencies.product
            .registerRunner({
              principal: authenticatedPrincipal(access),
              checkoutFingerprint: params.checkoutFingerprint,
              registration: payload,
            })
            .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "Runner registration failed" })))
        }),
      setRemoteThreadCreation: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          yield* dependencies.product
            .setRemoteThreadCreation({
              principal: authenticatedPrincipal(access),
              checkoutFingerprint: params.checkoutFingerprint,
              preference: payload,
            })
            .pipe(
              Effect.mapError((error) =>
                error.kind === "not-found"
                  ? NotFound.make({ message: error.message })
                  : ServiceUnavailable.make({ message: "Runner preference failed" }),
              ),
            )
        }),
      pollRunner: ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          const principal = authenticatedPrincipal(access)
          const candidate = yield* dependencies.product
            .pollRunner({
              principal,
              checkoutFingerprint: params.checkoutFingerprint,
              supervisorId: payload.supervisorId,
              activeAssignmentIds: payload.activeAssignmentIds,
            })
            .pipe(Effect.mapError(() => ServiceUnavailable.make({ message: "Runner polling failed" })))
          if (!candidate.claimed)
            return { _tag: "Waiting" as const, reason: "runner-owned" as const }
          if (candidate.assignment === undefined)
            return { _tag: "Waiting" as const, reason: "no-work" as const }
          const assignment = candidate.assignment
          if (assignment.resume) {
            if (assignment.leaseExpiresAt === null)
              return yield* ServiceUnavailable.make({ message: "Runner lease is unavailable" })
            return {
              _tag: "Resume" as const,
              assignmentId: ExecutorAssignmentId.make(assignment.assignmentId),
              leaseExpiresAt: assignment.leaseExpiresAt,
            }
          }
          const serverRequest = yield* HttpServerRequest.HttpServerRequest
          const request = yield* HttpServerRequest.toWeb(serverRequest).pipe(
            Effect.mapError(() => ServiceUnavailable.make({ message: "Request is unavailable" })),
          )
          const admission = yield* dependencies.executor
            .admitRunner({
              threadId: assignment.threadId,
              workspaceFingerprint: params.checkoutFingerprint,
              executorUrl: websocketUrl("/api/v1/runners", request.url),
              principal,
            })
            .pipe(Effect.mapError(() => Conflict.make({ message: "Runner admission is unavailable" })))
          return { _tag: "Admitted" as const, ...admission }
        }),
    }),
  )
