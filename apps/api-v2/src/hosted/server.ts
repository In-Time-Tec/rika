import { Context, Effect, Layer, Option, Redacted } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { Server } from "generalist/server"
import type { RuntimeActorServerOptions, ActorRuntimeServices } from "generalist/unstable/rivet"
import type { Authorization as ServerAuthorization } from "generalist/server"
import type { HostOptions } from "./host"
import { hostEffect } from "./host"
import { threadPartition, type ThreadPartition } from "./partition"
import { authorizeResource, type ProductAuthorityService } from "./product-authority"
import { RIVET_ORIGINAL_REQUEST_URL } from "./rivet-protocol"

type ServerUnauthorized = InstanceType<typeof Server["Unauthorized"]>

export const originalRequestForAuthentication = (request: Request) => {
  const url = request.headers.get(RIVET_ORIGINAL_REQUEST_URL)
  if (url === null) return request
  try {
    const clone = request.clone()
    const init: RequestInit = { method: clone.method, headers: Object.fromEntries(clone.headers.entries()) }
    if (clone.method !== "GET" && clone.method !== "HEAD" && clone.body !== null)
      Object.assign(init, { body: clone.body, duplex: "half" })
    return new Request(url, init)
  } catch {
    return request
  }
}

const authentication = (input: { readonly authority: ProductAuthorityService; readonly partition: ThreadPartition }) =>
  Layer.succeed(
    Server.Authentication,
    Server.Authentication.of({
      bearer: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const request = yield* Effect.contextWith<never, Request, ServerUnauthorized, never>((context) =>
            Option.match(Context.getOption(context, HttpServerRequest.HttpServerRequest), {
              onNone: () => Effect.fail(Server.Unauthorized.make({})),
              onSome: (serverRequest) =>
                HttpServerRequest.toWeb(serverRequest).pipe(
                  Effect.mapError(() => Server.Unauthorized.make({})),
                ),
            }),
          )
          const principal = yield* input.authority.authenticateBearer(Redacted.value(credential), {
            ownerId: input.partition.ownerId,
            threadId: input.partition.threadId,
            request: originalRequestForAuthentication(request),
          })
          if (principal === undefined || principal.tenantId !== input.partition.ownerId)
            return yield* Server.Unauthorized.make({})
          return yield* Effect.provideService(httpEffect, Server.CurrentPrincipal, principal)
        }).pipe(Effect.catchTag("RikaApiV2ProductAuthorizationError", () => Server.Unauthorized.make({}))),
    }),
  )

/**
 * Compose one authenticated Generalist Server for one stable Thread partition. The ProductAuthority callback is
 * consulted for every resource and the Generalist stream implementation rechecks it for each committed event.
 */
export const serverOptionsEffect = (input: {
  readonly authority: ProductAuthorityService
  readonly partition: ThreadPartition
  readonly host: HostOptions
}): Effect.Effect<RuntimeActorServerOptions, never, ActorRuntimeServices> =>
  Effect.gen(function* () {
    const host = yield* hostEffect(input.host)
    const auth = authentication(input)
    const authorization: ServerAuthorization = {
      tenantId: input.partition.ownerId,
      authorize: (resource) => authorizeResource(input.authority, resource).pipe(Effect.orElseSucceed(() => false)),
    }
    return { host, auth, authorization } satisfies RuntimeActorServerOptions
  })

export const partitionForThread = (input: {
  readonly environment: string
  readonly ownerId: string
  readonly threadId: string
  readonly target: ThreadPartition["target"]
}) => threadPartition(input)
