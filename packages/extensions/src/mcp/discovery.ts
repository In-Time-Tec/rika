import { Crypto, Effect, Encoding, FileSystem, Schema } from "effect"
import { compose, ConfigError, type Server } from "./configuration"

/** One configured server and whether the Workspace has turned it off. */
export interface ConfiguredServer {
  readonly server: Server
  readonly enabled: boolean
}

export interface Options {
  readonly configPath: string
  readonly activatedSkills?: ReadonlyArray<{
    readonly name: string
    readonly digest: string
    readonly resources: ReadonlyArray<{ readonly path: string; readonly content: string }>
  }>
}

export interface Discovered {
  readonly servers: ReadonlyArray<ConfiguredServer>
  readonly digest: string
}

const Document = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const invalid = (configPath: string, message: string) => ConfigError.make({ source: configPath, message })

/**
 * Read the Workspace MCP configuration and every activated skill's `mcp.json` into one server set.
 *
 * A configured server has never reached an executing Agent: the Workspace file was only ever read by
 * the `rika mcp` CLI. This is the discovery an Execution mounts into the `mcp` binding, so a missing
 * file is an empty set rather than a failure and a malformed one fails typed.
 */
export const discover = Effect.fn("McpDiscovery.discover")(function* (options: Options) {
  const fileSystem = yield* FileSystem.FileSystem
  const crypto = yield* Crypto.Crypto
  const exists = yield* fileSystem
    .exists(options.configPath)
    .pipe(Effect.mapError((cause) => invalid(options.configPath, String(cause))))
  const content = exists
    ? yield* fileSystem
        .readFileString(options.configPath)
        .pipe(Effect.mapError((cause) => invalid(options.configPath, String(cause))))
    : "{}"
  const document = yield* Schema.decodeUnknownEffect(Document)(content).pipe(
    Effect.mapError((cause) => invalid(options.configPath, String(cause))),
  )
  /**
   * A configuration may name its servers under `servers` or be the bare map itself, and both forms
   * may disable one. Reading the list only in the wrapped form left a server a user had disabled
   * reachable in the other.
   */
  const declared = document["disabled"]
  if (declared !== undefined && (!Array.isArray(declared) || !declared.every((name) => typeof name === "string")))
    return yield* invalid(options.configPath, "Invalid disabled: expected an array of strings")
  const disabled = new Set<string>(declared === undefined ? [] : (declared as ReadonlyArray<string>))
  const composed = yield* compose({
    workspace: content,
    ...(options.activatedSkills === undefined ? {} : { activatedSkills: options.activatedSkills }),
  })
  const unknown = [...disabled].find((name) => !composed.some((server) => server.name === name))
  if (unknown !== undefined) return yield* invalid(options.configPath, `Disabled MCP server not found: ${unknown}`)
  const servers = composed.map((server) => ({ server, enabled: !disabled.has(server.name) }))
  const bytes = yield* crypto
    .digest(
      "SHA-256",
      new TextEncoder().encode(
        servers.map((entry) => `${entry.server.name}\0${entry.server.sourceDigest}\0${entry.enabled}`).join("\n"),
      ),
    )
    .pipe(Effect.mapError((cause) => invalid(options.configPath, String(cause))))
  return { servers, digest: Encoding.encodeHex(bytes) } satisfies Discovered
})
