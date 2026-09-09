import { Effect } from "effect"
import { expect } from "vitest"
import { it } from "@effect/vitest"
import { makeRawRivetGateway, RIVET_ORIGINAL_REQUEST_URL, type RawRivetRegistry } from "../src/hosted/raw-rivet-gateway"
import { threadPartition } from "../src/hosted/partition"

const partition = threadPartition({ environment: "test", ownerId: "owner", threadId: "thread", target: "runner" })

interface ForwardingState {
  created: number
  lookedUp: number
  forwarded: Request | undefined
  body: string
}

it.effect("resolves one canonical actor by key and forwards the original request through ClientRaw", () => {
  const actor = { actor_id: "actor-1", name: "rikaRuntime", key: "test/owner/thread" }
  const state: ForwardingState = {
    created: 0,
    lookedUp: 0,
    forwarded: undefined,
    body: "",
  }
  const registry: RawRivetRegistry = {
    handler: (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/actors" && request.method === "GET") {
        state.lookedUp += 1
        // ast-grep-ignore: effect-prefer-promise-composition -- fake registry implements Rivet's Promise Fetch contract.
        return Promise.resolve(new Response(state.created === 0 ? JSON.stringify({ actors: [] }) : JSON.stringify({ actors: [actor] })))
      }
      if (url.pathname === "/actors" && request.method === "PUT") {
        state.created += 1
        // ast-grep-ignore: effect-prefer-promise-composition -- fake registry implements Rivet's Promise Fetch contract.
        return Promise.resolve(new Response(JSON.stringify({ actor, created: true })))
      }
      if (url.pathname === "/gateway/actor-1/request/sessions/root" && request.method === "POST") {
        state.forwarded = request
        // ast-grep-ignore: effect-prefer-promise-composition -- fake registry implements Rivet's Promise Fetch contract.
        return request
          .arrayBuffer()
          .then((bytes) => {
            state.body = new TextDecoder().decode(bytes)
            return new Response("actor-response")
          })
      }
      // ast-grep-ignore: effect-prefer-promise-composition -- fake registry implements Rivet's Promise Fetch contract.
      return Promise.resolve(new Response("not found", { status: 404 }))
    },
  }
  const gateway = makeRawRivetGateway({ registry })

  return Effect.gen(function* () {
    const first = yield* gateway.ensureRootSession(partition, "command:1")
    const second = yield* gateway.ensureRootSession(partition, "command:1")
    const request = new Request("https://rika.test/sessions/root", {
      method: "POST",
      headers: { authorization: "Bearer token", dpop: "proof" },
      body: "payload",
    })
    const response = yield* gateway.handle(partition, request)

    expect(first).toEqual({ sessionId: partition.rootSessionId, created: true })
    expect(second).toEqual({ sessionId: partition.rootSessionId, created: false })
    expect(state.created).toBe(1)
    expect(state.lookedUp).toBe(3)
    expect(response.status).toBe(200)
    expect(state.body).toBe("payload")
    expect(state.forwarded?.headers.get("authorization")).toBe("Bearer token")
    expect(state.forwarded?.headers.get("dpop")).toBe("proof")
    expect(state.forwarded?.headers.get(RIVET_ORIGINAL_REQUEST_URL)).toBe("https://rika.test/sessions/root")
  })
})
