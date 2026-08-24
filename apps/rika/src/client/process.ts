#!/usr/bin/env bun
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import * as HostedObservability from "@rika/product/hosted-observability"
import * as ProductOperation from "@rika/product/product-operation"
import * as Operation from "@rika/product/product-operation-service"
import { Config, Context, Crypto, Deferred, Effect, FileSystem, Layer, Option, Path, Schema, Stdio } from "effect"
import { HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { Command } from "effect/unstable/cli"
import { command, version } from "../command/root/rika"
import * as HostedCommand from "../command/root/hosted"
import * as RunnerCommand from "../command/root/runner"
import * as Runner from "../runner/service"
import * as HostedCli from "../hosted/cli"
import { runHostedInteractive } from "../hosted/interactive-controller"
import * as Logging from "../diagnostics/file-logging"
import { clientSigintOwnership, type SigintOwnership } from "./signal-ownership"

const provideLayerScoped =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scopedWith((scope) =>
      Effect.context<RIn | Exclude<R, ROut>>().pipe(
        Effect.flatMap((parent) =>
          Layer.buildWithScope(layer, scope).pipe(
            Effect.flatMap((context) => effect.pipe(Effect.provideContext(Context.merge(parent, context)))),
          ),
        ),
      ),
    )

const operationFailure = (input: ProductOperation.Input, error: unknown) =>
  Schema.is(ProductOperation.OperationUnavailable)(error)
    ? error
    : ProductOperation.OperationUnavailable.make({ operation: input._tag, message: String(error) })

type InterruptibleRoot = { readonly interruptUnsafe: () => void }
type SignalEmitter = {
  readonly on: (event: "SIGINT", handler: () => void) => unknown
  readonly off: (event: "SIGINT", handler: () => void) => unknown
}

export const installClientSigintHandler = (input: {
  readonly rootFiber: () => InterruptibleRoot | undefined
  readonly onSignal: () => void
  readonly ownership?: SigintOwnership
  readonly process?: SignalEmitter
}) => {
  const ownership = input.ownership ?? clientSigintOwnership
  const processEmitter = input.process ?? (process as unknown as SignalEmitter)
  const handler = () => {
    if (!ownership.rootOwns()) return
    input.onSignal()
    input.rootFiber()?.interruptUnsafe()
  }
  processEmitter.on("SIGINT", handler)
  return () => processEmitter.off("SIGINT", handler)
}

export const runInProcessInteractive = Effect.fn("ClientMain.runInProcessInteractive")(function* <A, E, R, E2, R2>(
  runner: Effect.Effect<never, E, R>,
  interactive: Effect.Effect<A, E2, R2>,
) {
    yield* runner.pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    return yield* interactive
})

const dispatcherLayer = () =>
  Layer.effect(
    Operation.Service,
    Effect.gen(function* () {
      const persistence = yield* Effect.serviceOption(Logging.DiagnosticPersistence)
      const startLogging = Option.match(persistence, {
        onNone: () => Effect.void,
        onSome: (service) => Logging.start.pipe(Effect.provideService(Logging.DiagnosticPersistence, service)),
      })
      const platform = yield* Effect.context<
        | Crypto.Crypto
        | FileSystem.FileSystem
        | Path.Path
        | Stdio.Stdio
        | ChildProcessSpawner.ChildProcessSpawner
        | HttpClient.HttpClient
      >()
      return Operation.Service.of({
        run: Effect.fn("ClientMain.dispatch")(function* (input) {
          yield* HostedObservability.event("process_start", "success", {})
          if (input._tag !== "Interactive") yield* startLogging.pipe(Effect.orDie)
          return yield* Effect.gen(function* () {
            if (input._tag !== "Interactive")
              return yield* ProductOperation.OperationUnavailable.make({
                operation: input._tag,
                message: `${input._tag} has no hosted command implementation`,
              })
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const environment = yield* Config.all({
                  home: Config.option(Config.string("HOME")),
                  visual: Config.option(Config.string("VISUAL")),
                  editor: Config.option(Config.string("EDITOR")),
                })
                const home = Option.getOrElse(environment.home, () => process.cwd())
                const editor = Option.getOrUndefined(environment.visual) ?? Option.getOrUndefined(environment.editor)
                const runtimePlatform = Layer.mergeAll(BunCrypto.layer, BunSocket.layerWebSocketConstructor)
                const hosted = HostedCli.liveLayer(home).pipe(Layer.provide(runtimePlatform))
                const admission = Runner.liveAdmissionLayer.pipe(Layer.provide(hosted))
                const runnerInput = {
                  workspace: input.workspace ?? process.cwd(),
                  preferencePath: yield* Runner.preferencePath,
                }
                const firstDraw = yield* Deferred.make<void>()
                const firstDrawContext = yield* Effect.context<never>()
                const runFirstDraw = Effect.runSyncWith(firstDrawContext)
                yield* Deferred.await(firstDraw).pipe(Effect.andThen(startLogging), Effect.orDie, Effect.forkScoped)
                return yield* runHostedInteractive(input, {
                  editor,
                  onFirstDraw: () =>
                    runFirstDraw(
                      HostedObservability.event("first_draw", "success", {}).pipe(
                        Effect.ensuring(Deferred.succeed(firstDraw, undefined)),
                      ),
                    ),
                  startRunner: (prepared) => Runner.runRunner(runnerInput, prepared),
                }).pipe(provideLayerScoped(Layer.mergeAll(runtimePlatform, hosted, admission)))
              }),
            )
          }).pipe(
            Effect.provide(platform),
            Effect.mapError((error) => operationFailure(input, error)),
          )
        }),
      })
    }),
  )

const hostedCommandLayer = Layer.effect(
  HostedCommand.Service,
  Effect.gen(function* () {
    const platform = yield* Effect.context<
      | Crypto.Crypto
      | FileSystem.FileSystem
      | Path.Path
      | ChildProcessSpawner.ChildProcessSpawner
      | HttpClient.HttpClient
    >()
    return HostedCommand.Service.of({
      run: (input) =>
        Effect.gen(function* () {
          const home = yield* Config.string("HOME").pipe(Effect.orElseSucceed(() => process.cwd()))
          const hosted = yield* Effect.tryPromise({
            try: () => import("../hosted/cli"),
            catch: () =>
              ProductOperation.OperationUnavailable.make({
                operation: input._tag,
                message: "Hosted account support could not be loaded",
              }),
          })
          return yield* provideLayerScoped(hosted.liveLayer(home))(hosted.run(input))
        }).pipe(Effect.provide(platform)),
    })
  }),
)

const runnerCommandLayer = Layer.effect(
  RunnerCommand.Service,
  Effect.gen(function* () {
    const platform = yield* Effect.context<
      | Crypto.Crypto
      | FileSystem.FileSystem
      | Path.Path
      | ChildProcessSpawner.ChildProcessSpawner
      | HttpClient.HttpClient
    >()
    return RunnerCommand.Service.of({
      run: (input) =>
        Effect.gen(function* () {
          const home = yield* Config.string("HOME").pipe(Config.withDefault(process.cwd()))
          const preferencePath = yield* Runner.preferencePath
          const hosted = HostedCli.liveLayer(home)
          return yield* Runner.runRunner({
            workspace: input.workspace ?? process.cwd(),
            preferencePath,
            ...(input.remoteThreadCreation === undefined ? {} : { requestedPreference: input.remoteThreadCreation }),
          }).pipe(
            Effect.scoped,
            provideLayerScoped(Layer.merge(hosted, Runner.liveAdmissionLayer.pipe(Layer.provide(hosted)))),
          )
        }).pipe(
          Effect.provide(platform),
          Effect.mapError((error) =>
            ProductOperation.OperationUnavailable.make({ operation: "Runner", message: error.message }),
          ),
        ),
    })
  }),
)

export const run = Effect.fn("ClientMain.run")(function* (argv?: ReadonlyArray<string>) {
  const program = (
    argv === undefined ? Command.run(command, { version }) : Command.runWith(command, { version })(argv)
  ).pipe(
    Effect.annotateLogs({
      "rika.process.role": "client",
      "rika.process.pid": process.pid,
      "rika.version": version,
    }),
  )
  return yield* program.pipe(
    provideLayerScoped(Layer.mergeAll(dispatcherLayer(), hostedCommandLayer, runnerCommandLayer)),
  )
})
