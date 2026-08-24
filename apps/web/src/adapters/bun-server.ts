import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { handleRequest, type WebDependencies } from "../http"

export const serveWeb = (input: { readonly port: number; readonly dependencies: WebDependencies }) =>
  Effect.gen(function* () {
    const server = yield* BunHttpServer.make({ hostname: "0.0.0.0", port: input.port })
    yield* server.serve(
      Effect.gen(function* () {
        const serverRequest = yield* HttpServerRequest.HttpServerRequest
        const request = yield* HttpServerRequest.toWeb(serverRequest)
        return HttpServerResponse.fromWeb(yield* handleRequest({ request, dependencies: input.dependencies }))
      }),
    )
  })
