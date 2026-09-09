/* oxlint-disable effecttsgo/async-function -- the fake implements the released Promise Fetch boundary. */
/* oxlint-disable anti-slop/no-unknown-parameters -- the fake socket records arbitrary transport payloads. */
import { Effect } from "effect"
import { expect } from "vitest"
import { it } from "@effect/vitest"
import {
  bridgeWebSocket,
  gatewayWebSocketUrl,
  makeRawRivetGateway,
  RIKA_DOWNSTREAM_CREDENTIAL,
  RIKA_ORIGINAL_AUTHORIZATION,
  RIKA_ORIGINAL_REQUEST_METHOD,
  RIKA_ORIGINAL_REQUEST_URL,
  RIVET_ORIGINAL_REQUEST_URL,
} from "../src/hosted/raw-rivet-gateway"
import type { RawRivetActorHandle, RawRivetClient } from "../src/hosted/rivet-actor"
import { threadPartition } from "../src/hosted/partition"
import type { RuntimeWebSocket } from "../src/hosted/runtime-gateway"

const partition = threadPartition({ environment: "test", ownerId: "owner", threadId: "thread", target: "runner" })

it.effect("uses released client actor keys for canonical Session convergence and opaque forwarding", () => {
  let sessionExists = false
  let creates = 0
  let forwarded: Request | undefined
  let forwardedBody = ""
  const actor: RawRivetActorHandle = {
    // ast-grep-ignore: effect-prefer-program-construction -- fake released Fetch boundary.
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === `/sessions/${encodeURIComponent(partition.rootSessionId)}` && request.method === "GET")
        return sessionExists ? new Response("existing") : new Response("missing", { status: 404 })
      if (url.pathname === "/sessions" && request.method === "POST") {
        sessionExists = true
        creates += 1
        return new Response("created", { status: 201 })
      }
      forwarded = request
      forwardedBody = await request.text()
      return new Response("upstream")
    },
    // ast-grep-ignore: effect-prefer-program-construction -- fake released URL boundary.
    getGatewayUrl: async () => "https://rivet.test/gateway/rikaRuntime",
    // ast-grep-ignore: effect-prefer-program-construction -- fake released action boundary.
    action: async () => undefined,
  }
  const client: RawRivetClient = { get: () => actor, getOrCreate: () => actor }
  const gateway = makeRawRivetGateway({ endpoint: "https://rivet.test", client })

  return Effect.gen(function* () {
    const first = yield* gateway.ensureRootSession(
      partition,
      "command:1",
      new Request("https://rika.test/api/v2/threads/thread/session", {
        headers: { authorization: "Bearer token" },
      }),
    )
    const second = yield* gateway.ensureRootSession(
      partition,
      "command:1",
      new Request("https://rika.test/api/v2/threads/thread/session", {
        headers: { authorization: "Bearer token" },
      }),
    )
    const response = yield* gateway.handle(
      partition,
      new Request("https://rika.test/runs/opaque?cursor=abc", {
        method: "POST",
        headers: {
          authorization: "DPoP token",
          dpop: "proof",
          [RIKA_DOWNSTREAM_CREDENTIAL]: "rika-ds-test",
          [RIKA_ORIGINAL_REQUEST_METHOD]: "POST",
          [RIVET_ORIGINAL_REQUEST_URL]: "https://attacker.test/forged",
        },
        body: "payload",
      }),
    )

    expect(first).toEqual({ sessionId: partition.rootSessionId, created: true })
    expect(second).toEqual({ sessionId: partition.rootSessionId, created: false })
    expect(creates).toBe(1)
    expect(response.status).toBe(200)
    expect(forwarded?.url).toBe("https://rika.test/runs/opaque?cursor=abc")
    expect(forwarded?.headers.get("authorization")).toBe("Bearer token")
    expect(forwarded?.headers.get("dpop")).toBe("proof")
    expect(forwarded?.headers.get(RIKA_ORIGINAL_AUTHORIZATION)).toBe("DPoP token")
    expect(forwarded?.headers.get(RIKA_DOWNSTREAM_CREDENTIAL)).toBe("rika-ds-test")
    expect(forwarded?.headers.get(RIVET_ORIGINAL_REQUEST_URL)).toBeNull()
    expect(forwarded?.headers.get(RIKA_ORIGINAL_REQUEST_URL)).toBe("https://rika.test/runs/opaque?cursor=abc")
    expect(forwardedBody).toBe("payload")
  })
})

it.effect("merges gateway routing and incoming WS query parameters", () =>
  Effect.sync(() => {
    const url = gatewayWebSocketUrl(
      "https://rivet.test/gateway/rikaRuntime?partition=thread-thread&route=actor",
      "https://rika.test/runs/run-1?cursor=abc&filter=active&filter=ready",
    )
    expect(url.toString()).toBe(
      "https://rivet.test/gateway/rikaRuntime/websocket/runs/run-1?partition=thread-thread&route=actor&cursor=abc&filter=active&filter=ready",
    )
  }),
)

const mockSocket = () => {
  const listeners = new Map<
    string,
    (event: { readonly data?: unknown; readonly code?: number; readonly reason?: string }) => void
  >()
  const sent: unknown[] = []
  const closed: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = []
  return {
    sent,
    closed,
    addEventListener: (
      type: string,
      listener: (event: { readonly data?: unknown; readonly code?: number; readonly reason?: string }) => void,
    ) => listeners.set(type, listener),
    send: (data: unknown) => sent.push(data),
    close: (code?: number, reason?: string) => closed.push({ code, reason }),
    dispatch: (
      type: string,
      event: { readonly data?: unknown; readonly code?: number; readonly reason?: string } = {},
    ) => listeners.get(type)?.(event),
  }
}

it.effect("bounds pre-open WS queue and closes both sockets on overflow or upstream failure", () =>
  Effect.sync(() => {
    const upstream = mockSocket()
    const downstreamListeners = new Map<string, (event: { readonly data: unknown }) => void>()
    const downstreamClosed: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = []
    const downstream: RuntimeWebSocket = {
      send: () => undefined,
      close: (code, reason) => downstreamClosed.push({ code, reason }),
      addEventListener: (type, listener) => downstreamListeners.set(type, listener),
    }
    bridgeWebSocket(upstream, downstream)
    for (let index = 0; index < 129; index += 1) downstreamListeners.get("message")?.({ data: `frame-${index}` })
    expect(upstream.sent).toHaveLength(0)
    expect(upstream.closed).toEqual([{ code: 1009, reason: "Upstream WebSocket buffer exceeded" }])
    expect(downstreamClosed).toEqual([{ code: 1009, reason: "Upstream WebSocket buffer exceeded" }])

    const failedUpstream = mockSocket()
    const failedDownstreamClosed: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = []
    const failedDownstream: RuntimeWebSocket = {
      send: () => undefined,
      close: (code, reason) => failedDownstreamClosed.push({ code, reason }),
      addEventListener: (type, listener) => downstreamListeners.set(`failed-${type}`, listener),
    }
    bridgeWebSocket(failedUpstream, failedDownstream)
    failedUpstream.dispatch("error")
    expect(failedUpstream.closed).toEqual([{ code: 1011, reason: "Upstream WebSocket failed" }])
    expect(failedDownstreamClosed).toEqual([{ code: 1011, reason: "Upstream WebSocket failed" }])

    const sendFailureUpstream = mockSocket()
    const sendFailureDownstreamClosed: Array<{
      readonly code: number | undefined
      readonly reason: string | undefined
    }> = []
    bridgeWebSocket(sendFailureUpstream, {
      send: () => {
        throw new Error("socket closed")
      },
      close: (code, reason) => sendFailureDownstreamClosed.push({ code, reason }),
      addEventListener: () => undefined,
    })
    sendFailureUpstream.dispatch("open")
    sendFailureUpstream.dispatch("message", { data: "trigger" })
    expect(sendFailureUpstream.closed).toEqual([{ code: 1011, reason: "Downstream WebSocket failed" }])
    expect(sendFailureDownstreamClosed).toEqual([{ code: 1011, reason: "Downstream WebSocket failed" }])
  }),
)

it.effect("flushes queued duplex frames and propagates normal close in either direction", () =>
  Effect.sync(() => {
    const upstream = mockSocket()
    const downstreamListeners = new Map<string, (event: { readonly data: unknown }) => void>()
    const downstreamSent: unknown[] = []
    const downstreamClosed: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = []
    const downstream: RuntimeWebSocket = {
      send: (data) => downstreamSent.push(data),
      close: (code, reason) => downstreamClosed.push({ code, reason }),
      addEventListener: (type, listener) => downstreamListeners.set(type, listener),
    }
    bridgeWebSocket(upstream, downstream)
    downstreamListeners.get("message")?.({ data: "queued-before-open" })
    expect(upstream.sent).toEqual([])
    upstream.dispatch("open")
    expect(upstream.sent).toEqual(["queued-before-open"])
    upstream.dispatch("message", { data: "from-upstream" })
    expect(downstreamSent).toEqual(["from-upstream"])
    downstreamListeners.get("close")?.({ data: undefined })
    expect(upstream.closed).toEqual([{ code: 1000, reason: "Downstream WebSocket closed" }])

    const closingUpstream = mockSocket()
    const closingDownstreamClosed: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> =
      []
    bridgeWebSocket(closingUpstream, {
      send: () => undefined,
      close: (code, reason) => closingDownstreamClosed.push({ code, reason }),
      addEventListener: () => undefined,
    })
    closingUpstream.dispatch("close", { code: 1001, reason: "upstream shutdown" })
    expect(closingDownstreamClosed).toEqual([{ code: 1001, reason: "upstream shutdown" }])
  }),
)
