import { describe, expect, test } from "bun:test"
import { Ids } from "@rika/schema"
import { resolveProxyTarget } from "../vite.config"

const threadId = Ids.ThreadId.make("thread_web_proxy_orb")

describe("web Vite backend proxy", () => {
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
      url: "http://127.0.0.1:45555/v1/threads",
      token: "local-token",
      body: undefined,
    })
    expect(resolved).toEqual([undefined])
  })
})
