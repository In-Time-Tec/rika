import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as ExecutionExtensions from "@rika/extensions/execution-extension-service"
import * as PluginContract from "@rika/extensions/plugin-contract"
import * as PluginLoader from "../../src/plugin/loader"
import * as PluginRegistry from "@rika/extensions/plugin-registry"
import { provideLayer } from "../support/extension-test-layer"

const tool = (description: string): PluginContract.Tool => ({
  name: "inspect",
  description,
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  execute: Effect.fn("Fixture.inspect")((input) => Effect.succeed(input)),
})

const source = (id: string, content: string, register: PluginContract.PluginV1["register"]): PluginLoader.Source => ({
  id,
  content,
  configuration: { enabled: true },
  load: Effect.succeed(Object.freeze({ apiVersion: PluginContract.v1.apiVersion, id, register })),
})

const layers = Layer.mergeAll(PluginRegistry.memoryLayer, BunServices.layer)

it.effect("v1 plugins register typed capabilities with duplicate diagnostics and deterministic digests", () =>
  Effect.gen(function* () {
    const fixture = source("alpha", "alpha", (registrar) => {
      registrar.tool(tool("first"))
      registrar.tool(tool("duplicate"))
      registrar.mode({ name: "review", description: "Review", defaultTools: ["inspect"] })
      registrar.agentProfile({ name: "reviewer", description: "Reviewer", mode: "review", tools: ["inspect"] })
      registrar.uiAction("ready", { kind: "notice", message: "Ready" })
    })
    const first = yield* PluginLoader.reload([fixture])
    const second = yield* PluginLoader.reload([fixture])
    expect(first.id).toBe(second.id)
    expect(first.tools.get("inspect")?.description).toBe("first")
    expect(first.modes.has("review")).toBe(true)
    expect(first.agentProfiles.has("reviewer")).toBe(true)
    expect(first.uiActions.get("ready")).toEqual({ kind: "notice", message: "Ready" })
    expect(first.diagnostics).toEqual(["alpha: duplicate tool registration: inspect"])
  }).pipe(provideLayer(layers)),
)

it.effect("isolates failures and retains pinned generations across reload", () =>
  Effect.gen(function* () {
    const old = yield* PluginLoader.reload([source("good", "old", (api) => api.tool(tool("old")))])
    const unavailable = yield* Effect.flip((yield* PluginRegistry.PluginRegistryService).pinned("missing"))
    const current = yield* PluginLoader.reload([
      source("good", "new", (api) => api.tool(tool("new"))),
      {
        ...source("broken", "broken", () => {}),
        load: Effect.fail(PluginLoader.LoadError.make({ message: "boom" })),
      },
    ])
    const pinned = yield* (yield* PluginRegistry.PluginRegistryService).pinned(old.id)
    expect(current.id).not.toBe(old.id)
    expect(pinned.tools.get("inspect")?.description).toBe("old")
    expect(unavailable._tag).toBe("@rika/extensions/PluginGenerationUnavailable")
    expect(current.diagnostics).toHaveLength(1)
  }).pipe(provideLayer(layers)),
)

it.effect("pins every execution extension digest and fails typed when its generation is unavailable", () =>
  Effect.gen(function* () {
    const generation = yield* PluginLoader.reload([source("pinned", "pinned", () => {})])
    const extensions = yield* ExecutionExtensions.ExecutionExtensionService
    const activated = yield* extensions.future("mcp-fingerprint", "context-digest")
    const missingRegistry = yield* PluginRegistry.PluginRegistryService
    const unavailable = yield* Effect.flip(missingRegistry.pinned("unavailable"))
    expect(activated.pin).toEqual({
      generation: generation.id,
      sourceDigest: generation.sourceDigest,
      configFingerprint: generation.configFingerprint,
      toolSchemaDigest: generation.toolSchemaDigest,
      mcpFingerprint: "mcp-fingerprint",
      resolvedContextDigest: "context-digest",
    })
    expect(unavailable._tag).toBe("@rika/extensions/PluginGenerationUnavailable")
  }).pipe(provideLayer(Layer.merge(ExecutionExtensions.layer.pipe(Layer.provide(layers)), layers))),
)
