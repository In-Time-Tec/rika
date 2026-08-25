import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { HttpDependencies } from "../http"
import { ServiceUnavailable } from "./access"
import { RikaApi } from "./contract"

export const publicHandlers = (dependencies: HttpDependencies) =>
  HttpApiBuilder.group(RikaApi, "public", (handlers) =>
    handlers.handleAll({
      health: () => Effect.succeed({ status: "ok" }),
      ready: () =>
        dependencies.execution.status.pipe(
          Effect.tap((status) => Effect.logInfo("hosted-workers.status", status)),
          Effect.andThen(
            Effect.all([
              dependencies.directory.ready,
              dependencies.product.ready,
              dependencies.executor.ready,
              dependencies.execution.check,
            ]),
          ),
          Effect.as({ status: "ready" }),
          Effect.mapError(() => ServiceUnavailable.make({ message: "API is unavailable" })),
        ),
    }),
  )
