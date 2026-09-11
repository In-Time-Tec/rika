import { Effect, Schema } from "effect"
import type { Principal, Resource } from "generalist/server"
import type { ThreadPartition } from "../runtime/partition"
import { authorizeResource, type ProductAuthorityService } from "../product/authority"

export interface RuntimeWebSocket {
  readonly close: (code?: number, reason?: string) => void
  readonly send: (data: string | ArrayBuffer | ArrayBufferView) => void
  readonly addEventListener?: (type: string, listener: (event: { readonly data: unknown }) => void) => void
  readonly dispatch?: (event: { readonly data: unknown; readonly type?: string }) => void
}

export class RuntimeGatewayError extends Schema.TaggedError<RuntimeGatewayError>()("RikaApiV2RuntimeGatewayError", {
  kind: Schema.Literals(["unavailable", "rejected", "unknown"]),
  message: Schema.String,
}) {}

export interface RootSessionReceipt {
  readonly sessionId: string
  readonly created: boolean
}

export interface RuntimeGateway {
  /** Create-or-read through the canonical Generalist Session authority; never enqueue a prompt. */
  readonly ensureRootSession: (
    partition: ThreadPartition,
    commandId: string,
    request?: Request,
  ) => Effect.Effect<RootSessionReceipt, RuntimeGatewayError>
  /** Forward one already-authenticated HTTP or WebSocket request to the actor's Generalist Server. */
  readonly handle: (
    partition: ThreadPartition,
    request: Request,
    websocket?: RuntimeWebSocket,
  ) => Effect.Effect<Response, RuntimeGatewayError>
}

/**
 * Product authorization is deliberately outside the gateway. This wrapper is the only route from Rika's HTTP API to
 * an upstream Generalist Server and repeats the current grant/revocation check before every request/stream.
 */
export const authorizedRuntimeRequest = Effect.fn("RikaApiV2.RuntimeGateway.authorizedRequest")(function* (input: {
  readonly authority: ProductAuthorityService
  readonly gateway: RuntimeGateway
  readonly principal: Principal
  readonly resource: Resource
  readonly partition: ThreadPartition
  readonly request: Request
  readonly websocket?: RuntimeWebSocket
}) {
  const allowed = yield* authorizeResource(input.authority, {
    principal: input.principal,
    resource: input.resource,
    action: input.request.method === "GET" ? "observe" : "mutate",
    threadId: input.partition.threadId,
  })
  if (!allowed)
    return yield* RuntimeGatewayError.make({ kind: "rejected", message: "Execution resource is unavailable" })
  return yield* input.gateway.handle(input.partition, input.request, input.websocket)
})
