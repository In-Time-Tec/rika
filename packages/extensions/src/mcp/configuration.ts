import { Crypto, Effect, Encoding, Schema } from "effect"

export const Source = Schema.Union([Schema.Literal("workspace"), Schema.TemplateLiteral(["skill:", Schema.String])])
export type Source = typeof Source.Type

export interface LocalServer {
  readonly kind: "local"
  readonly name: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly environment: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly source: Source
  readonly sourceDigest: string
}

export interface RemoteServer {
  readonly kind: "remote"
  readonly name: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly source: Source
  readonly sourceDigest: string
}

export type Server = LocalServer | RemoteServer

export const Server = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("local"),
    name: Schema.String,
    command: Schema.String,
    args: Schema.Array(Schema.String),
    environment: Schema.Record(Schema.String, Schema.String),
    cwd: Schema.optionalKey(Schema.String),
    source: Source,
    sourceDigest: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("remote"),
    name: Schema.String,
    url: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String),
    source: Source,
    sourceDigest: Schema.String,
  }),
]) satisfies Schema.Schema<Server>

export interface Input {
  readonly workspace?: string
  readonly activatedSkills?: ReadonlyArray<{
    readonly name: string
    readonly digest: string
    readonly resources: ReadonlyArray<{ readonly path: string; readonly content: string }>
  }>
}

export class ConfigError extends Schema.TaggedError<ConfigError>()("@rika/extensions/McpConfigError", {
  source: Schema.String,
  message: Schema.String,
}) {}

const StringRecord = Schema.Record(Schema.String, Schema.String)
const ServerInput = Schema.Struct({
  command: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(StringRecord),
  cwd: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(StringRecord),
})
const ServerInputs = Schema.Record(Schema.String, ServerInput)
const Document = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const parse = (content: string, source: Source, digest: string): Effect.Effect<ReadonlyArray<Server>, ConfigError> =>
  Schema.decodeEffect(Document)(content).pipe(
    Effect.mapError((cause) => ConfigError.make({ source, message: String(cause) })),
    Effect.flatMap((document) =>
      Effect.gen(function* () {
        const bare = Object.fromEntries(Object.entries(document).filter(([name]) => name !== "disabled"))
        const serverDocument = "servers" in document ? document.servers : bare
        const servers = yield* Schema.decodeUnknownEffect(ServerInputs)(serverDocument).pipe(
          Effect.mapError((cause) => ConfigError.make({ source, message: String(cause) })),
        )
        const parsed: Array<Server> = []
        for (const [name, raw] of Object.entries(servers)) {
          const hasCommand = raw.command !== undefined
          const hasUrl = raw.url !== undefined
          if (hasCommand === hasUrl)
            return yield* ConfigError.make({
              source,
              message: `Server requires exactly one of command or url: ${name}`,
            })
          if (raw.command !== undefined && raw.command.length > 0) {
            const server: LocalServer = {
              kind: "local",
              name,
              command: raw.command,
              args: raw.args ?? [],
              environment: raw.env ?? {},
              source,
              sourceDigest: digest,
            }
            if (raw.cwd !== undefined) parsed.push({ ...server, cwd: raw.cwd })
            else parsed.push(server)
            continue
          }
          if (raw.url !== undefined) {
            const remoteUrl = raw.url
            const url = yield* Effect.try({
              try: () => new URL(remoteUrl).toString(),
              catch: (cause) =>
                ConfigError.make({
                  source,
                  message: cause instanceof Error ? cause.message : String(cause),
                }),
            })
            parsed.push({ kind: "remote", name, url, headers: raw.headers ?? {}, source, sourceDigest: digest })
            continue
          }
          return yield* ConfigError.make({ source, message: `Server requires command or url: ${name}` })
        }
        return parsed
      }),
    ),
  )

export const compose = Effect.fn("McpConfig.compose")(function* (input: Input) {
  const crypto = yield* Crypto.Crypto
  const configured: Array<Server> = []
  if (input.workspace !== undefined) {
    const bytes = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(input.workspace))
      .pipe(Effect.mapError((cause) => ConfigError.make({ source: "workspace", message: String(cause) })))
    configured.push(...(yield* parse(input.workspace, "workspace", Encoding.encodeHex(bytes))))
  }
  for (const skill of input.activatedSkills ?? []) {
    for (const resource of skill.resources) {
      if (resource.path !== "mcp.json") continue
      configured.push(...(yield* parse(resource.content, `skill:${skill.name}`, skill.digest)))
    }
  }
  const names = new Set<string>()
  for (const server of configured) {
    if (names.has(server.name))
      return yield* ConfigError.make({ source: server.source, message: `Duplicate server: ${server.name}` })
    names.add(server.name)
  }
  return configured.toSorted((left, right) => left.name.localeCompare(right.name))
})
