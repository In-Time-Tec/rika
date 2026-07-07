import { createServer, type Server } from "node:http"
import { describe, expect, test } from "bun:test"
import { WebSocketServer } from "ws"
import { Ids } from "@rika/schema"
import {
  backendProxyEnv,
  isApiRequestUrl,
  proxyOrbPtyWebSocketRequest,
  resolveProxyTarget,
  resolveProxyWebSocketTarget,
} from "../vite.config"

const threadId = Ids.ThreadId.make("thread_web_proxy_orb")
const otherThreadId = Ids.ThreadId.make("thread_web_proxy_orb_other")

describe("web Vite backend proxy", () => {
  test("skips non-api Vite requests before loading backend resolver modules", () => {
    expect(isApiRequestUrl(undefined)).toBe(false)
    expect(isApiRequestUrl("/")).toBe(false)
    expect(isApiRequestUrl("/src/entry.ts")).toBe(false)
    expect(isApiRequestUrl("/@vite/client")).toBe(false)
    expect(isApiRequestUrl("/api/rika/v1/threads")).toBe(true)
  })

  test("supplies a source CLI script to the local backend resolver", () => {
    const env = backendProxyEnv({})

    expect(env.RIKA_BACKEND_SCRIPT).toEndWith("/packages/cli/src/main.ts")
  })

  test("routes thread path requests through the matching orb endpoint", async () => {
    const resolved: Array<string | undefined> = []
    const target = await resolveProxyTarget({
      request_url: `/api/rika/v1/threads/${threadId}/events?after_sequence=1`,
      method: "GET",
      resolveEndpoint: async (input) => {
        resolved.push(input.thread_id)
        return {
          kind: "orb",
          url: "https://orb-endpoint.rika.test",
          token: "orb-token",
          orb_id: Ids.OrbId.make("orb_web_proxy"),
          thread_id: threadId,
        }
      },
    })

    expect(target).toEqual({
      kind: "proxy",
      url: `https://orb-endpoint.rika.test/v1/threads/${threadId}/events?after_sequence=1`,
      token: "orb-token",
      body: undefined,
    })
    expect(resolved).toEqual([threadId])
  })

  test("routes body-scoped turn requests through the matching orb endpoint without changing the body", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ thread_id: threadId, content: "hello from web" }))
    const resolved: Array<string | undefined> = []
    const target = await resolveProxyTarget({
      request_url: "/api/rika/v1/turns",
      method: "POST",
      body,
      resolveEndpoint: async (input) => {
        resolved.push(input.thread_id)
        return {
          kind: "orb",
          url: "https://orb-endpoint.rika.test/",
          token: "orb-token",
          orb_id: Ids.OrbId.make("orb_web_proxy"),
          thread_id: threadId,
        }
      },
    })

    expect(target).toEqual({
      kind: "proxy",
      url: "https://orb-endpoint.rika.test/v1/turns",
      token: "orb-token",
      body,
    })
    expect(resolved).toEqual([threadId])
  })

  test("routes threadless requests through the default endpoint", async () => {
    const resolved: Array<string | undefined> = []
    const target = await resolveProxyTarget({
      request_url: "/api/rika/v1/threads",
      method: "GET",
      resolveEndpoint: async (input) => {
        resolved.push(input.thread_id)
        return {
          kind: "local",
          url: "http://127.0.0.1:45555",
          token: "local-token",
          workspace_root: "/workspace/rika",
          data_dir: "/workspace/rika/.rika",
          pid: 123,
        }
      },
    })

    expect(target).toEqual({
      kind: "proxy",
      url: "http://127.0.0.1:45555/v1/threads",
      token: "local-token",
      body: undefined,
    })
    expect(resolved).toEqual([undefined])
  })

  test("routes explicit orb file requests through the thread orb endpoint and strips client credentials", async () => {
    const resolved: Array<string | undefined> = []
    const target = await resolveProxyTarget({
      request_url: `/api/rika/orb/by-thread/${threadId}/v1/orb/file?path=src%2Findex.ts&token=client&thread_id=spoofed`,
      method: "GET",
      resolveEndpoint: async (input) => {
        resolved.push(input.thread_id)
        return {
          kind: "orb",
          url: "https://orb-endpoint.rika.test/",
          token: "orb-token",
          orb_id: Ids.OrbId.make("orb_web_proxy"),
          thread_id: threadId,
        }
      },
    })

    expect(target).toEqual({
      kind: "proxy",
      url: "https://orb-endpoint.rika.test/v1/orb/file?path=src%2Findex.ts",
      token: "orb-token",
      body: undefined,
    })
    expect(resolved).toEqual([threadId])
  })

  test("rejects explicit orb file routes when the selected thread has no orb endpoint", async () => {
    const target = await resolveProxyTarget({
      request_url: `/api/rika/orb/by-thread/${threadId}/v1/orb/files?path=src`,
      method: "GET",
      resolveEndpoint: async () => ({
        kind: "local",
        url: "http://127.0.0.1:45555",
        token: "local-token",
        workspace_root: "/workspace/rika",
        data_dir: "/workspace/rika/.rika",
        pid: 123,
      }),
    })

    expect(target).toEqual({
      kind: "response",
      status: 404,
      body: { error: { message: `No running orb endpoint for thread ${threadId}`, code: "orb_endpoint_not_found" } },
    })
  })

  test("routes explicit orb PTY WebSocket requests through each thread orb endpoint and strips client credentials", async () => {
    const resolved: Array<string | undefined> = []
    const target = await resolveProxyWebSocketTarget({
      request_url: `/api/rika/orb/by-thread/${threadId}/v1/orb/pty?cols=120&rows=40&token=client&thread_id=spoofed`,
      resolveEndpoint: async (input) => {
        resolved.push(input.thread_id)
        return {
          kind: "orb",
          url: "https://orb-a.rika.test/",
          token: "orb-token-a",
          orb_id: Ids.OrbId.make("orb_web_proxy_a"),
          thread_id: threadId,
        }
      },
    })
    const other = await resolveProxyWebSocketTarget({
      request_url: `/api/rika/orb/by-thread/${otherThreadId}/v1/orb/pty?cols=90&rows=25`,
      resolveEndpoint: async (input) => {
        resolved.push(input.thread_id)
        return {
          kind: "orb",
          url: "http://orb-b.rika.test",
          token: "orb-token-b",
          orb_id: Ids.OrbId.make("orb_web_proxy_b"),
          thread_id: otherThreadId,
        }
      },
    })

    expect(target).toEqual({
      kind: "websocket",
      url: "wss://orb-a.rika.test/v1/orb/pty?cols=120&rows=40",
      token: "orb-token-a",
    })
    expect(other).toEqual({
      kind: "websocket",
      url: "ws://orb-b.rika.test/v1/orb/pty?cols=90&rows=25",
      token: "orb-token-b",
    })
    expect(resolved).toEqual([threadId, otherThreadId])
  })

  test("rejects explicit orb PTY WebSocket routes when the selected thread has no orb endpoint", async () => {
    const target = await resolveProxyWebSocketTarget({
      request_url: `/api/rika/orb/by-thread/${threadId}/v1/orb/pty?cols=80&rows=24`,
      resolveEndpoint: async () => ({
        kind: "local",
        url: "http://127.0.0.1:45555",
        token: "local-token",
        workspace_root: "/workspace/rika",
        data_dir: "/workspace/rika/.rika",
        pid: 123,
      }),
    })

    expect(target).toEqual({
      kind: "response",
      status: 404,
      body: { error: { message: `No running orb endpoint for thread ${threadId}`, code: "orb_endpoint_not_found" } },
    })
  })

  test("proxies orb PTY WebSocket binary frames and injects the server-side orb token", async () => {
    const upstream = createServer()
    const upstreamWss = new WebSocketServer({ noServer: true })
    const upstreamRequests: Array<{ readonly url: string | undefined; readonly authorization: string | undefined }> = []
    upstream.on("upgrade", (request, socket, head) => {
      upstreamRequests.push({ url: request.url, authorization: request.headers.authorization })
      upstreamWss.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.on("message", (data, isBinary) => {
          webSocket.send(data, { binary: isBinary })
        })
      })
    })
    const proxy = createServer()
    const proxyWss = new WebSocketServer({ noServer: true })
    const resolved: Array<string | undefined> = []

    try {
      await listen(upstream)
      const upstreamUrl = httpServerUrl(upstream)
      proxy.on("upgrade", (request, socket, head) => {
        void proxyOrbPtyWebSocketRequest(request, socket, head, proxyWss, async (input) => {
          resolved.push(input.thread_id)
          return {
            kind: "orb",
            url: upstreamUrl,
            token: "orb-token",
            orb_id: Ids.OrbId.make("orb_web_proxy_ws"),
            thread_id: threadId,
          }
        })
      })
      await listen(proxy)
      const client = await connectWebSocket(
        `${toWsUrl(httpServerUrl(proxy))}/api/rika/orb/by-thread/${threadId}/v1/orb/pty?cols=120&rows=40&token=client&thread_id=spoofed`,
      )
      const echoed = nextMessage(client)
      client.send(new Uint8Array([1, 2, 3]))
      const frame = await echoed
      client.close()

      if (!(frame instanceof ArrayBuffer)) throw new Error("expected ArrayBuffer")
      expect(new Uint8Array(frame)).toEqual(new Uint8Array([1, 2, 3]))
      expect(upstreamRequests).toEqual([
        { url: "/v1/orb/pty?cols=120&rows=40&token=orb-token", authorization: "Bearer orb-token" },
      ])
      expect(resolved).toEqual([threadId])
    } finally {
      proxyWss.close()
      upstreamWss.close()
      await Promise.all([closeServer(proxy), closeServer(upstream)])
    }
  })
})

const listen = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close((error) => {
      if (error === undefined) {
        resolve()
      } else {
        reject(error)
      }
    })
  })

const httpServerUrl = (server: Server) => {
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("server is not listening on TCP")
  return `http://127.0.0.1:${address.port}`
}

const toWsUrl = (url: string) => url.replace(/^http:/, "ws:").replace(/^https:/, "wss:")

const connectWebSocket = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.binaryType = "arraybuffer"
    socket.addEventListener("open", () => resolve(socket), { once: true })
    socket.addEventListener("error", () => reject(new Error(`websocket failed: ${url}`)), { once: true })
    socket.addEventListener("close", () => reject(new Error(`websocket closed before open: ${url}`)), { once: true })
  })

const nextMessage = (socket: WebSocket) =>
  new Promise<unknown>((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(event.data), { once: true })
    socket.addEventListener("error", () => reject(new Error("websocket failed while waiting for message")), {
      once: true,
    })
  })
