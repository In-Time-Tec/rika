import { McpConfig, McpOAuth, SkillRegistry } from "@rika/extensions"
import { Console, Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import type * as Operation from "./operation"

export interface Options {
  readonly globalRoot: string
  readonly workspaceRoot: string
  readonly configPath: string
  readonly trustPath: string
  readonly generationsPath: string
}

export class Error extends Schema.TaggedErrorClass<Error>()("@rika/app/ExtensionOperationError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly options: Options
}

export class Service extends Context.Service<Service, Interface>()("@rika/app/extension-operations/Service") {}

export const layer = (options: Options) => Layer.succeed(Service, Service.of({ options }))

const Json = Schema.UnknownFromJsonString
const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const encodeJson = Schema.encodeSync(Json)
const encodePrettyJson = (value: unknown, depth = 0): string => {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    const indentation = "  ".repeat(depth + 1)
    return `[\n${indentation}${value.map((item) => encodePrettyJson(item, depth + 1)).join(`,\n${indentation}`)}\n${"  ".repeat(depth)}]`
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
    if (entries.length === 0) return "{}"
    const indentation = "  ".repeat(depth + 1)
    return `{\n${indentation}${entries
      .map(([key, item]) => `${encodeJson(key)}: ${encodePrettyJson(item, depth + 1)}`)
      .join(`,\n${indentation}`)}\n${"  ".repeat(depth)}}`
  }
  return encodeJson(value)
}

const readDocument = (fileSystem: FileSystem.FileSystem, filename: string) =>
  fileSystem.exists(filename).pipe(
    Effect.flatMap((exists) => (exists ? fileSystem.readFileString(filename) : Effect.succeed("{}"))),
    Effect.flatMap(Schema.decodeUnknownEffect(JsonObject)),
    Effect.mapError((cause) => (Schema.is(Error)(cause) ? cause : Error.make({ message: String(cause) }))),
  )

const writeDocument = (fileSystem: FileSystem.FileSystem, path: Path.Path, filename: string, value: unknown) =>
  fileSystem.makeDirectory(path.dirname(filename), { recursive: true }).pipe(
    Effect.andThen(fileSystem.writeFileString(filename, `${encodePrettyJson(value)}\n`)),
    Effect.mapError((cause) => Error.make({ message: String(cause) })),
  )

export const run = Effect.fn("ExtensionOperations.run")(function* (
  input: Extract<Operation.Input, { readonly _tag: "Skill" | "Mcp" | "Extension" }>,
) {
  const service = yield* Service
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const workspace = input.clientWorkspace
  const options =
    workspace === undefined
      ? service.options
      : {
          ...service.options,
          workspaceRoot: path.join(workspace, ".rika", "skills"),
          configPath: path.join(workspace, ".rika", "mcp.json"),
          generationsPath: path.join(workspace, ".rika", "extensions.json"),
        }
  if (input._tag === "Skill") {
    if (input.action === "list") {
      const discovered = yield* SkillRegistry.discover({
        globalRoot: options.globalRoot,
        workspaceRoot: options.workspaceRoot,
      }).pipe(Effect.mapError((cause) => Error.make({ message: cause.message })))
      yield* Console.log(encodeJson(discovered.listings))
      return
    }
    if (input.action === "inspect") {
      const discovered = yield* SkillRegistry.discover({
        globalRoot: options.globalRoot,
        workspaceRoot: options.workspaceRoot,
      }).pipe(Effect.mapError((cause) => Error.make({ message: cause.message })))
      yield* Console.log(
        encodeJson(
          yield* discovered
            .activate(input.name)
            .pipe(Effect.mapError((cause) => Error.make({ message: cause.message }))),
        ),
      )
      return
    }
    if (input.action === "remove") {
      yield* fileSystem
        .remove(path.join(options.workspaceRoot, input.name), { recursive: true })
        .pipe(Effect.mapError((cause) => Error.make({ message: String(cause) })))
    } else if ("source" in input) {
      yield* fileSystem
        .copy(input.source, path.join(options.workspaceRoot, path.basename(input.source)), { overwrite: false })
        .pipe(Effect.mapError((cause) => Error.make({ message: String(cause) })))
    }
    return
  }
  if (input._tag === "Mcp") {
    const document = yield* readDocument(fileSystem, options.configPath)
    const servers =
      typeof document.servers === "object" && document.servers !== null
        ? { ...(document.servers as Record<string, unknown>) }
        : {}
    if (input.action === "oauth-login" || input.action === "oauth-logout" || input.action === "oauth-status") {
      const oauth = yield* McpOAuth.Service
      const configured = yield* McpConfig.compose({ workspace: encodeJson({ servers }) }).pipe(
        Effect.mapError((cause) => Error.make({ message: cause.message })),
      )
      const remote = configured.filter((server) => server.kind === "remote")
      const name = input.name
      const selected =
        input.action === "oauth-status" && name === undefined ? remote : remote.filter((server) => server.name === name)
      if (selected.length === 0 && name !== undefined)
        return yield* Error.make({ message: `Remote MCP server not found: ${name}` })
      if (input.action === "oauth-login")
        yield* oauth
          .login(input.name, selected[0]!.url)
          .pipe(Effect.mapError((cause) => Error.make({ message: cause.message })))
      if (input.action === "oauth-logout")
        yield* oauth
          .logout(input.name, selected[0]!.url)
          .pipe(Effect.mapError((cause) => Error.make({ message: cause.message })))
      if (input.action === "oauth-status") {
        const statuses = yield* Effect.forEach(selected, (server) =>
          oauth.status(server.name, server.url).pipe(Effect.map((status) => ({ name: server.name, status }))),
        ).pipe(Effect.mapError((cause) => Error.make({ message: cause.message })))
        yield* Console.log(encodeJson(statuses))
      }
      return
    }
    if (input.action === "list" || input.action === "doctor") {
      const composed = yield* McpConfig.compose({ workspace: encodeJson({ servers }) }).pipe(
        Effect.mapError((cause) => Error.make({ message: cause.message })),
      )
      yield* Console.log(
        encodeJson(
          composed.map((server) => ({
            name: server.name,
            kind: server.kind,
            source: server.source,
            enabled: !((document.disabled as Array<string> | undefined) ?? []).includes(server.name),
          })),
        ),
      )
      return
    }
    if (input.action === "approve") {
      const approved = new Set(
        ((yield* readDocument(fileSystem, options.trustPath)).approved as Array<string> | undefined) ?? [],
      )
      approved.add(`${input.workspace ?? options.workspaceRoot}:${input.name}`)
      yield* writeDocument(fileSystem, path, options.trustPath, { approved: [...approved].toSorted() })
      return
    }
    if (input.action === "add")
      servers[input.name] =
        "url" in input ? { url: input.url } : { command: input.command[0], args: input.command.slice(1) }
    if (input.action === "remove") delete servers[input.name]
    const disabled = new Set((document.disabled as Array<string> | undefined) ?? [])
    if (input.action === "enable") disabled.delete(input.name)
    if (input.action === "disable") disabled.add(input.name)
    yield* writeDocument(fileSystem, path, options.configPath, {
      ...document,
      servers,
      disabled: [...disabled].toSorted(),
    })
    return
  }
  const state = yield* readDocument(fileSystem, options.generationsPath)
  const extensions = {
    ...(state.extensions as Record<string, { enabled: boolean; generation: number }> | undefined),
  }
  if (input.action === "list") {
    yield* Console.log(encodeJson(extensions))
    return
  }
  const current = extensions[input.name] ?? { enabled: false, generation: 1 }
  if (input.action === "enable") extensions[input.name] = { ...current, enabled: true }
  if (input.action === "disable") extensions[input.name] = { ...current, enabled: false }
  if (input.action === "rollback")
    extensions[input.name] = { ...current, generation: Math.max(1, current.generation - 1) }
  if (input.action === "create-skill" || input.action === "create-plugin")
    return yield* Error.make({ message: `${input.action} is outside extension lifecycle behavior` })
  yield* writeDocument(fileSystem, path, options.generationsPath, { extensions })
})
