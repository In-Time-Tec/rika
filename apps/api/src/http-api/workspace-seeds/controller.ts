import { Encoding, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { HttpDependencies } from "../../server/http"
import { RikaApi } from "../contract"
import { CurrentAccess, ServiceUnavailable, Unauthorized, Unprocessable, authenticatedPrincipal } from "../access"

export const workspaceSeedsHandlers = (dependencies: HttpDependencies) =>
  HttpApiBuilder.group(RikaApi, "workspaceSeeds", (handlers) =>
    handlers.handleAll({
      stageWorkspaceSeed: ({ headers, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess
          if (access.deviceId === undefined || access.principal.clientId === undefined)
            return yield* Unauthorized.make({ message: "CLI device authentication required" })
          if (dependencies.workspaceSeeds === undefined)
            return yield* ServiceUnavailable.make({ message: "Workspace seed service unavailable" })
          const source = headers["x-rika-source-repository"]?.split("/")
          const sourceRepository = source === undefined ? null : { owner: source[0]!, name: source[1]! }
          return yield* dependencies.workspaceSeeds
            .stage({
              principal: authenticatedPrincipal(access),
              sourceRepository,
              archive: {
                content: Encoding.encodeBase64(payload),
                contentDigest: headers["x-rika-content-digest"],
                sizeBytes: payload.byteLength,
              },
            })
            .pipe(
              Effect.mapError((error) =>
                error.kind === "invalid"
                  ? Unprocessable.make({ message: error.message })
                  : ServiceUnavailable.make({ message: error.message }),
              ),
            )
        }),
    }),
  )
