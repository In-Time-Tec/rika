import { Effect } from "effect"
import { handleRequest, type WebDependencies } from "../http"

export const serveWeb = (input: { readonly port: number; readonly dependencies: WebDependencies }) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "0.0.0.0",
        port: input.port,
        fetch: (request) => Effect.runPromise(handleRequest({ request, dependencies: input.dependencies })),
      }),
    ),
    (server) => Effect.promise(() => server.stop()),
  )
