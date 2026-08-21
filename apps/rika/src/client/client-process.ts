#!/usr/bin/env bun
import * as ProductOperation from "@rika/product/product-operation"
import * as Operation from "@rika/product/product-operation-service"
import { Config, Console, Context, Crypto, Effect, FileSystem, Layer, Path, Schema, Stdio } from "effect"
import { HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { Command } from "effect/unstable/cli"
import { command, version } from "../command/root/rika-command"
import { privateRuntime } from "./private-runtime-launch"
import * as HostedCommand from "../command/root/hosted-command-dispatch"
import * as LocalRunnerCommand from "../command/root/local-runner-command"
import * as LocalRunner from "../local-executor/local-runner"
import * as HostedCli from "../hosted/hosted-cli"
import { processRoleLaunch, superviseLocalRoles } from "./local-role-supervisor"

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

let interactiveClientLaunch = false

export const cleanInteractiveRuntimeExit = (exitCode: number): boolean =>
  exitCode === 0 || exitCode === 130 || exitCode === 129

export const clientSigintMode = (input: Pick<ProductOperation.Input, "_tag"> | undefined): "root" | "child" =>
  input?._tag === "Interactive" ? "child" : "root"

type InterruptibleRoot = { readonly interruptUnsafe: () => void }

export const installClientSigintHandler = (input: {
  readonly inputMode: () => "root" | "child"
  readonly rootFiber: () => InterruptibleRoot | undefined
  readonly onSignal: () => void
}) => {
  const handler = () => {
    input.onSignal()
    if (input.inputMode() === "root") input.rootFiber()?.interruptUnsafe()
  }
  process.on("SIGINT", handler)
  return () => process.off("SIGINT", handler)
}

const dispatcherLayer = (argv?: ReadonlyArray<string>) =>
  Layer.effect(
    Operation.Service,
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio
      const platform = yield* Effect.context<
        Crypto.Crypto | FileSystem.FileSystem | Path.Path | Stdio.Stdio | ChildProcessSpawner.ChildProcessSpawner
      >()
      return Operation.Service.of({
        run: Effect.fn("ClientMain.dispatch")(function* (input) {
          interactiveClientLaunch = clientSigintMode(input) === "child"
          return yield* Effect.gen(function* () {
            if (input._tag !== "Interactive")
              return yield* ProductOperation.OperationUnavailable.make({
                operation: input._tag,
                message: `${input._tag} has no hosted command implementation`,
              })
            const forwardedArguments = argv ?? (yield* stdio.args)
            return yield* Effect.scoped(
              Effect.gen(function* () {
                if (input._tag === "Interactive") {
                  const controller = yield* privateRuntime("interactive")
                  const executor = yield* privateRuntime("client")
                  const workspace = input.workspace ?? process.cwd()
                  const launch = yield* processRoleLaunch({
                    "tui-controller": {
                      executable: controller.executable,
                      arguments: [...controller.prefixArguments, ...forwardedArguments],
                      environment: { RIKA_INTERNAL_CLIENT_RUNTIME: "1" },
                    },
                    "local-executor": {
                      executable: executor.executable,
                      arguments: [...executor.prefixArguments, "--no-tui", "--workspace", workspace],
                      environment: { RIKA_INTERNAL_LOCAL_EXECUTOR: "1" },
                    },
                  })
                  const exitCode = yield* superviseLocalRoles({
                    headless: false,
                    launch,
                    status: {
                      localExecutorWaiting: Console.error(
                        "Local executor disconnected. The hosted Thread is waiting for this checkout; no E2B fallback was selected.",
                      ),
                    },
                  })
                  if (cleanInteractiveRuntimeExit(exitCode)) return
                  return yield* ProductOperation.OperationUnavailable.make({
                    operation: "Interactive",
                    message:
                      "Rika closed unexpectedly. Run rika again. If it keeps happening, run rika diagnostics status.",
                  })
                }
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
            try: () => import("../hosted/hosted-cli"),
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

const localRunnerCommandLayer = Layer.effect(
  LocalRunnerCommand.Service,
  Effect.gen(function* () {
    const platform = yield* Effect.context<
      | Crypto.Crypto
      | FileSystem.FileSystem
      | Path.Path
      | ChildProcessSpawner.ChildProcessSpawner
      | HttpClient.HttpClient
    >()
    return LocalRunnerCommand.Service.of({
      run: (input) =>
        Effect.gen(function* () {
          const home = yield* Config.string("HOME").pipe(Config.withDefault(process.cwd()))
          const preferencePath = yield* LocalRunner.preferencePath
          const hosted = HostedCli.liveLayer(home)
          return yield* LocalRunner.runLocalRunner({
            workspace: input.workspace ?? process.cwd(),
            preferencePath,
            ...(input.remoteThreadCreation === undefined ? {} : { requestedPreference: input.remoteThreadCreation }),
          }).pipe(
            Effect.scoped,
            provideLayerScoped(Layer.merge(hosted, LocalRunner.liveAdmissionLayer.pipe(Layer.provide(hosted)))),
          )
        }).pipe(
          Effect.provide(platform),
          Effect.mapError((error) =>
            ProductOperation.OperationUnavailable.make({ operation: "LocalRunner", message: error.message }),
          ),
        ),
    })
  }),
)

export const run = Effect.fn("ClientMain.run")(function* (argv?: ReadonlyArray<string>) {
  const program = (
    argv === undefined ? Command.run(command, { version }) : Command.runWith(command, { version })(argv)
  ).pipe(
    Effect.catchTags({
      OperationUnavailable: (error: ProductOperation.OperationUnavailable) =>
        Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
      InvalidInput: (error: ProductOperation.InvalidInput) =>
        Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
    }),
    Effect.annotateLogs({
      "rika.process.role": "client",
      "rika.process.pid": process.pid,
      "rika.version": version,
    }),
  )
  return yield* program.pipe(
    provideLayerScoped(Layer.mergeAll(dispatcherLayer(argv), hostedCommandLayer, localRunnerCommandLayer)),
  )
})

export const isInteractiveClientLaunch = (): boolean => interactiveClientLaunch
