import { Input } from "./product-operation"
export { Input }
export type ExtensionOperation = Input
import * as McpConfig from "@rika/extensions/mcp-configuration"
import * as McpOAuth from "@rika/extensions/mcp-oauth-service"
import * as SkillRegistry from "@rika/extensions/skill-registry"
import { Console, Context, Effect, FileSystem, Layer, Path, PlatformError, Schema, Semaphore } from "effect"
import { workspacePaths } from "@rika/configuration/configuration-paths"

export interface Options {
  readonly globalRoot: string
  readonly workspaceRoot: string
  readonly configPath: string
  readonly generationsPath: string
}

export class Error extends Schema.TaggedErrorClass<Error>()("@rika/product/ExtensionOperationError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly options: Options
  readonly admission: Semaphore.Semaphore
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/product/operation/contract/extension-operation/Service",
) {}

export const layer = (options: Options) => {
  const admission = Semaphore.makeUnsafe(1)
  return Layer.succeed(Service, Service.of({ options, admission }))
}

const Json = Schema.UnknownFromJsonString
const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const ExtensionRecords = Schema.Record(
  Schema.String,
  Schema.Struct({ enabled: Schema.Boolean, generation: Schema.Int }),
)
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

const writeDocumentAtomically = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  filename: string,
  value: unknown,
) =>
  fileSystem.makeDirectory(path.dirname(filename), { recursive: true }).pipe(
    Effect.andThen(
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryPath = yield* fileSystem.makeTempFileScoped({
            directory: path.dirname(filename),
            prefix: `.${path.basename(filename)}-`,
          })
          yield* fileSystem.writeFileString(temporaryPath, `${encodePrettyJson(value)}\n`)
          yield* fileSystem.rename(temporaryPath, filename)
        }),
      ),
    ),
    Effect.mapError((cause) => Error.make({ message: String(cause) })),
  )

const acquireLock = Effect.fn("ExtensionOperations.acquireLock")(function* (
  fileSystem: FileSystem.FileSystem,
  lockPath: string,
) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const result = yield* Effect.result(fileSystem.writeFileString(lockPath, "", { flag: "wx", mode: 0o600 }))
    if (result._tag === "Success") return
    if (!(result.failure.reason instanceof PlatformError.SystemError) || result.failure.reason._tag !== "AlreadyExists")
      return yield* Error.make({ message: String(result.failure) })
    yield* Effect.sleep("10 millis")
  }
  return yield* Error.make({ message: `Extension lifecycle storage is busy: ${lockPath}` })
})

const readExtensionRecords = Effect.fn("ExtensionOperations.readExtensionRecords")(function* (
  fileSystem: FileSystem.FileSystem,
  filename: string,
) {
  const state = yield* readDocument(fileSystem, filename)
  const extensions = yield* Schema.decodeUnknownEffect(ExtensionRecords)(state.extensions ?? {}).pipe(
    Effect.mapError((cause) => Error.make({ message: String(cause) })),
  )
  if (Object.values(extensions).some(({ generation }) => generation < 1))
    return yield* Error.make({ message: "Extension generations must be positive integers" })
  return extensions
})

const stringArray = (value: unknown, field: string) => {
  if (value === undefined) return Effect.succeed<ReadonlyArray<string>>([])
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return Effect.succeed(value)
  return Effect.fail(Error.make({ message: `Invalid ${field}: expected an array of strings` }))
}

const readMcpConfiguration = Effect.fn("ExtensionOperations.readMcpConfiguration")(function* (
  fileSystem: FileSystem.FileSystem,
  filename: string,
) {
  const document = yield* readDocument(fileSystem, filename)
  if (
    Object.hasOwn(document, "servers") &&
    (typeof document.servers !== "object" || document.servers === null || Array.isArray(document.servers))
  )
    return yield* Error.make({ message: "Invalid servers: expected an object" })
  const wrapped = Object.hasOwn(document, "servers")
  const servers = { ...((wrapped ? document.servers : document) as Record<string, unknown>) }
  const configured = yield* McpConfig.compose({ workspace: encodeJson({ servers }) }).pipe(
    Effect.mapError((cause) => Error.make({ message: cause.message })),
  )
  const disabledValues = yield* stringArray(wrapped ? document.disabled : undefined, "disabled")
  const disabled = new Set(disabledValues)
  const names = new Set(configured.map((server) => server.name))
  const unknownDisabled = disabledValues.find((name) => !names.has(name))
  if (unknownDisabled !== undefined)
    return yield* Error.make({ message: `Disabled MCP server not found: ${unknownDisabled}` })
  return { document, wrapped, servers, configured, disabled, names }
})

export const run = Effect.fn("ExtensionOperations.run")(function* (
  input: Extract<Input, { readonly _tag: "Skill" | "Mcp" | "Extension" }>,
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
          workspaceRoot: workspacePaths(workspace).skills,
          configPath: workspacePaths(workspace).mcpConfig,
          generationsPath: workspacePaths(workspace).extensionGenerations,
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
      const root = path.resolve(options.workspaceRoot)
      const target = path.resolve(path.join(root, input.name))
      if (path.dirname(target) !== root)
        return yield* Error.make({ message: `Skill is outside the Workspace skill directory: ${input.name}` })
      yield* fileSystem
        .remove(target, { recursive: true })
        .pipe(Effect.mapError((cause) => Error.make({ message: String(cause) })))
    } else if ("source" in input) {
      const sourcePath = path.resolve(input.source)
      const name = path.basename(sourcePath)
      const root = path.resolve(options.workspaceRoot)
      const target = path.resolve(path.join(root, name))
      if (name === "" || path.dirname(target) !== root)
        return yield* Error.make({ message: `Skill source does not name a Workspace skill: ${input.source}` })
      const source = yield* fileSystem
        .stat(sourcePath)
        .pipe(Effect.mapError((cause) => Error.make({ message: String(cause) })))
      if (source.type !== "Directory")
        return yield* Error.make({ message: `Skill source is not a directory: ${sourcePath}` })
      const manifest = path.join(sourcePath, "SKILL.md")
      const manifestInfo = yield* fileSystem
        .stat(manifest)
        .pipe(Effect.mapError((cause) => Error.make({ message: String(cause) })))
      if (manifestInfo.type !== "File")
        return yield* Error.make({ message: `Skill manifest is not a file: ${manifest}` })
      const realSource = yield* fileSystem
        .realPath(sourcePath)
        .pipe(Effect.mapError((cause) => Error.make({ message: String(cause) })))
      const realManifest = yield* fileSystem
        .realPath(manifest)
        .pipe(Effect.mapError((cause) => Error.make({ message: String(cause) })))
      const relativeManifest = path.relative(realSource, realManifest)
      if (relativeManifest.startsWith("..") || path.isAbsolute(relativeManifest))
        return yield* Error.make({ message: `Skill manifest escapes its source directory: ${manifest}` })
      const validation = yield* SkillRegistry.discover({
        globalRoot: path.join(sourcePath, ".rika-validation-empty"),
        workspaceRoot: path.dirname(sourcePath),
      }).pipe(Effect.mapError((cause) => Error.make({ message: cause.message })))
      if (
        (yield* validation.source
          .get(name)
          .pipe(Effect.mapError((cause) => Error.make({ message: cause.message })))) === undefined
      )
        return yield* Error.make({ message: `Skill source is not discoverable: ${sourcePath}` })
      yield* fileSystem
        .makeDirectory(root, { recursive: true })
        .pipe(Effect.mapError((cause) => Error.make({ message: String(cause) })))
      yield* fileSystem
        .makeDirectory(target)
        .pipe(Effect.mapError(() => Error.make({ message: `Skill already exists: ${target}` })))
      yield* fileSystem.copy(sourcePath, target, { overwrite: false }).pipe(
        Effect.mapError((cause) => Error.make({ message: String(cause) })),
        Effect.onError(() => fileSystem.remove(target, { recursive: true, force: true }).pipe(Effect.ignore)),
      )
    }
    return
  }
  if (input._tag === "Mcp") {
    if (input.action === "oauth-login" || input.action === "oauth-logout" || input.action === "oauth-status") {
      const selected = yield* service.admission.withPermit(
        readMcpConfiguration(fileSystem, options.configPath).pipe(
          Effect.map(({ configured }) => {
            const remote = configured.filter((server) => server.kind === "remote")
            return input.action === "oauth-status" && input.name === undefined
              ? remote
              : remote.filter((server) => server.name === input.name)
          }),
        ),
      )
      const name = input.name
      if (selected.length === 0 && name !== undefined)
        return yield* Error.make({ message: `Remote MCP server not found: ${name}` })
      const oauth = yield* McpOAuth.McpOAuthService
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
    return yield* service.admission.withPermit(
      Effect.gen(function* () {
        const configuration = yield* readMcpConfiguration(fileSystem, options.configPath)
        const { document, wrapped, configured, disabled, names } = configuration
        let { servers } = configuration
        if (input.action === "list" || input.action === "doctor") {
          yield* Console.log(
            encodeJson(
              configured.map((server) => ({
                name: server.name,
                kind: server.kind,
                source: server.source,
                enabled: !disabled.has(server.name),
              })),
            ),
          )
          return
        }
        if (input.action === "add" && names.has(input.name))
          return yield* Error.make({ message: `Duplicate server: ${input.name}` })
        if ("name" in input && input.action !== "add" && !names.has(input.name))
          return yield* Error.make({ message: `MCP server not found: ${input.name}` })
        if (input.action === "add") {
          const definition =
            "url" in input ? { url: input.url } : { command: input.command[0], args: input.command.slice(1) }
          servers = { ...servers, [input.name]: definition }
        }
        if (input.action === "remove") {
          delete servers[input.name]
          disabled.delete(input.name)
        }
        if (input.action === "enable") disabled.delete(input.name)
        if (input.action === "disable") disabled.add(input.name)
        yield* McpConfig.compose({ workspace: encodeJson({ servers }) }).pipe(
          Effect.mapError((cause) => Error.make({ message: cause.message })),
        )
        yield* writeDocument(fileSystem, path, options.configPath, {
          ...(wrapped ? document : {}),
          servers,
          disabled: [...disabled].toSorted(),
        })
        return
      }),
    )
  }
  if (input.action === "create-skill" || input.action === "create-plugin")
    return yield* Error.make({ message: `${input.action} is outside extension lifecycle behavior` })
  if (input.action === "list") {
    const extensions = yield* readExtensionRecords(fileSystem, options.generationsPath)
    yield* Console.log(encodeJson(extensions))
    return
  }
  yield* fileSystem
    .makeDirectory(path.dirname(options.generationsPath), { recursive: true })
    .pipe(Effect.mapError((cause) => Error.make({ message: String(cause) })))
  const lockPath = `${options.generationsPath}.lock`
  yield* Effect.acquireUseRelease(
    acquireLock(fileSystem, lockPath),
    () =>
      Effect.gen(function* () {
        const extensions = { ...(yield* readExtensionRecords(fileSystem, options.generationsPath)) }
        const current = extensions[input.name] ?? { enabled: false, generation: 1 }
        if (input.action === "enable") extensions[input.name] = { ...current, enabled: true }
        if (input.action === "disable") extensions[input.name] = { ...current, enabled: false }
        if (input.action === "rollback")
          extensions[input.name] = { ...current, generation: Math.max(1, current.generation - 1) }
        yield* writeDocumentAtomically(fileSystem, path, options.generationsPath, {
          extensions: Object.fromEntries(
            Object.entries(extensions).toSorted(([left], [right]) => left.localeCompare(right)),
          ),
        })
      }),
    () =>
      fileSystem
        .remove(lockPath, { force: true })
        .pipe(
          Effect.mapError((cause) =>
            Error.make({ message: `Could not release extension lifecycle storage: ${String(cause)}` }),
          ),
        ),
  )
})
