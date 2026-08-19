import { Effect } from "effect"
import type { IdentityConfig } from "@rika/identity"
import { makeWebRequestHandler, type HttpDependencies } from "../http"

export const serveControlPlane = (input: {
  readonly config: IdentityConfig
  readonly dependencies: HttpDependencies
}) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "0.0.0.0",
        port: input.config.port,
        fetch: makeWebRequestHandler(input.dependencies),
      }),
    ),
    (server) => Effect.promise(() => server.stop(true)).pipe(Effect.asVoid),
  )
