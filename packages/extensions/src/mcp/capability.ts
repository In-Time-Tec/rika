import { Effect, Path, Schema } from "effect"
import { Pins } from "generalist"
import type { MCPClient } from "generalist/mcp"
import { Specialist, type Server } from "./configuration"
import * as Discovery from "./discovery"
import { McpRuntimeService } from "./runtime"
import { Capability } from "./capability-contract"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"

export class CapabilityError extends Schema.TaggedError<CapabilityError>()("McpCapabilityError", {
  reason: Schema.Literals(["denied", "changed", "unavailable", "invalid-input", "unknown"]),
  message: Schema.String,
}) {}

const failure = (reason: CapabilityError["reason"]) =>
  CapabilityError.make({ reason, message: `MCP capability ${reason}` })

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String))
const credentialEchoed = (server: Server, encoded: string) =>
  Object.values(server.kind === "local" ? server.environment : server.headers).some(
    (secret) => secret.length > 0 && encoded.includes(encodeString(secret).slice(1, -1)),
  )

const configured = (configPath: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const discovered = yield* Discovery.discover({ configPath }).pipe(Effect.mapError(() => failure("unavailable")))
    return {
      ...discovered,
      servers: discovered.servers.map((entry) => ({
        ...entry,
        server:
          entry.server.kind === "local"
            ? {
                ...entry.server,
                cwd: path.resolve(path.dirname(configPath), "..", entry.server.cwd ?? "."),
              }
            : entry.server,
      })),
    }
  })

const descriptor = (server: Server, specialist: Capability["specialist"], tool: MCPClient.DiscoveredTool) =>
  Effect.gen(function* () {
    const value = yield* Schema.decodeUnknownEffect(Capability)({
      specialist,
      server: server.name,
      sourceDigest: server.sourceDigest,
      // Length-delimited identity avoids collisions between server/raw-name pairs.
      name: `mcp_${Pins.digest([server.name, tool.rawName]).slice(0, 32)}`,
      rawName: tool.rawName,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema ?? null,
    }).pipe(Effect.mapError(() => failure("changed")))
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Capability))(value).pipe(
      Effect.mapError(() => failure("changed")),
    )
    if (new TextEncoder().encode(encoded).length > 16_384 || credentialEchoed(server, encoded))
      return yield* failure("changed")
    yield* Effect.try({
      try: () => new AjvJsonSchemaValidator().getValidator(value.inputSchema),
      catch: () => failure("changed"),
    })
    return value
  })

/** All-or-nothing admission: an unavailable granted server never becomes a partial successful catalog. */
export const capture = (configPath: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* McpRuntimeService
      const discovered = yield* configured(configPath)
      const catalog: Array<Capability> = []
      for (const { server, enabled } of discovered.servers) {
        if (!enabled || server.specialists === undefined) continue
        const grants = Object.entries(server.specialists).filter(([, names]) => names.length > 0)
        if (grants.length === 0) continue
        const client = yield* runtime.connect(server).pipe(Effect.mapError(() => failure("unavailable")))
        const tools = yield* client.tools.pipe(Effect.mapError(() => failure("unavailable")))
        for (const [profile, names] of grants) {
          const specialist = yield* Schema.decodeUnknownEffect(Specialist)(profile).pipe(
            Effect.mapError(() => failure("denied")),
          )
          for (const name of new Set(names)) {
            const matches = tools.filter((tool) => tool.rawName === name)
            if (matches.length !== 1) return yield* failure("changed")
            catalog.push(yield* descriptor(server, specialist, matches[0]!))
          }
        }
      }
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Capability)))(catalog).pipe(
        Effect.mapError(() => failure("changed")),
      )
      if (new TextEncoder().encode(encoded).length > 32_768) return yield* failure("changed")
      return catalog.toSorted((a, b) => `${a.specialist}:${a.name}`.localeCompare(`${b.specialist}:${b.name}`))
    }),
  )

/** Recheck local grants, then compare and call on one scoped connection. Never retry a possibly applied call. */
export const call = Effect.fn("McpCapability.call")(function* (
  configPath: string,
  pinned: Capability,
  input: Schema.Json,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* McpRuntimeService
      const discovered = yield* configured(configPath)
      const entry = discovered.servers.find(({ server }) => server.name === pinned.server)
      if (
        entry === undefined ||
        !entry.enabled ||
        entry.server.specialists?.[pinned.specialist]?.includes(pinned.rawName) !== true
      )
        return yield* failure("denied")
      if (entry.server.sourceDigest !== pinned.sourceDigest) return yield* failure("changed")
      const client = yield* runtime.connect(entry.server).pipe(Effect.mapError(() => failure("unavailable")))
      const tools = yield* client.tools.pipe(Effect.mapError(() => failure("unavailable")))
      const matches = tools.filter((tool) => tool.rawName === pinned.rawName)
      if (matches.length !== 1) return yield* failure("changed")
      const current = yield* descriptor(entry.server, pinned.specialist, matches[0]!)
      if (Pins.digest(current) !== Pins.digest(pinned)) return yield* failure("changed")
      const valid = yield* Effect.try({
        try: () => new AjvJsonSchemaValidator().getValidator(pinned.inputSchema)(input).valid,
        catch: () => failure("invalid-input"),
      })
      if (!valid) return yield* failure("invalid-input")
      const result = yield* client.callTool(pinned.rawName, input).pipe(Effect.mapError(() => failure("unknown")))
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(result).pipe(
        Effect.mapError(() => failure("unknown")),
      )
      if (credentialEchoed(entry.server, encoded)) return yield* failure("unknown")
      return result
    }),
  )
})
