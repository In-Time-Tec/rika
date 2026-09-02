import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { HttpDependencies } from "../../server/http"
import { ServiceUnavailable } from "../access"
import { RikaApi } from "../contract"

/**
 * `/readyz` answers a bare 503 so probes learn nothing about internals; the failing dependency and
 * its cause go to the log, because otherwise a production readiness failure is indistinguishable
 * from any other.
 */
const readinessCheck = <A, E, R>(dependency: string, check: Effect.Effect<A, E, R>) =>
  check.pipe(
    Effect.tapError((cause) =>
      Effect.logError("readiness.dependency-unavailable").pipe(
        Effect.annotateLogs({ "rika.readiness.dependency": dependency, "rika.error.message": String(cause) }),
      ),
    ),
  )

export const publicHandlers = (dependencies: HttpDependencies) =>
  HttpApiBuilder.group(RikaApi, "public", (handlers) =>
    handlers.handleAll({
      health: () => Effect.succeed({ status: "ok" }),
      ready: () =>
        dependencies.execution.status.pipe(
          Effect.tap((status) => Effect.logDebug("hosted-workers.status", status)),
          Effect.andThen(
            Effect.all([
              readinessCheck("directory", dependencies.directory.ready),
              readinessCheck("product", dependencies.product.ready),
              readinessCheck("executor", dependencies.executor.ready),
              readinessCheck("execution", dependencies.execution.check),
            ]),
          ),
          Effect.as({ status: "ready" }),
          Effect.mapError(() => ServiceUnavailable.make({ message: "API is unavailable" })),
        ),
    }),
  )
