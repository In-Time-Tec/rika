import * as Configuration from "@rika/configuration/configuration-service"
import { Decoder } from "@rika/configuration/configuration-settings"
import { globalPaths, workspacePaths } from "@rika/configuration/configuration-paths"
import * as McpOAuth from "@rika/extensions/mcp-oauth-service"
import * as SkillRegistry from "@rika/extensions/skill-registry"
import * as ConfigOperations from "@rika/product/configuration-operation"
import * as ExtensionOperations from "@rika/product/extension-operation"
import * as ToolCatalog from "@rika/product/native-tool-catalog"
import * as ProductOperation from "@rika/product/product-operation"
import { Config, Console, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { provideLayerScoped } from "../platform/provide"

export const run = Effect.fn("LocalOperations.run")(function* (input: ProductOperation.Input) {
  const unavailable = (message: string) =>
    ProductOperation.OperationUnavailable.make({ operation: input._tag, message })
  if (input._tag === "ToolCatalog") {
    const value = input.action === "list" ? ToolCatalog.definitions : ToolCatalog.get(input.name)
    if (value === undefined)
      return yield* unavailable(`Tool ${input.action === "show" ? input.name : ""} does not exist`)
    return yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(Effect.flatMap(Console.log))
  }
  const home = yield* Config.string("HOME").pipe(Config.withDefault(process.cwd()))
  const global = globalPaths(home)
  const workspace = workspacePaths(
    "clientWorkspace" in input ? (input.clientWorkspace ?? process.cwd()) : process.cwd(),
  )
  if (input._tag === "Skill" || input._tag === "Mcp" || input._tag === "Extension") {
    const oauth = McpOAuth.layer.pipe(
      Layer.provide(McpOAuth.OAuthHost.hostLayer),
      Layer.provide(McpOAuth.OAuthHost.tokenStoreLayer(global.mcpOAuth)),
    )
    return yield* ExtensionOperations.run(input).pipe(
      provideLayerScoped(
        Layer.mergeAll(
          oauth,
          SkillRegistry.layer,
          ExtensionOperations.layer({
            globalRoot: global.skills,
            workspaceRoot: workspace.skills,
            configPath: workspace.mcpConfig,
            generationsPath: workspace.extensionGenerations,
          }),
        ),
      ),
      Effect.mapError((error) => unavailable(error.message)),
    )
  }
  if (input._tag !== "Config" && input._tag !== "Doctor") return yield* unavailable(`${input._tag} is not implemented`)
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const adapter = ConfigOperations.Adapter.of({
    exists: (filename) =>
      fileSystem
        .exists(filename)
        .pipe(Effect.mapError((error) => ConfigOperations.AdapterError.make({ message: error.message }))),
    edit: (filename) =>
      Effect.gen(function* () {
        const visual = yield* Config.option(Config.string("VISUAL"))
        const editor = yield* Config.option(Config.string("EDITOR"))
        const command = Option.getOrUndefined(visual) ?? Option.getOrUndefined(editor)
        if (command === undefined || command.trim() === "")
          return yield* ConfigOperations.AdapterError.make({ message: "Set VISUAL or EDITOR to edit settings" })
        yield* fileSystem.makeDirectory(path.dirname(filename), { recursive: true })
        const code = yield* spawner.exitCode(
          ChildProcess.make("sh", ["-c", `${command} "$1"`, "rika-config-edit", filename], {
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          }),
        )
        if (code !== 0) return yield* ConfigOperations.AdapterError.make({ message: `Editor exited with code ${code}` })
      }).pipe(Effect.mapError((error) => ConfigOperations.AdapterError.make({ message: error.message }))),
  })
  const readSettings = (filename: string) =>
    Effect.gen(function* () {
      if (!(yield* fileSystem.exists(filename))) return {}
      const text = yield* fileSystem.readFileString(filename)
      const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
        Effect.mapError(() => unavailable(`Invalid settings in ${filename}`)),
      )
      return yield* Effect.try({
        try: () => Decoder.decodeSettingsInput(filename, decoded),
        catch: () => unavailable(`Invalid settings in ${filename}`),
      })
    })
  // Editing must remain possible when the current settings are invalid.
  if (input._tag === "Config" && input.action === "edit")
    return yield* adapter.edit(input.workspace ? workspace.settings : global.settings)
  const configuration = Configuration.liveConfigurationLayer({
    global: yield* readSettings(global.settings),
    workspace: yield* readSettings(workspace.settings),
    webProviders: [],
  })
  return yield* ConfigOperations.run(input, {
    globalConfigPath: global.settings,
    workspaceConfigPath: workspace.settings,
  }).pipe(
    Effect.provideService(ConfigOperations.Adapter, adapter),
    provideLayerScoped(configuration),
    Effect.mapError((error) => unavailable(error.message)),
  )
})
