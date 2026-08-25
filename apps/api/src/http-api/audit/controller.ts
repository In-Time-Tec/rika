import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { HttpDependencies } from "../../server/http"
import { RikaApi } from "../contract"
import { CurrentAccess, Forbidden, ServiceUnavailable, hostedOwner } from "../access"

export const auditHandlers = (dependencies: HttpDependencies) =>
  HttpApiBuilder.group(RikaApi, "audit", (handlers) =>
    handlers.handleAll({
      listToolAudit: ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          const records = yield* dependencies.toolPolicy
            .list({
              principal: { userId: access.principal.userId },
              owner: hostedOwner(access)(payload.owner),
              limit: payload.limit ?? 100,
            })
            .pipe(
              Effect.mapError((error) =>
                error.kind === "forbidden"
                  ? Forbidden.make({ message: "Audit owner is unavailable" })
                  : ServiceUnavailable.make({ message: "Tool audit service unavailable" }),
              ),
            )
          return { records: [...records] }
        }),
    }),
  )
