import { Effect } from "effect"
import type { IdentityConfig } from "@rika/identity"
import type { HttpDependencies } from "./http"

export const browserThreadWebSocketPath = "/api/v1/threads/browser-socket"

export const browserReviewConnection = (input: {
  readonly request: Request
  readonly config: IdentityConfig
  readonly dependencies: HttpDependencies
}) =>
  Effect.gen(function* () {
    const { request, config, dependencies } = input
    if (request.method !== "GET") return yield* Effect.fail(new Response("Method not allowed", { status: 405 }))
    const origin = request.headers.get("origin")
    if (
      origin === null ||
      origin === "null" ||
      ![new URL(config.baseUrl).origin, ...config.trustedOrigins].includes(origin)
    )
      return yield* Effect.fail(new Response("Browser origin rejected", { status: 403 }))
    if (request.headers.get("sec-websocket-protocol") !== "rika.thread.v1" || dependencies.threads === undefined)
      return yield* Effect.fail(new Response("WebSocket authentication required", { status: 401 }))
    const session = yield* dependencies.identity
      .browserSession(request)
      .pipe(Effect.mapError(() => new Response("Browser authentication required", { status: 401 })))
    if (session === undefined)
      return yield* Effect.fail(new Response("Browser authentication required", { status: 401 }))
    return yield* dependencies.threads
      .connectBrowser({
        _tag: "BrowserRead",
        userId: session.userId,
        validate: session.validate.pipe(Effect.orElseSucceed(() => false)),
      })
      .pipe(Effect.mapError(() => new Response("Browser authentication required", { status: 401 })))
  })
