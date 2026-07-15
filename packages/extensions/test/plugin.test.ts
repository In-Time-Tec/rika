import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { ExecutionExtensions, PluginApi, PluginDigest, PluginLoader, PluginRegistry, PluginTrust } from "../src"
import { provideLayer } from "./layer"

const tool = (description: string): PluginApi.Tool => ({
  name: "inspect",
  description,
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  execute: Effect.fn("Fixture.inspect")((input) => Effect.succeed(input)),
})

const source = (id: string, content: string, register: PluginApi.PluginV1["register"]): PluginLoader.Source => ({
  id,
  content,
  configuration: { enabled: true },
  load: Effect.succeed(Object.freeze({ apiVersion: PluginApi.v1.apiVersion, id, register })),
})

const layers = Layer.mergeAll(PluginTrust.memoryLayer(), PluginRegistry.memoryLayer, BunServices.layer)

it.effect("trusted v1 plugins register typed capabilities with duplicate diagnostics and deterministic digests", () =>
  Effect.gen(function* () {
    const trust = yield* PluginTrust.Service
    const digest = yield* PluginDigest.source("alpha")
    yield* trust.approve("workspace", "alpha", digest)
    const fixture = source("alpha", "alpha", (registrar) => {
      registrar.tool(tool("first"))
      registrar.tool(tool("duplicate"))
      registrar.mode({ name: "review", description: "Review", defaultTools: ["inspect"] })
      registrar.agentProfile({ name: "reviewer", description: "Reviewer", mode: "review", tools: ["inspect"] })
      registrar.uiAction("ready", { kind: "notice", message: "Ready" })
    })
    const first = yield* PluginLoader.reload("workspace", [fixture])
    const second = yield* PluginLoader.reload("workspace", [fixture])
    expect(first.id).toBe(second.id)
    expect(first.tools.get("inspect")?.description).toBe("first")
    expect(first.modes.has("review")).toBe(true)
    expect(first.agentProfiles.has("reviewer")).toBe(true)
    expect(first.uiActions.get("ready")).toEqual({ kind: "notice", message: "Ready" })
    expect(first.diagnostics).toEqual(["alpha: duplicate tool registration: inspect"])
  }).pipe(provideLayer(layers)),
)

it.effect("isolates failures, skips untrusted code, and retains pinned generations across reload", () => {
  let untrustedLoaded = false
  return Effect.gen(function* () {
    const trust = yield* PluginTrust.Service
    const oldDigest = yield* PluginDigest.source("old")
    yield* trust.approve("workspace", "good", oldDigest)
    const old = yield* PluginLoader.reload("workspace", [source("good", "old", (api) => api.tool(tool("old")))])
    const unavailable = yield* Effect.flip((yield* PluginRegistry.Service).pinned("missing"))
    const newDigest = yield* PluginDigest.source("new")
    yield* trust.approve("workspace", "good", newDigest)
    const current = yield* PluginLoader.reload("workspace", [
      source("good", "new", (api) => api.tool(tool("new"))),
      {
        ...source("hidden", "hidden", () => {}),
        load: Effect.sync(() => {
          untrustedLoaded = true
        }).pipe(Effect.andThen(Effect.die("untrusted loaded"))),
      },
      {
        ...source("broken", "broken", () => {}),
        load: Effect.fail(PluginLoader.LoadError.make({ message: "boom" })),
      },
    ])
    const pinned = yield* (yield* PluginRegistry.Service).pinned(old.id)
    expect(current.id).not.toBe(old.id)
    expect(pinned.tools.get("inspect")?.description).toBe("old")
    expect(unavailable._tag).toBe("@rika/extensions/PluginGenerationUnavailable")
    expect(current.diagnostics).toHaveLength(2)
    expect(untrustedLoaded).toBe(false)
  }).pipe(provideLayer(layers))
})

it.effect("pins every execution extension digest and fails typed when its generation is unavailable", () =>
  Effect.gen(function* () {
    const trust = yield* PluginTrust.Service
    const digest = yield* PluginDigest.source("pinned")
    yield* trust.approve("workspace", "pinned", digest)
    const generation = yield* PluginLoader.reload("workspace", [source("pinned", "pinned", () => {})])
    const extensions = yield* ExecutionExtensions.Service
    const activated = yield* extensions.future("mcp-fingerprint", "context-digest")
    const missingRegistry = yield* PluginRegistry.Service
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
