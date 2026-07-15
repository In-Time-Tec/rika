import { Effect, Exit, Schema } from "effect"
import type { AgentProfile, Json, Mode, PluginV1, Registrar, Tool, UiAction } from "./plugin-api"
import * as PluginDigest from "./plugin-digest"
import type { Generation } from "./plugin-registry"
import * as PluginRegistry from "./plugin-registry"
import * as PluginTrust from "./plugin-trust"

export interface Source {
  readonly id: string
  readonly content: string
  readonly configuration: Json
  readonly load: Effect.Effect<PluginV1, LoadError>
}

export class LoadError extends Schema.TaggedErrorClass<LoadError>()("@rika/extensions/PluginLoadError", {
  message: Schema.String,
}) {}

export const reload = Effect.fn("PluginLoader.reload")(function* (
  workspaceIdentity: string,
  sources: ReadonlyArray<Source>,
) {
  const trust = yield* PluginTrust.Service
  const registry = yield* PluginRegistry.Service
  const tools = new Map<string, Tool>()
  const modes = new Map<string, Mode>()
  const profiles = new Map<string, AgentProfile>()
  const actions = new Map<string, UiAction>()
  const diagnostics: Array<string> = []
  const digests: Array<string> = []
  const add = <A>(kind: string, map: Map<string, A>, plugin: string, name: string, item: A) => {
    if (map.has(name)) diagnostics.push(`${plugin}: duplicate ${kind} registration: ${name}`)
    else map.set(name, item)
  }
  for (const source of sources.toSorted((left, right) => left.id.localeCompare(right.id))) {
    const sourceDigest = yield* PluginDigest.source(source.content)
    const trusted = yield* trust.isTrusted(workspaceIdentity, source.id, sourceDigest)
    if (!trusted) {
      diagnostics.push(`${source.id}: workspace trust required for ${sourceDigest}`)
      continue
    }
    const loaded = yield* Effect.exit(source.load)
    if (Exit.isFailure(loaded)) {
      diagnostics.push(`${source.id}: load failed: ${String(loaded.cause)}`)
      continue
    }
    const plugin = loaded.value
    if (plugin.apiVersion !== 1 || plugin.id !== source.id) {
      diagnostics.push(`${source.id}: invalid plugin contract`)
      continue
    }
    const registrar: Registrar = Object.freeze({
      tool: (item: Tool) => add("tool", tools, source.id, item.name, item),
      mode: (item: Mode) => add("mode", modes, source.id, item.name, item),
      agentProfile: (item: AgentProfile) => add("agent profile", profiles, source.id, item.name, item),
      uiAction: (name: string, item: UiAction) => add("UI action", actions, source.id, name, item),
    })
    const registered = yield* Effect.exit(Effect.sync(() => plugin.register(registrar)))
    if (Exit.isFailure(registered)) diagnostics.push(`${source.id}: registration failed: ${String(registered.cause)}`)
    const configDigest = yield* PluginDigest.configuration(source.configuration)
    digests.push(`${source.id}:${sourceDigest}:${configDigest}`)
  }
  const toolSchemaDigest = yield* PluginDigest.toolSchemas([...tools.values()])
  const sourceDigest = yield* PluginDigest.value(
    digests
      .toSorted()
      .map((item) => item.split(":").slice(0, 2).join(":"))
      .join("\n"),
  )
  const configFingerprint = yield* PluginDigest.value(
    digests
      .toSorted()
      .map((item) => `${item.split(":")[0]}:${item.split(":")[2]}`)
      .join("\n"),
  )
  const id = yield* PluginDigest.value([sourceDigest, configFingerprint, toolSchemaDigest].join("\n"))
  const generation: Generation = Object.freeze({
    id,
    sourceDigest,
    configFingerprint,
    toolSchemaDigest,
    tools: new Map(tools),
    modes: new Map(modes),
    agentProfiles: new Map(profiles),
    uiActions: new Map(actions),
    diagnostics: Object.freeze([...diagnostics]),
  })
  yield* registry.publish(generation)
  return generation
})
