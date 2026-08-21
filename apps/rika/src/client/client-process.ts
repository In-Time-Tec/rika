#!/usr/bin/env bun
import * as ProductOperation from "@rika/product/product-operation"
import * as Operation from "@rika/product/product-operation-service"
import * as ServerHandshake from "@rika/product/server-service-handshake"
import * as ServerService from "@rika/product/server-service"
import { Config, Console, Context, Crypto, Effect, FileSystem, Layer, Option, Path, Schema, Stdio } from "effect"
import { HttpClient } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Command } from "effect/unstable/cli"
import { command, version } from "../command/root/rika-command"
import * as Logging from "../diagnostics/diagnostic-file-logging"
import { layer as serverLayer } from "../transport/client/server-client-transport"
import { spawn as spawnServer } from "../server/process/server-process-spawn"
import * as DataRoot from "@rika/configuration/canonical-data-root"
import { resolveProfileDataPaths } from "@rika/configuration/profile-data-paths"
import { inheritedEnvironment, privateRuntime } from "./private-runtime-launch"
import * as HostedCommand from "../command/root/hosted-command-dispatch"
import * as LocalRunnerCommand from "../command/root/local-runner-command"
import * as LocalRunner from "../local-executor/local-runner"
import * as HostedProfileStore from "../hosted/hosted-profile-store"

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

const withClientWorkspace = (input: ProductOperation.Input, workspace: string): ProductOperation.Input => {
  if (input._tag === "Interactive" || input._tag === "Run")
    return { ...input, clientWorkspace: workspace, workspace: input.workspace ?? workspace }
  if (
    input._tag === "Skill" ||
    input._tag === "Mcp" ||
    input._tag === "Extension" ||
    input._tag === "Config" ||
    input._tag === "Auth" ||
    input._tag === "Doctor" ||
    input._tag === "Thread"
  )
    return { ...input, clientWorkspace: workspace }
  return input
}

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
      const server = yield* ServerService.Service
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const stdio = yield* Stdio.Stdio
      const platform = yield* Effect.context<
        Crypto.Crypto | FileSystem.FileSystem | Path.Path | Stdio.Stdio | ChildProcessSpawner.ChildProcessSpawner
      >()
      return Operation.Service.of({
        run: Effect.fn("ClientMain.dispatch")(function* (input) {
          interactiveClientLaunch = clientSigintMode(input) === "child"
          return yield* Effect.gen(function* () {
            const home = yield* Config.string("HOME").pipe(Config.withDefault(process.cwd()))
            const paths = resolveProfileDataPaths({
              home,
              productDatabase: Option.getOrUndefined(yield* Config.option(Config.string("RIKA_DATABASE"))),
            })
            const dataRoot = yield* DataRoot.canonicalDataRoot(paths.database)
            const forwardedArguments = argv ?? (yield* stdio.args)
            return yield* Effect.scoped(
              Effect.gen(function* () {
                if (input._tag === "Interactive") {
                  const runtime = yield* privateRuntime("interactive")
                  if (runtime.replaceProcess) {
                    const environment: Record<string, string> = {
                      ...inheritedEnvironment(),
                      RIKA_INTERNAL_CLIENT_RUNTIME: "1",
                    }
                    const execve = process.execve
                    if (execve === undefined)
                      return yield* ProductOperation.OperationUnavailable.make({
                        operation: "Interactive",
                        message: "This platform cannot start the packaged interactive runtime.",
                      })
                    execve(runtime.executable, [runtime.executable, ...forwardedArguments], environment)
                  }
                  const handle = yield* spawner.spawn(
                    ChildProcess.make(runtime.executable, [...runtime.prefixArguments, ...forwardedArguments], {
                      detached: false,
                      stdin: "inherit",
                      stdout: "inherit",
                      stderr: "inherit",
                      extendEnv: true,
                      env: { RIKA_INTERNAL_CLIENT_RUNTIME: "1" },
                    }),
                  )
                  const forwardHangup = () => {
                    try {
                      process.kill(Number(handle.pid), "SIGHUP")
                    } catch {}
                  }
                  process.on("SIGHUP", forwardHangup)
                  const exitCode = Number(
                    yield* handle.exitCode.pipe(
                      Effect.ensuring(Effect.sync(() => process.off("SIGHUP", forwardHangup))),
                    ),
                  )
                  if (cleanInteractiveRuntimeExit(exitCode)) return
                  return yield* ProductOperation.OperationUnavailable.make({
                    operation: "Interactive",
                    message:
                      "Rika closed unexpectedly. Run rika again. If it keeps happening, run rika diagnostics status.",
                  })
                }
                let clientKind: ServerHandshake.Handshake["clientKind"]
                if (input._tag === "Thread") clientKind = "thread-continue"
                else if (input._tag === "Run") clientKind = "run"
                else clientKind = "product"
                const serverRuntime = yield* privateRuntime("server")
                const connected = yield* server.getOrCreate({
                  profile: "default",
                  dataRoot,
                  clientKind,
                  startHost: () =>
                    spawnServer({
                      executable: serverRuntime.executable,
                      arguments: serverRuntime.prefixArguments,
                      environment: {
                        RIKA_INTERNAL_SERVER_HOST: "1",
                        RIKA_INTERNAL_SERVER_PROFILE: "default",
                        RIKA_INTERNAL_SERVER_DATA_ROOT: dataRoot,
                      },
                    }).pipe(Effect.tap(() => Effect.logInfo("server.spawned"))),
                })
                yield* connected.run(withClientWorkspace(input, process.cwd()), {
                  stdout: (text) => Effect.sync(() => process.stdout.write(text)),
                  stderr: (text) => Effect.sync(() => process.stderr.write(text)),
                })
              }),
            ).pipe(provideLayerScoped(Logging.layer({ dataRoot, role: "client", version })))
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
      Crypto.Crypto | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >()
    return LocalRunnerCommand.Service.of({
      run: (input) =>
        Effect.gen(function* () {
          const home = yield* Config.string("HOME").pipe(Config.withDefault(process.cwd()))
          const preferencePath = yield* LocalRunner.preferencePath
          return yield* LocalRunner.runLocalRunner({
            workspace: input.workspace ?? process.cwd(),
            preferencePath,
            ...(input.remoteThreadCreation === undefined
              ? {}
              : { requestedPreference: input.remoteThreadCreation }),
          }).pipe(
            Effect.scoped,
            provideLayerScoped(
              Layer.merge(HostedProfileStore.layer({ home }), LocalRunner.unavailableAdmissionLayer),
            ),
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
    provideLayerScoped(
      Layer.mergeAll(dispatcherLayer(argv).pipe(Layer.provide(serverLayer)), hostedCommandLayer, localRunnerCommandLayer),
    ),
  )
})

export const isInteractiveClientLaunch = (): boolean => interactiveClientLaunch
