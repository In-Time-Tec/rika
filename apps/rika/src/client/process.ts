#!/usr/bin/env bun
import * as HostedObservability from "@rika/product/hosted-observability"
import * as ProductOperation from "@rika/product/product-operation"
import * as Operation from "@rika/product/product-operation-service"
import { Cause, Config, Console, Crypto, Effect, FileSystem, Layer, Option, Path, Schema, Stdio } from "effect"
import { HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { CliError, Command } from "effect/unstable/cli"
import { command, version } from "../command/root/rika"
import * as HostedCommand from "../command/root/hosted"
import * as RunnerCommand from "../command/root/runner"
import * as Logging from "../diagnostics/file-logging"
import { provideLayerScoped } from "../platform/provide"

type OperationFailure = ProductOperation.OperationUnavailable | Error

const operationFailure = (input: ProductOperation.Input, error: OperationFailure) =>
  Schema.is(ProductOperation.OperationUnavailable)(error)
    ? error
    : ProductOperation.OperationUnavailable.make({ operation: input._tag, message: String(error) })

type InterruptibleRoot = { readonly interruptUnsafe: () => void }
type SignalEmitter = {
  readonly on: (event: "SIGINT", handler: () => void) => void
  readonly off: (event: "SIGINT", handler: () => void) => void
}
const liveSignalEmitter: SignalEmitter = {
  on: (_event, handler) => {
    process.on("SIGINT", handler)
  },
  off: (_event, handler) => {
    const remaining = process.listeners("SIGINT").filter((listener) => listener !== handler)
    process.removeAllListeners("SIGINT")
    for (const listener of remaining) process.on("SIGINT", listener)
  },
}

export const installClientSigintHandler = (input: {
  readonly rootFiber: () => InterruptibleRoot | undefined
  readonly onSignal: () => void
  readonly process?: SignalEmitter
}) => {
  const processEmitter = input.process ?? liveSignalEmitter
  const handler = () => {
    input.onSignal()
    input.rootFiber()?.interruptUnsafe()
  }
  processEmitter.on("SIGINT", handler)
  return () => processEmitter.off("SIGINT", handler)
}

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
            if (input._tag !== "Interactive") {
              const local = yield* Effect.tryPromise({
                try: () => import("./local-operations"),
                catch: () =>
                  ProductOperation.OperationUnavailable.make({
                    operation: input._tag,
                    message: "Local command support could not be loaded",
                  }),
              })
              return yield* local.run(input)
            }
            const unavailable = "Interactive support could not be loaded"
            const [online, HostedCli] = yield* Effect.all(
              [
                Effect.tryPromise({
                  try: () => import("./online"),
                  catch: () =>
                    ProductOperation.OperationUnavailable.make({ operation: input._tag, message: unavailable }),
                }),
                Effect.tryPromise({
                  try: () => import("../hosted/cli"),
                  catch: () =>
                    ProductOperation.OperationUnavailable.make({ operation: input._tag, message: unavailable }),
                }),
              ],
              { concurrency: 2 },
            )
            const home = yield* Config.string("HOME").pipe(Config.withDefault(process.cwd()))
            yield* startLogging.pipe(Effect.orDie)
            return yield* online.runInteractive(input).pipe(provideLayerScoped(HostedCli.liveLayer(home)))
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
                message: "Account support could not be loaded",
              }),
          })
          if (input._tag !== "RemoteRun" && input._tag !== "RemoteThread")
            return yield* provideLayerScoped(hosted.liveLayer(home))(hosted.run(input))
          const online = yield* Effect.tryPromise({
            try: () => import("./online"),
            catch: () =>
              ProductOperation.OperationUnavailable.make({
                operation: input._tag,
                message: "V2 client support could not be loaded",
              }),
          })
          if (input._tag === "RemoteRun")
            return yield* provideLayerScoped(hosted.liveLayer(home))(online.runRemote(input))
          return yield* provideLayerScoped(hosted.liveLayer(home))(online.createOrbThread(input))
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
          const persistence = yield* Effect.serviceOption(Logging.DiagnosticPersistence)
          if (Option.isSome(persistence))
            yield* Logging.start.pipe(
              Effect.provideService(Logging.DiagnosticPersistence, persistence.value),
              Effect.orDie,
            )
          const unavailable = "Runner support could not be loaded"
          const [online, HostedCli] = yield* Effect.all(
            [
              Effect.tryPromise({
                try: () => import("./online"),
                catch: () => ProductOperation.OperationUnavailable.make({ operation: "Runner", message: unavailable }),
              }),
              Effect.tryPromise({
                try: () => import("../hosted/cli"),
                catch: () => ProductOperation.OperationUnavailable.make({ operation: "Runner", message: unavailable }),
              }),
            ],
            { concurrency: 2 },
          )
          const home = yield* Config.string("HOME").pipe(Config.withDefault(process.cwd()))
          const hosted = HostedCli.liveLayer(home)
          return yield* online.runHeadless(input).pipe(Effect.scoped, provideLayerScoped(hosted))
        }).pipe(
          Effect.provide(platform),
          Effect.mapError((error) =>
            ProductOperation.OperationUnavailable.make({ operation: "Runner", message: error.message }),
          ),
        ),
    })
  }),
)

const printedCauseLimit = 2_000

/**
 * The last thing that runs before the process exits with a failure. Every failure lands in the diagnostics log at
 * ERROR with its full cause. `Command.run` already prints `CliError.UserError`; anything else (defects, protocol
 * failures, thrown errors) would otherwise exit 1 silently, so it is printed here after the TUI has been released.
 */
export const reportRootFailure = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void
  // Parsing can fail before an operation starts persistence; start it so buffered records reach disk.
  const persist = Effect.serviceOption(Logging.DiagnosticPersistence).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (service) => Logging.start.pipe(Effect.provideService(Logging.DiagnosticPersistence, service)),
      }),
    ),
    Effect.ignore,
    Effect.andThen(Logging.settleActiveLogs),
  )
  const error = Option.getOrUndefined(Cause.findErrorOption(cause))
  if (CliError.isCliError(error) && error._tag === "ShowHelp") return Effect.void
  if (CliError.isCliError(error) && error._tag === "UserError")
    return Effect.logError("cli.exit.failure", error.userMessage, cause).pipe(Effect.andThen(persist))
  const pretty = Logging.redactDetail(Cause.pretty(cause))
  const shown = pretty.length > printedCauseLimit ? `${pretty.slice(0, printedCauseLimit - 1)}…` : pretty
  return Effect.logError("cli.exit.defect", cause).pipe(
    Effect.andThen(persist),
    Effect.andThen(Console.error(`Rika stopped unexpectedly.\n${shown}\n\nRun \`rika debug\` and share its output.`)),
  )
}

export const run = Effect.fn("ClientMain.run")(function* (argv?: ReadonlyArray<string>) {
  const program = argv === undefined ? Command.run(command, { version }) : Command.runWith(command, { version })(argv)
  return yield* program.pipe(
    provideLayerScoped(Layer.mergeAll(dispatcherLayer(), hostedCommandLayer, runnerCommandLayer)),
    Effect.tapCause(reportRootFailure),
    Effect.annotateLogs({
      "rika.process.role": "client",
      "rika.process.pid": process.pid,
      "rika.version": version,
    }),
  )
})
