import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ConfigContract } from "@rika/config"
import {
  buildTestModelScript,
  distinctModelRoutes,
  modelRoutePlan,
  parseTestModelScript,
  productionCompaction,
} from "../src/main"

test("uses production compaction defaults and route overrides", () => {
  expect(productionCompaction()).toEqual({
    contextWindow: 372_000,
    reserveTokens: 128_000,
    keepRecentTokens: 32_000,
  })
  expect(
    productionCompaction({ compaction: { contextWindow: 192_000, reserveTokens: 32_000, keepRecentTokens: 16_000 } }),
  ).toEqual({
    contextWindow: 192_000,
    reserveTokens: 32_000,
    keepRecentTokens: 16_000,
  })
})

test("content-addresses non-secret model execution semantics deterministically", () => {
  const route = ConfigContract.resolveModelRoute(ConfigContract.defaults, "high", "oracle")
  const key = modelRoutePlan(route).registrationKey
  expect(key).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(modelRoutePlan(route).registrationKey).toBe(key)
  expect(
    modelRoutePlan({ ...route, gateway: { ...route.gateway, baseUrl: `${route.gateway.baseUrl}/` } }).registrationKey,
  ).toBe(key)
  expect(
    modelRoutePlan({ ...route, gateway: { ...route.gateway, baseUrl: `${route.gateway.baseUrl}#primary` } })
      .registrationKey,
  ).toBe(key)
  const firstQuery = modelRoutePlan({
    ...route,
    gateway: { ...route.gateway, baseUrl: `${route.gateway.baseUrl}/?tenant=first` },
  }).registrationKey
  const secondQuery = modelRoutePlan({
    ...route,
    gateway: { ...route.gateway, baseUrl: `${route.gateway.baseUrl}?tenant=second` },
  }).registrationKey
  expect(firstQuery).not.toBe(secondQuery)
  expect(
    modelRoutePlan({
      ...route,
      gateway: { ...route.gateway, baseUrl: `${route.gateway.baseUrl}?tenant=first#ignored` },
    }).registrationKey,
  ).toBe(firstQuery)
  const changes = [
    { ...route, gateway: { ...route.gateway, protocol: "openai" as const } },
    { ...route, gateway: { ...route.gateway, baseUrl: "https://models.example.test/v1" } },
    { ...route, model: "claude-opus-4-8" },
    { ...route, effort: "high" as const },
    { ...route, fast: true },
    { ...route, options: { ...route.options, max_tokens: 64_000 } },
    { ...route, options: { ...route.options, service_tier: "priority" } },
    { ...route, gateway: { ...route.gateway, auth: { type: "none" as const } } },
    {
      ...route,
      gateway: { ...route.gateway, auth: { type: "bearer-env" as const, variable: "OTHER_API_KEY" } },
    },
  ]
  for (const changed of changes) expect(modelRoutePlan(changed).registrationKey).not.toBe(key)
  expect(JSON.stringify(modelRoutePlan(route))).not.toContain("API_KEY_VALUE")
  expect(modelRoutePlan(route).selection.registrationKey).toBe(key)
})

test("keeps registrations distinct by the exact Baton registry tuple", () => {
  const route = ConfigContract.resolveModelRoute(ConfigContract.defaults, "high", "oracle")
  const second = { ...route, gatewayName: `${route.gatewayName}-secondary` }
  expect(modelRoutePlan(second).registrationKey).toBe(modelRoutePlan(route).registrationKey)
  expect(distinctModelRoutes([route, second, route])).toEqual([route, second])
})

test("parses and builds multi-part, object, and delayed TestModel turns", async () => {
  const json = JSON.stringify([
    {
      parts: [
        { type: "reasoning", text: "inspect" },
        { type: "toolCall", name: "read_file", params: { path: "a.txt" }, id: "read-1" },
      ],
      delayMs: 25,
    },
    { parts: [{ type: "text", text: "done" }] },
    { object: { summary: "reviewed", findings: [] }, delayMs: 10 },
  ])
  const parsed = await Effect.runPromise(parseTestModelScript(json))
  expect(parsed).toHaveLength(3)
  const built = await Effect.runPromise(buildTestModelScript(json))
  expect(built).toEqual([
    {
      _tag: "Turn",
      parts: [
        { _tag: "Reasoning", text: "inspect" },
        { _tag: "ToolCall", name: "read_file", params: { path: "a.txt" }, id: "read-1", providerExecuted: false },
      ],
      delay: 25,
    },
    { _tag: "Turn", parts: [{ _tag: "Text", text: "done" }] },
    { _tag: "Object", value: { summary: "reviewed", findings: [] }, delay: 10 },
  ])
})

test("rejects malformed, empty, and unsafe scripts", async () => {
  await Promise.all(
    [
      "not json",
      "[]",
      '[{"parts":[]}]',
      '[{"parts":[{"type":"toolCall","name":4}]}]',
      '[{"parts":[{"type":"text","text":"x"}],"delayMs":-1}]',
    ].map((value) => expect(Effect.runPromise(parseTestModelScript(value))).rejects.toBeDefined()),
  )
})
