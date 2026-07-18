import { describe, expect, it } from "@effect/vitest"
import type { ExecutionModelRoute, ExecutionRoutePin } from "../src/execution-contract"
import { resolveSpawnModel } from "../src/agent-model"

const route = (model: string, registrationKey: string, effort: string): ExecutionModelRoute => ({
  role: "main",
  alias: model,
  provider: "test",
  model,
  registrationKey,
  providerProtocol: "test",
  providerBaseUrl: "test://model",
  effort,
  fast: false,
  requestVariant: registrationKey,
  compaction: { contextWindow: 1_000, reserveTokens: 100, keepRecentTokens: 100 },
})

const routes: ExecutionRoutePin = {
  mode: "test",
  main: route("gpt-5.6-terra", "terra-medium", "medium"),
  oracle: { ...route("gpt-5.6-sol", "sol-medium", "medium"), role: "oracle" },
  title: { ...route("gpt-5.6-luna", "luna-medium", "medium"), role: "title" },
}

const modeRoutes = (mode: "low" | "medium" | "high" | "ultra"): ExecutionRoutePin => {
  const luna = route("gpt-5.6-luna", "luna-low", "low")
  const terra = route("gpt-5.6-terra", "terra-medium", "medium")
  const solHigh = route("gpt-5.6-sol", "sol-high", "high")
  const solXhigh = route("gpt-5.6-sol", "sol-xhigh", "xhigh")
  const solMax = route("gpt-5.6-sol", "sol-max", "max")
  const main = mode === "low" ? luna : mode === "medium" ? terra : mode === "high" ? solXhigh : solMax
  return {
    mode,
    main,
    oracle: { ...(mode === "low" || mode === "medium" ? solHigh : solMax), role: "oracle" },
    title: { ...luna, role: "title" },
    compactionSummary: { ...terra, role: "compaction" },
    agents: {
      librarian: { ...solHigh, role: "librarian" },
      painter: { ...solHigh, role: "painter" },
      review: { ...solHigh, role: "review" },
      readThread: { ...terra, role: "readThread" },
      task: { ...terra, role: "task" },
    },
  }
}

describe("spawn model selection", () => {
  it("inherits the parent selection when omitted and resolves a named model at inherited effort", () => {
    const parent = { provider: "test", model: "gpt-5.6-terra", registrationKey: "terra-medium" }
    expect(resolveSpawnModel(routes, parent, undefined)).toEqual({ selection: parent, effort: "medium" })
    expect(resolveSpawnModel(routes, parent, "gpt-5.6-luna")).toEqual({
      selection: { provider: "test", model: "gpt-5.6-luna", registrationKey: "luna-medium" },
      effort: "medium",
    })
    const wrongEffort: ExecutionRoutePin = {
      ...routes,
      title: { ...route("gpt-5.6-luna", "luna-low", "low"), role: "title" },
    }
    expect(resolveSpawnModel(wrongEffort, parent, "gpt-5.6-luna")).toEqual({
      selection: { provider: "test", model: "gpt-5.6-luna", registrationKey: "luna-low" },
      effort: "low",
    })
  })

  it.each([
    ["low", "low", "medium", "high"],
    ["medium", "low", "medium", "high"],
    ["high", "low", "medium", "xhigh"],
    ["ultra", "low", "medium", "max"],
  ] as const)(
    "resolves every named model in %s mode at its nearest registered effort",
    (mode, lunaEffort, terraEffort, solEffort) => {
      const pin = modeRoutes(mode)
      const parent = {
        provider: pin.main.provider,
        model: pin.main.model,
        registrationKey: pin.main.registrationKey,
      }
      expect(resolveSpawnModel(pin, parent, "gpt-5.6-luna")?.effort).toBe(lunaEffort)
      expect(resolveSpawnModel(pin, parent, "gpt-5.6-terra")?.effort).toBe(terraEffort)
      expect(resolveSpawnModel(pin, parent, "gpt-5.6-sol")?.effort).toBe(solEffort)
    },
  )

  it("keeps an unknown model unavailable", () => {
    const parent = { provider: "test", model: "gpt-5.6-terra", registrationKey: "terra-medium" }
    expect(resolveSpawnModel(routes, parent, "unknown-model")).toBeUndefined()
  })

  it("prefers the lower effort when registered efforts are equally near", () => {
    const pin: ExecutionRoutePin = {
      mode: "test",
      main: route("gpt-5.6-luna", "luna-high", "high"),
      oracle: { ...route("gpt-5.6-sol", "sol-xhigh", "xhigh"), role: "oracle" },
      title: { ...route("gpt-5.6-sol", "sol-medium", "medium"), role: "title" },
    }
    const parent = { provider: "test", model: "gpt-5.6-luna", registrationKey: "luna-high" }
    expect(resolveSpawnModel(pin, parent, "gpt-5.6-sol")).toEqual({
      selection: { provider: "test", model: "gpt-5.6-sol", registrationKey: "sol-medium" },
      effort: "medium",
    })
  })

  it("keeps a known model available when persisted effort labels cannot be ranked", () => {
    const pin: ExecutionRoutePin = {
      ...routes,
      title: { ...route("gpt-5.6-luna", "luna-legacy", "legacy"), role: "title" },
    }
    const parent = { provider: "test", model: "gpt-5.6-terra", registrationKey: "terra-medium" }
    expect(resolveSpawnModel(pin, parent, "gpt-5.6-luna")).toEqual({
      selection: { provider: "test", model: "gpt-5.6-luna", registrationKey: "luna-legacy" },
      effort: "legacy",
    })
  })
})
