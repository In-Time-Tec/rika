import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { HttpDependencies } from "../http"
import { RikaApi } from "./contract"
import {
  CurrentAccess,
  Unauthorized,
  Forbidden,
  NotFound,
  Conflict,
  Unprocessable,
  ServiceUnavailable,
  authenticatedPrincipal,
} from "./access"

export const publicationHandlers = (dependencies: HttpDependencies) =>
  HttpApiBuilder.group(RikaApi, "publication", (handlers) =>
    handlers.handleAll({
      publishRepository: ({ headers, params, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.publication === undefined)
            return yield* ServiceUnavailable.make({ message: "Repository publication service unavailable" })
          const result = yield* dependencies.publication
            .publish({
              principal: authenticatedPrincipal(access),
              threadId: params.threadId,
              idempotencyKey: headers["idempotency-key"],
              commitSha: payload.commit_sha,
              ...(payload.target_branch === undefined ? {} : { targetRef: payload.target_branch }),
              title: payload.title,
              body: payload.body,
            })
            .pipe(
              Effect.mapError((error) => {
                if (error.kind === "missing") return NotFound.make({ message: error.message })
                if (error.kind === "forbidden") return Forbidden.make({ message: error.message })
                if (error.kind === "conflict") return Conflict.make({ message: error.message })
                if (error.kind === "invalid") return Unprocessable.make({ message: error.message })
                return ServiceUnavailable.make({ message: error.message })
              }),
            )
          return {
            publicationId: result.id,
            state: result.state,
            branch: result.sourceBranch,
            ref: result.sourceRef,
            commitSha: result.sourceCommitSha,
            targetBranch: result.target.ref,
            targetCommitSha: result.target.commitSha,
            targetProtected: result.target.protected,
            pushResult: result.pushResult,
            pullRequestResult: result.pullRequestResult,
          }
        }),
    }),
  )
