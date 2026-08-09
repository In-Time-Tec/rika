import { expect, test } from "bun:test"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { selectProviderCatalog } from "./provider-catalog"

const provider = (id: string) => ({ id, name: id, source: "api" as const, env: [], options: {}, models: {} })

const catalog = (...ids: string[]): NormalizedProviderListResponse => ({
  all: new Map(ids.map((id) => [id, provider(id)])),
  connected: ids,
  default: Object.fromEntries(ids.map((id) => [id, `${id}-model`])),
})

test("exposes only OpenRouter from a ready directory catalog", () => {
  const selected = selectProviderCatalog({
    explicit: true,
    directory: "/repo",
    catalog: { ready: true, providers: catalog("openai", "openrouter", "custom") },
  })

  expect([...selected.all.keys()]).toEqual(["openrouter"])
  expect(selected.connected).toEqual(["openrouter"])
  expect(selected.default).toEqual({ openrouter: "openrouter-model" })
})

test("does not expose an unsupported provider when OpenRouter is absent", () => {
  expect(
    selectProviderCatalog({
      explicit: true,
      directory: "/repo",
      catalog: { ready: true, providers: catalog("openai", "custom") },
    }),
  ).toEqual({ all: new Map(), connected: [], default: {} })
})

test("returns an empty catalog while an explicit directory is unresolved", () => {
  expect(selectProviderCatalog({ explicit: true })).toEqual({ all: new Map(), connected: [], default: {} })
  expect(
    selectProviderCatalog({
      explicit: true,
      directory: "/repo",
      catalog: { ready: false, providers: catalog("openrouter") },
    }),
  ).toEqual({ all: new Map(), connected: [], default: {} })
})

test("sanitizes the global fallback to OpenRouter", () => {
  const selected = selectProviderCatalog({ explicit: false, global: catalog("openai", "openrouter") })
  expect([...selected.all.keys()]).toEqual(["openrouter"])
})
