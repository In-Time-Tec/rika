import { InvalidInput, OperationUnavailable } from "@rika/product/product-operation"
import * as ConfigurationService from "@rika/configuration/configuration-service"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as ConfigOperations from "@rika/product/configuration-operation"
import { executionSessionLifecycleLayerTest, productLayer, Service } from "./product-operation-test-layer"
import * as ThreadRepository from "@rika/product-store/postgres-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/postgres-transcript-repository"
import * as TurnRepository from "@rika/product-store/postgres-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as WebSearchProvider from "@rika/coding-tools/web-search-provider"
import { Cause, ConfigProvider, Effect, Exit, FileSystem, Layer, Path, Schema, Scope, Stream } from "effect"
import { TestConsole } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { expect, it } from "@effect/vitest"
import { run } from "../src/command/root/rika-command"

const backend = ExecutionGateway.Service.of({
  startTurn: (input) =>
    Effect.succeed({ runId: `opaque-run:${input.turnId}`, turnId: input.turnId, threadId: input.threadId }),
  cancelTurn: () => Effect.void,
  steerTurn: () => Effect.succeed({ entryId: "test-steering", sequence: 0 }),
  approveTurn: () => Effect.void,
  denyTurn: () => Effect.void,
  watchTurn: () => Stream.empty,
  inspectTurn: () => Effect.succeed({ status: "unavailable" }),
})

const withServices = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((services) => Effect.provide(effect, services))))

interface CliSandbox {
  readonly root: string
  readonly workspace: string
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
    globalConfigPath: path.join(root, "home", ".config", "rika", "settings.json"),
    workspaceConfigPath: path.join(workspace, ".rika", "settings.json"),
    adapter,
  }
  return context
})

let identifierSequence = 0

const configServiceLayer = ConfigurationService.liveConfigurationLayer({
  webProviders: WebSearchProvider.providerRegistry,
  global: {},
  workspace: {},
}).pipe(Layer.provide(Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} }))), Layer.orDie)

const operationLayer = (context: CliSandbox) => {
  const repositoryLayer = ThreadRepository.memoryLayer()
  const turnRepositoryLayer = TurnRepository.memoryLayer()
  const transcriptRepositoryLayer = TranscriptRepository.memoryLayer()
  return productLayer({
    executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
    repositoryLayer,
    turnRepositoryLayer,
    transcriptRepositoryLayer,
    backendLayer: Layer.succeed(ExecutionGateway.Service, backend),
    defaultWorkspace: context.workspace,
    makeThreadId: Effect.sync(() => Thread.ThreadId.make(`cli-thread-${(identifierSequence += 1)}`)),
    makeTurnId: Effect.sync(() => Turn.TurnId.make(`cli-turn-${(identifierSequence += 1)}`)),
    configOperations: {
      layer: Layer.mergeAll(ConfigOperations.testLayer(context.adapter), configServiceLayer, BunServices.layer),
      options: {
        globalConfigPath: context.globalConfigPath,
        workspaceConfigPath: context.workspaceConfigPath,
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
    const context = yield* Layer.buildWithScope(
      Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, TestConsole.layer, layer),
      scope,
    )
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
        expect(help.lines.join("\n")).toContain("Hosted durable coding agent")
        const versionFlag = expectSuccess(yield* cli.invoke(["--version"]))
        expect(versionFlag.lines.join("\n")).toContain("0.0.0")
        const versionCommand = expectSuccess(yield* cli.invoke(["version"]))
        expect(versionCommand.lines.join("\n")).toContain("0.0.0")
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
