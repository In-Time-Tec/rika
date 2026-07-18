import { Crypto, Effect, Encoding, Schema } from "effect"

export type Source = "workspace" | `skill:${string}`

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

export interface Input {
  readonly workspace?: string
  readonly activatedSkills?: ReadonlyArray<{
    readonly name: string
    readonly digest: string
    readonly resources: ReadonlyArray<{ readonly path: string; readonly content: string }>
  }>
}

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("@rika/extensions/McpConfigError", {
  source: Schema.String,
  message: Schema.String,
}) {}

const record = (value: unknown): Readonly<Record<string, string>> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  return entries.every(([, item]) => typeof item === "string") ? Object.fromEntries(entries) : undefined
}

const parse = (content: string, source: Source, digest: string): Effect.Effect<ReadonlyArray<Server>, ConfigError> =>
  Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(content).pipe(
    Effect.mapError((cause) => ConfigError.make({ source, message: String(cause) })),
    Effect.flatMap((document) =>
      Effect.try({
        try: () => {
          if (typeof document !== "object" || document === null || Array.isArray(document))
            throw new Error("Expected object")
          const servers = "servers" in document ? document.servers : document
          if (typeof servers !== "object" || servers === null || Array.isArray(servers))
            throw new Error("Expected servers object")
          const parsed: Array<Server> = []
          for (const [name, raw] of Object.entries(servers)) {
            if (typeof raw !== "object" || raw === null || Array.isArray(raw))
              throw new Error(`Invalid server: ${name}`)
            const hasCommand = "command" in raw
            const hasUrl = "url" in raw
            if (hasCommand === hasUrl) throw new Error(`Server requires exactly one of command or url: ${name}`)
            if (hasCommand && typeof raw.command === "string" && raw.command.length > 0) {
              const args = "args" in raw ? raw.args : []
              const environment = "env" in raw ? record(raw.env) : {}
              if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string") || environment === undefined)
                throw new Error(`Invalid local server: ${name}`)
              const cwd = "cwd" in raw ? raw.cwd : undefined
              if (cwd !== undefined && typeof cwd !== "string") throw new Error(`Invalid cwd: ${name}`)
              parsed.push({
                kind: "local",
                name,
                command: raw.command,
                args,
                environment,
                cwd,
                source,
                sourceDigest: digest,
              })
              continue
            }
            if (hasUrl && typeof raw.url === "string") {
              const headers = "headers" in raw ? record(raw.headers) : {}
              if (headers === undefined) throw new Error(`Invalid headers: ${name}`)
              const url = new URL(raw.url).toString()
              parsed.push({ kind: "remote", name, url, headers, source, sourceDigest: digest })
              continue
            }
            throw new Error(`Server requires command or url: ${name}`)
          }
          return parsed
        },
        catch: (cause) => ConfigError.make({ source, message: cause instanceof Error ? cause.message : String(cause) }),
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
