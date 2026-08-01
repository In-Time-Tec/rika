import * as ProductOperation from "@rika/product/product-operation"
import { OperationUnavailable } from "@rika/product/product-operation"
import * as ConfigurationService from "@rika/configuration/configuration-service"
import * as SettingsDecoder from "@rika/configuration/configuration-settings"
import * as ConfigurationSettingsInput from "@rika/configuration/configuration-settings"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as ConfigOperations from "@rika/product/configuration-operation"
import { productLayer, Service } from "@rika/product/product-operation-service"
import * as Database from "@rika/product-store/product-database-layer"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/relay-execution/relay-execution-layer"
import * as WebSearchProvider from "@rika/coding-tools/web-search-provider"
import { Cause, ConfigProvider, Effect, Exit, FileSystem, Layer, Path, Schema, Scope } from "effect"
import { TestConsole } from "effect/testing"
import { expect, it } from "@effect/vitest"
import { run } from "../src/command"

const NamedItemsJson = Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String })))
const NamedItemJson = Schema.fromJsonString(Schema.Struct({ name: Schema.String }))
const ThreadStruct = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  pinned: Schema.Boolean,
  archived: Schema.Boolean,
  labels: Schema.Array(Schema.String),
})
const ThreadJson = Schema.fromJsonString(ThreadStruct)
const ThreadsJson = Schema.fromJsonString(Schema.Array(ThreadStruct))
const PresenceStatus = Schema.Literals(["present", "missing"])
const CredentialStatus = Schema.Literals(["present", "missing", "not-configured"])
const DoctorReport = Schema.fromJsonString(
  Schema.Struct({
    databases: Schema.Struct({ product: PresenceStatus, execution: PresenceStatus }),
    config: Schema.Struct({
      diagnostics: Schema.Array(Schema.Struct({ path: Schema.String, source: Schema.String, message: Schema.String })),
      global: PresenceStatus,
      workspace: PresenceStatus,
    }),
    credentials: Schema.Struct({ webSearch: Schema.Record(Schema.String, PresenceStatus) }),
    model: Schema.Struct({
      route: Schema.Struct({ alias: Schema.String, providerId: Schema.String, model: Schema.String }),
      apiKey: CredentialStatus,
    }),
  }),
)

const backend = ExecutionBackend.Service.of({
  invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
  resolveInvocationSource: () => Effect.die("unused"),
  createFanOut: () => Effect.die("unused"),
  inspectFanOut: () => Effect.die("unused"),
  cancelFanOut: () => Effect.die("unused"),
  registerWorkflows: () => Effect.die("unused"),
  startWorkflow: () => Effect.die("unused"),
  inspectWorkflow: () => Effect.die("unused"),
  cancelWorkflow: () => Effect.die("unused"),
  start: (input) => Effect.succeed({ turnId: input.turnId, status: "completed", events: [] }),
  replay: (turnId) => Effect.succeed({ turnId, status: "completed", events: [] }),
  cancel: (turnId) => Effect.succeed({ turnId, status: "cancelled", events: [] }),
  inspect: () => Effect.void.pipe(Effect.as(undefined)),
  steer: (turnId) => Effect.succeed({ steeringMessageId: `steering:${turnId}:steering:0`, sequence: 0 }),
})

const withServices = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((services) => Effect.provide(effect, services))))

interface CliSandbox {
  readonly root: string
  readonly workspace: string
  readonly databasePath: string
  readonly executionDatabasePath: string
  readonly globalConfigPath: string
  readonly workspaceConfigPath: string
  readonly adapter: ConfigOperations.AdapterInterface
}

const sandbox = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-cli-operations-" })
  const workspace = path.join(root, "workspace")
  yield* fileSystem.makeDirectory(workspace)
  const adapter: ConfigOperations.AdapterInterface = {
    exists: (target) =>
      fileSystem
        .exists(target)
        .pipe(Effect.mapError((error) => ConfigOperations.AdapterError.make({ message: String(error) }))),
    edit: () => Effect.void,
  }
  const context: CliSandbox = {
    root,
    workspace,
    databasePath: path.join(root, "rika.db"),
    executionDatabasePath: path.join(root, "execution.db"),
    globalConfigPath: path.join(root, "home", ".config", "rika", "settings.json"),
    workspaceConfigPath: path.join(workspace, ".rika", "settings.json"),
    adapter,
  }
  return context
})

let identifierSequence = 0

const configServiceLayer = (input: {
  readonly workspace?: ConfigurationSettingsInput.Input.SettingsInput
  readonly env?: Readonly<Record<string, string>>
}) =>
  ConfigurationService.liveConfigurationLayer({
    webProviders: WebSearchProvider.providerRegistry,
    global: {},
    workspace: input.workspace ?? {},
  }).pipe(
    Layer.provide(Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: input.env ?? {} }))),
    Layer.orDie,
  )

const operationLayer = (
  context: CliSandbox,
  options: {
    readonly config?: {
      readonly workspace?: ConfigurationSettingsInput.Input.SettingsInput
      readonly env?: Readonly<Record<string, string>>
    }
  } = {},
) => {
  const database = Database.layer(context.databasePath)
  const repositoryLayer = ThreadRepository.layer.pipe(Layer.provide(database), Layer.provide(BunServices.layer))
  const turnRepositoryLayer = TurnRepository.layer.pipe(Layer.provide(database), Layer.provide(BunServices.layer))
  const transcriptRepositoryLayer = TranscriptRepository.layer.pipe(
    Layer.provide(database),
    Layer.provide(BunServices.layer),
  )
  return productLayer({
    repositoryLayer,
    turnRepositoryLayer,
    transcriptRepositoryLayer,
    backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
    defaultWorkspace: context.workspace,
    makeThreadId: Effect.sync(() => Thread.ThreadId.make(`cli-thread-${(identifierSequence += 1)}`)),
    makeTurnId: Effect.sync(() => Turn.TurnId.make(`cli-turn-${(identifierSequence += 1)}`)),
    configOperations: {
      layer: Layer.merge(ConfigOperations.testLayer(context.adapter), configServiceLayer(options.config ?? {})),
      options: {
        globalConfigPath: context.globalConfigPath,
        workspaceConfigPath: context.workspaceConfigPath,
        productDatabasePath: context.databasePath,
        executionDatabasePath: context.executionDatabasePath,
      },
    },
    interactive: () => Effect.void,
  })
}

interface CliResult {
  readonly exit: Exit.Exit<unknown, unknown>
  readonly lines: ReadonlyArray<string>
  readonly errors: ReadonlyArray<string>
}

const openCli = <E>(layer: Layer.Layer<Service, E>) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const context = yield* Layer.buildWithScope(Layer.mergeAll(BunServices.layer, TestConsole.layer, layer), scope)
    const invoke = (argv: ReadonlyArray<string>): Effect.Effect<CliResult> =>
      Effect.gen(function* () {
        const logsBefore = (yield* TestConsole.logLines).length
        const errorsBefore = (yield* TestConsole.errorLines).length
        const exit = yield* Effect.exit(run(argv))
        const lines = (yield* TestConsole.logLines).slice(logsBefore).map(String)
        const errors = (yield* TestConsole.errorLines).slice(errorsBefore).map(String)
        return { exit, lines, errors }
      }).pipe(Effect.provide(context))
    return { invoke }
  })

const jsonOutput = (result: CliResult) => {
  const line = result.lines.findLast((candidate) => candidate.startsWith("{") || candidate.startsWith("["))
  expect(line, result.lines.join("\n")).toBeDefined()
  return line!
}

const expectSuccess = (result: CliResult) => {
  expect(Exit.isSuccess(result.exit), String(result.exit)).toBe(true)
  return result
}

const expectFailureMessage = (result: CliResult) => {
  expect(result.exit._tag).toBe("Failure")
  const failure = result.exit._tag === "Failure" ? Cause.squash(result.exit.cause) : undefined
  return Schema.is(OperationUnavailable)(failure) || Schema.is(InvalidInput)(failure)
    ? failure.message
    : String(failure)
}

it.effect(
  "help and version answer locally without dispatching an operation",
  () =>
    withServices(
      Effect.gen(function* () {
        const context = yield* sandbox
        const cli = yield* openCli(operationLayer(context))
        const help = expectSuccess(yield* cli.invoke(["--help"]))
        expect(help.lines.join("\n")).toContain("Local durable coding agent")
        const versionFlag = expectSuccess(yield* cli.invoke(["--version"]))
        expect(versionFlag.lines.join("\n")).toContain("0.0.0")
        const versionCommand = expectSuccess(yield* cli.invoke(["version"]))
        expect(versionCommand.lines.join("\n")).toContain("0.0.0")
      }),
    ),
  20_000,
)

it.effect(
  "tools list and show expose the catalog and reject unknown tools",
  () =>
    withServices(
      Effect.gen(function* () {
        const context = yield* sandbox
        const cli = yield* openCli(operationLayer(context))
        const listed = expectSuccess(yield* cli.invoke(["tools", "list"]))
        const tools = yield* Schema.decodeUnknownEffect(NamedItemsJson)(jsonOutput(listed))
        expect(tools.some((tool) => tool.name === "read")).toBe(true)
        const shown = expectSuccess(yield* cli.invoke(["tools", "show", "read"]))
        expect((yield* Schema.decodeUnknownEffect(NamedItemJson)(jsonOutput(shown))).name).toBe("read")
        const missing = yield* cli.invoke(["tools", "show", "missing-tool"])
        expect(expectFailureMessage(missing)).toContain("Tool missing-tool does not exist")
      }),
    ),
  20_000,
)

it.effect(
  "rejects an unknown initial interactive thread",
  () =>
    withServices(
      Effect.gen(function* () {
        const context = yield* sandbox
        const cli = yield* openCli(operationLayer(context))
        const invalid = yield* cli.invoke(["--thread", "missing-interactive-thread"])
        expect(expectFailureMessage(invalid)).toContain("Thread missing-interactive-thread does not exist")
      }),
    ),
  20_000,
)

it.effect(
  "doctor reports databases, config, credentials, and model with a stable shape",
  () =>
    withServices(
      Effect.gen(function* () {
        const context = yield* sandbox
        const cli = yield* openCli(operationLayer(context))
        const result = expectSuccess(yield* cli.invoke(["doctor"]))
        const report = yield* Schema.decodeUnknownEffect(DoctorReport)(jsonOutput(result))
        expect(Object.keys(report).toSorted()).toEqual(["config", "credentials", "databases", "model"])
        expect(report.databases).toEqual({ product: "present", execution: "missing" })
        expect(report.config).toMatchObject({ diagnostics: [], global: "missing", workspace: "missing" })
      }),
    ),
  20_000,
)

it.effect(
  "doctor reports credential presence without disclosing configured secrets",
  () =>
    withServices(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const context = yield* sandbox
        const settingsInput = {
          providers: { openai: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "DOCTOR_MODEL_KEY" } },
        }
        const settingsJson = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(settingsInput)
        yield* fileSystem.makeDirectory(path.dirname(context.workspaceConfigPath), { recursive: true })
        yield* fileSystem.writeFileString(context.workspaceConfigPath, settingsJson)
        const workspaceSettings = SettingsDecoder.Decoder.decodeSettingsInput(
          context.workspaceConfigPath,
          settingsInput,
        )
        const cli = yield* openCli(
          operationLayer(context, {
            config: {
              workspace: workspaceSettings,
              env: {
                DOCTOR_MODEL_KEY: "doctor-model-secret",
                PARALLEL_API_KEY: "doctor-parallel-secret",
              },
            },
          }),
        )
        const result = expectSuccess(yield* cli.invoke(["doctor"]))
        const report = yield* Schema.decodeUnknownEffect(DoctorReport)(jsonOutput(result))
        expect(report.config.workspace).toBe("present")
        expect(report.config.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
          "providers",
          "webSearchCredentials.parallel",
          "providerCredentials.DOCTOR_MODEL_KEY",
        ])
        expect(report.credentials.webSearch).toEqual({ parallel: "present" })
        expect(report.model).toMatchObject({
          route: { alias: "terra", providerId: "openai", model: "gpt-5.6-terra" },
          apiKey: "present",
        })
        const output = [...result.lines, ...result.errors].join("\n")
        expect(output).not.toContain("doctor-model-secret")
        expect(output).not.toContain("doctor-parallel-secret")
      }),
    ),
  20_000,
)

it.effect(
  "threads create and list round-trip through the product database",
  () =>
    withServices(
      Effect.gen(function* () {
        const context = yield* sandbox
        const created = yield* Effect.scoped(
          Effect.gen(function* () {
            const cli = yield* openCli(operationLayer(context))
            const first = yield* Schema.decodeUnknownEffect(ThreadJson)(
              jsonOutput(expectSuccess(yield* cli.invoke(["threads", "create"]))),
            )
            const second = yield* Schema.decodeUnknownEffect(ThreadJson)(
              jsonOutput(expectSuccess(yield* cli.invoke(["threads", "create"]))),
            )
            expect(second.id).not.toBe(first.id)
            const listed = yield* Schema.decodeUnknownEffect(ThreadsJson)(
              jsonOutput(expectSuccess(yield* cli.invoke(["threads", "list"]))),
            )
            expect(listed.map((thread) => thread.id).toSorted()).toEqual([first.id, second.id].toSorted())
            return [first.id, second.id]
          }),
        )
        const relisted = yield* Effect.scoped(
          Effect.gen(function* () {
            const cli = yield* openCli(operationLayer(context))
            return yield* Schema.decodeUnknownEffect(ThreadsJson)(
              jsonOutput(expectSuccess(yield* cli.invoke(["threads", "list"]))),
            )
          }),
        )
        expect(relisted.map((thread) => thread.id).toSorted()).toEqual(created.toSorted())
        for (const thread of relisted) {
          expect(thread.title).toBe("New thread")
          expect(thread.archived).toBe(false)
        }
      }),
    ),
  30_000,
)
