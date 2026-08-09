import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { RikaAdapter, RikaDirectoryRuntime } from "./adapter"
import { createApiFacade, createLegacyFacade } from "./sdk-facade"

const workspace = "/workspace"

function fixture() {
  let catalogCalls = 0
  const replies: Array<{ requestId: string; reply: "once" | "reject" }> = []
  const catalog = {
    settings: { providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1" } } },
    environment: { providerApiKeys: { openrouter: "present" } },
    model: {
      route: { alias: "default", providerId: "openrouter", model: "free/model:free" },
      apiKey: "",
    },
  }
  const runtime = {
    workspace,
    getPermissions: () => [],
    replyAuthorization: (input: { requestId: string; reply: "once" | "reject" }) =>
      Effect.sync(() => {
        replies.push(input)
      }),
  } as unknown as RikaDirectoryRuntime
  const adapter = {
    catalog: () =>
      Effect.sync(() => {
        catalogCalls += 1
        return catalog
      }),
  } as unknown as RikaAdapter
  return {
    adapter: Promise.resolve(adapter),
    runtime: Promise.resolve(runtime),
    replies,
    catalogCalls: () => catalogCalls,
  }
}

describe("Rika SDK facade", () => {
  test("projects the configured provider through local and global configuration", async () => {
    const value = fixture()
    const client = createLegacyFacade(value.adapter, value.runtime) as unknown as {
      config: { get(): Promise<{ data: Record<string, unknown> }> }
      global: {
        config: { get(): Promise<{ data: Record<string, unknown> }> }
        dispose(): Promise<unknown>
      }
    }

    const local = (await client.config.get()).data
    const global = (await client.global.config.get()).data

    expect(local).toEqual(global)
    expect(local.model).toBe("openrouter/free/model:free")
    expect(local.enabled_providers).toEqual(["openrouter"])

    const beforeDispose = value.catalogCalls()
    await client.global.dispose()
    expect(value.catalogCalls()).toBe(beforeDispose + 1)
  })

  test("allows only binary authorization replies", async () => {
    const value = fixture()
    const api = createApiFacade(value.adapter, value.runtime)

    await api.permission.reply({ sessionID: "thread", requestID: "authorization", reply: "once" })
    expect(value.replies).toEqual([{ requestId: "authorization", reply: "once" }])
    await expect(
      api.permission.reply({ sessionID: "thread", requestID: "authorization", reply: "always" }),
    ).rejects.toMatchObject({
      _tag: "RikaAdapterError",
      operation: "Authorization.reply",
    })
  })
})
