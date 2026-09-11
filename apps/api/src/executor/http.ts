import { Effect, Schema } from "effect"
import { WorkspaceBinding } from "@rika/execution"
import type { RunnerGateway } from "./runner-gateway"

const encodeBinding = Schema.encodeSync(Schema.fromJsonString(WorkspaceBinding))

export const makeRunnerRequestHandler = (gateway: RunnerGateway) =>
  Effect.fn("Rika.RunnerHttp.handle")(function* (request: Request) {
    if (request.method !== "GET") return undefined
    const match = /^\/api\/v2\/threads\/([^/]+)\/executor\/binding$/.exec(new URL(request.url).pathname)
    const segment = match?.[1]
    if (segment === undefined) return undefined
    const decoded = yield* Effect.try(() => decodeURIComponent(segment)).pipe(Effect.result)
    if (decoded._tag === "Failure" || decoded.success.length === 0 || decoded.success.length > 512)
      return new Response("Invalid Runner request", { status: 400 })
    const threadId = decoded.success
    const authorized = yield* gateway.bindingForThread({ request, threadId }).pipe(Effect.result)
    if (authorized._tag === "Failure") {
      let status = 503
      if (authorized.failure.kind === "unauthorized") status = 401
      else if (authorized.failure.kind === "forbidden") status = 403
      return new Response("Runner request rejected", { status, headers: { "cache-control": "no-store" } })
    }
    return new Response(encodeBinding(authorized.success), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    })
  })
