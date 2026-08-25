import * as BunServices from "@effect/platform-bun/BunServices"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as ThreadRepository from "@rika/product-store/thread-repository"
import * as TranscriptRepository from "@rika/product-store/transcript-repository"
import * as TurnRepository from "@rika/product-store/turn-repository"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { MediaAnalysisError, analyzerTestLayer } from "@rika/coding-tools/media-view-service"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import { Config, Context, Deferred, Effect, FileSystem, Layer, Path, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import {
  executionSessionLifecycleLayerTest,
  productLayer,
  Service,
  type OperationServiceInterface,
} from "./product-operation.harness"

type RepositoryContext = Context.Context<
  ThreadRepository.Service | TurnRepository.Service | TranscriptRepository.Service
>

export const startShellOperation = Effect.fn("ShellSession.startOperation")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem
  readonly path: Path.Path
}) {
  const { fileSystem } = input

  const temporaryDirectory = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"))
  const workspace = yield* fileSystem.makeTempDirectoryScoped({
    directory: temporaryDirectory,
    prefix: "rika-shell-session-",
  })
  const repositoryLayer: Layer.Layer<ThreadRepository.Service> = ThreadRepository.memoryLayer().pipe(Layer.orDie)
  const turnRepositoryLayer: Layer.Layer<TurnRepository.Service> = TurnRepository.memoryLayer().pipe(Layer.orDie)
  const transcriptRepositoryLayer: Layer.Layer<TranscriptRepository.Service> = TranscriptRepository.memoryLayer().pipe(
    Layer.orDie,
  )
  const sessionReady = yield* Deferred.make<InteractiveSession.InteractiveSession>()
  const releaseSession = yield* Deferred.make<void>()
  let nextTurn = 0
  const executionReads: Array<"inspect"> = []
  const backend = ExecutionGateway.Service.of({
    ...ExecutionGateway.makeTest(),
    startTurn: () => Effect.die("unused"),
    cancelTurn: () => Effect.die("unused"),
    steerTurn: () => Effect.die("unused"),
    approveTurn: () => Effect.void,
    denyTurn: () => Effect.void,
    watchTurn: () => Stream.die("unused"),
    inspectTurn: () =>
      Effect.sync(() => {
        executionReads.push("inspect")
        return { status: "unavailable" as const }
      }),
  })
  const repositories: RepositoryContext = yield* Layer.buildWithScope(
    Layer.mergeAll(repositoryLayer, turnRepositoryLayer, transcriptRepositoryLayer),
    yield* Effect.scope,
  )
  const sharedRepositories = Layer.succeedContext(repositories)
  const operationLayer: Layer.Layer<Service, never, never> = productLayer({
    executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
    repositoryLayer: sharedRepositories,
    turnRepositoryLayer: sharedRepositories,
    transcriptRepositoryLayer: sharedRepositories,
    backendLayer: Layer.succeed(ExecutionGateway.Service, backend),
    toolRuntimeLayer: (directory) =>
      ToolRuntime.layer(directory).pipe(
        Layer.provide(
          analyzerTestLayer(() => Effect.fail(MediaAnalysisError.make({ message: "Media analysis is unavailable" }))),
        ),
        Layer.provide(
          Layer.merge(WebSearch.factoryLayer([]), ReadWebPage.layer({})).pipe(Layer.provide(FetchHttpClient.layer)),
        ),
        Layer.provide(BunServices.layer),
        Layer.orDie,
      ),
    defaultWorkspace: workspace,
    makeThreadId: Effect.succeed(Thread.ThreadId.make("shell-thread")),
    makeTurnId: Effect.sync(() => Turn.TurnId.make(`shell-turn-${nextTurn++}`)),
    interactive: (_, session) =>
      Deferred.succeed(sessionReady, session).pipe(Effect.andThen(Deferred.await(releaseSession))),
  }).pipe(Layer.orDie)
  const operation: OperationServiceInterface = Context.get(
    yield* Layer.buildWithScope(operationLayer, yield* Effect.scope),
    Service,
  )
  const operationFiber = yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
  const session = yield* Deferred.await(sessionReady)
  return { workspace, repositoryLayer, repositories, operationFiber, session, releaseSession, executionReads }
})
