import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import { expect, test } from "vitest"

import { Cause, Effect, Redacted } from "effect"

import {
  execution as ResidentExecution,
  validateWebSearchProviders,
} from "../src/resident/composition/resident-execution-layer"
import { route as ResidentConfiguration } from "../src/resident/composition/resident-configuration-adapter"
import { modelRoutePlan } from "@rika/relay-execution/model-provider-runtime"
import { httpRoute } from "./model-script-fixtures"
const { executionRoutePin, modelRoutesForExecution, productionCompaction } = ResidentConfiguration
const { executionModelRoutes } = ResidentExecution

test("rejects web search provider IDs that are not installed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(validateWebSearchProviders({ custom: Redacted.make("secret") }))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("Unknown web search provider 'custom'")
    }),
  ))

test("uses production compaction defaults and route overrides", () => {
  expect(productionCompaction()).toEqual({
    contextWindow: 1_050_000,
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
  const route = httpRoute(ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, "high", "oracle"))
  const key = modelRoutePlan(route).registrationKey
  expect(key).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(modelRoutePlan(route).registrationKey).toBe(key)
  expect(
    modelRoutePlan({
      ...route,
      providerConnection: { ...route.providerConnection, baseUrl: `${route.providerConnection.baseUrl}/` },
    }).registrationKey,
  ).toBe(key)
  expect(
    modelRoutePlan({
      ...route,
      providerConnection: { ...route.providerConnection, baseUrl: `${route.providerConnection.baseUrl}#primary` },
    }).registrationKey,
  ).toBe(key)
  const firstQuery = modelRoutePlan({
    ...route,
    providerConnection: { ...route.providerConnection, baseUrl: `${route.providerConnection.baseUrl}/?tenant=first` },
  }).registrationKey
  const secondQuery = modelRoutePlan({
    ...route,
    providerConnection: { ...route.providerConnection, baseUrl: `${route.providerConnection.baseUrl}?tenant=second` },
  }).registrationKey
  expect(firstQuery).not.toBe(secondQuery)
  expect(
    modelRoutePlan({
      ...route,
      providerConnection: {
        ...route.providerConnection,
        baseUrl: `${route.providerConnection.baseUrl}?tenant=first#ignored`,
      },
    }).registrationKey,
  ).toBe(firstQuery)
  const changes = [
    { ...route, providerConnection: { ...route.providerConnection, protocol: "anthropic" as const } },
    { ...route, providerConnection: { ...route.providerConnection, baseUrl: "https://models.example.test/v1" } },
    { ...route, model: "claude-opus-4-8" },
    { ...route, effort: "xhigh" as const },
    { ...route, fast: true },
    { ...route, options: { ...route.options, max_tokens: 64_000 } },
    { ...route, options: { ...route.options, service_tier: "priority" } },
  ]
  for (const changed of changes) expect(modelRoutePlan(changed).registrationKey).not.toBe(key)
  expect(JSON.stringify(modelRoutePlan(route))).not.toContain("API_KEY_VALUE")
  expect(modelRoutePlan(route).selection.registrationKey).toBe(key)
  expect(executionRoutePin(SettingsDefaults.Defaults.defaults, "high").oracle.providerOptions).toEqual(
    modelRoutePlan(route).options,
  )
  expect(executionRoutePin(SettingsDefaults.Defaults.defaults, "medium").tokenBudget).toBeUndefined()
  const settings = {
    ...SettingsDefaults.Defaults.defaults,
    compaction: { summaryModel: { alias: "terra", effort: "medium" as const } },
  }
  expect(executionRoutePin(settings, "medium").compactionSummary).toMatchObject({
    role: "compaction",
    alias: "terra",
    model: "gpt-5.6-terra",
  })
})

test("pins GPT 5.6 routes to each mode's configured effort and selected fast tier", () => {
  const modes = ["low", "medium", "high", "ultra"] as const
  for (const mode of modes) {
    for (const fastMode of [false, true]) {
      const route = executionRoutePin(SettingsDefaults.Defaults.defaults, mode, { fastMode })
      for (const selected of [route.main, route.oracle, route.title!]) {
        expect(selected.model).toMatch(/^gpt-5\.6-/)
        expect(selected.providerConnection.protocol).toBe("openai")
      }
      expect(route.main.providerOptions).toMatchObject({
        reasoning: { effort: SettingsDefaults.Defaults.defaults.modes[mode].main.effort },
      })
      expect(route.oracle.providerOptions).toMatchObject({
        reasoning: { effort: SettingsDefaults.Defaults.defaults.modes[mode].oracle.effort },
      })
      expect(route.main.providerOptions?.service_tier).toBe(fastMode ? "priority" : undefined)
      expect(route.oracle.providerOptions?.service_tier).toBe(fastMode ? "priority" : undefined)
      expect(route.title).toMatchObject({
        role: "title",
        alias: "luna",
        model: "gpt-5.6-luna",
        providerConnection: { protocol: "openai" },
        effort: "low",
        fast: false,
        providerOptions: { reasoning: { effort: "low" } },
      })
    }
  }
})

test("pins aliases, variants, candidates, specialists, titles, and summaries as one admission snapshot", () => {
  const settings: SettingsDefaults.ConfigurationSettings = {
    ...SettingsDefaults.Defaults.defaults,
    providers: {
      ...SettingsDefaults.Defaults.defaults.providers,
      openai: {
        ...SettingsDefaults.Defaults.providerDefaults.openai,
        baseUrl: "https://models.example.test/v1?tenant=admission",
        apiKeyEnv: "ADMISSION_API_KEY",
      },
    },
  }
  const resolved = modelRoutesForExecution(settings, "high", { fastMode: true })
  expect(resolved.map((route) => route.alias)).toEqual([
    "sol",
    "sol",
    "luna",
    "sol",
    "sol",
    "sol",
    "sol",
    "sol",
    "sol",
    "sol",
  ])
  expect(resolved.map((route) => route.model)).toEqual(resolved.map((route) => route.candidates[0]))

  const pin = executionRoutePin(settings, "high", { fastMode: true })
  expect(executionModelRoutes(pin).map((route) => route.role)).toEqual(["main", "oracle", "title", "compaction"])
  expect(pin).toMatchObject({
    mode: "high",
    main: { alias: "sol", effort: "medium", fast: true },
    oracle: { alias: "sol", effort: "high", fast: true },
    title: { alias: "luna", effort: "low", fast: false },
    compactionSummary: { alias: "sol", effort: "xhigh", fast: false },
  })
  for (const route of executionModelRoutes(pin)) {
    expect(route.providerConnection.baseUrl).toBe("https://models.example.test/v1?tenant=admission")
    expect(route.providerConnection.apiKeyEnvironment).toBe("ADMISSION_API_KEY")
    expect(route.requestVariant).toBe(route.registrationIdentity)
    expect(JSON.stringify(route)).not.toContain("secret")
  }
  expect(pin.main.providerOptions).toMatchObject({ reasoning: { effort: "medium" }, service_tier: "priority" })
  expect(pin.oracle.providerOptions).toMatchObject({ reasoning: { effort: "high" }, service_tier: "priority" })
  expect(pin.title?.providerOptions).not.toHaveProperty("service_tier")
  expect(pin.compactionSummary?.providerOptions).not.toHaveProperty("service_tier")
})
