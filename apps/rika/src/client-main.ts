#!/usr/bin/env bun
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Operation from "@rika/app/operation-contract"
import * as ResidentService from "@rika/app/resident-service"
import {
  Cause,
  Config,
  Console,
  Context,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Command } from "effect/unstable/cli"
import { command, version } from "./command"
import * as Logging from "./logging"
import { layer as residentLayer } from "./resident-client-transport"
import * as ResidentProcessStartup from "./resident-process-startup"

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

const withClientWorkspace = (input: Operation.Input, workspace: string): Operation.Input => {
  if (input._tag === "Interactive" || input._tag === "Run" || input._tag === "Review")
    return { ...input, clientWorkspace: workspace, workspace: input.workspace ?? workspace }
  if (input._tag === "Mcp" && input.action === "approve")
    return { ...input, clientWorkspace: workspace, workspace: input.workspace ?? workspace }
  if (
    input._tag === "Skill" ||
    input._tag === "Mcp" ||
    input._tag === "Extension" ||
    input._tag === "Config" ||
    input._tag === "Auth" ||
    input._tag === "Doctor" ||
    input._tag === "Thread" ||
    input._tag === "Workflow"
  )
    return { ...input, clientWorkspace: workspace }
  return input
}

const operationFailure = (input: Operation.Input, error: unknown) =>
  Schema.is(Operation.OperationUnavailable)(error)
    ? error
    : Operation.OperationUnavailable.make({ operation: input._tag, message: String(error) })

export const cleanInteractiveRuntimeExit = (exitCode: number): boolean => exitCode === 0 || exitCode === 130

export const interactiveRuntimeRestartLimit = 3

export type InteractiveRuntimeRestartDecision =
  | { readonly _tag: "respawn"; readonly environment: Record<string, string> }
  | { readonly _tag: "fail"; readonly message: string }
  | { readonly _tag: "done" }

export const interactiveRuntimeRestartPlan = (input: {
  readonly exitCode: number
  readonly restart: ResidentProcessStartup.RuntimeRestartMessage | undefined
  readonly attempt: number
  readonly limit: number
}): InteractiveRuntimeRestartDecision => {
  if (input.exitCode === ResidentService.runtimeRestartExitCode && input.restart !== undefined) {
    if (input.attempt >= input.limit)
      return {
        _tag: "fail",
        message: "Rika could not finish upgrading. Reinstall Rika, then run it again.",
      }
    return {
      _tag: "respawn",
      environment: {
        RIKA_INTERNAL_RUNTIME_RESTARTED: "1",
        ...(input.restart.threadId === undefined ? {} : { RIKA_INTERNAL_RESTART_THREAD: input.restart.threadId }),
      },
    }
  }
  if (cleanInteractiveRuntimeExit(input.exitCode)) return { _tag: "done" }
  return {
    _tag: "fail",
    message: "Rika closed unexpectedly. Run rika again. If it keeps happening, run rika diagnostics status.",
  }
}

let interactiveSigintObserved = false

const privateRuntime = Effect.fn("ClientMain.privateRuntime")(function* () {
  const path = yield* Path.Path
  const testExecutable = yield* Config.option(Config.string("RIKA_TEST_RUNTIME_EXECUTABLE"))
  if (Option.isSome(testExecutable)) return { executable: testExecutable.value, prefixArguments: [] }
  return import.meta.path.startsWith("/$bunfs/")
    ? { executable: path.join(path.dirname(process.execPath), ".rika-runtime"), prefixArguments: [] }
    : { executable: process.execPath, prefixArguments: [path.join(import.meta.dir, "main.ts")] }
})

const dispatcherLayer = (argv?: ReadonlyArray<string>) =>
  Layer.effect(
    Operation.Service,
    Effect.gen(function* () {
      const resident = yield* ResidentService.Service
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const stdio = yield* Stdio.Stdio
      const platform = yield* Effect.context<
        Crypto.Crypto | FileSystem.FileSystem | Path.Path | Stdio.Stdio | ChildProcessSpawner.ChildProcessSpawner
      >()
      return Operation.Service.of({
        run: Effect.fn("ClientMain.dispatch")(function* (input) {
          return yield* Effect.gen(function* () {
            const home = yield* Config.string("HOME").pipe(Config.withDefault(process.cwd()))
            const database = yield* Config.string("RIKA_DATABASE").pipe(Config.withDefault(`${home}/.rika/rika.db`))
            const relayDatabase = yield* Config.string("RIKA_RELAY_DATABASE").pipe(
              Config.withDefault(`${home}/.rika/relay.db`),
            )
            const dataRoot = yield* Logging.resolveDataRoot(database, relayDatabase)
            const forwardedArguments = argv ?? (yield* stdio.args)
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const runtime = yield* privateRuntime()
                if (input._tag === "Interactive") {
                  let attempt = 0
                  let restartEnvironment: Record<string, string> = {}
                  while (true) {
                    const handle = yield* spawner.spawn(
                      ChildProcess.make(runtime.executable, [...runtime.prefixArguments, ...forwardedArguments], {
                        detached: false,
                        stdin: "inherit",
                        stdout: "inherit",
                        stderr: "inherit",
                        additionalFds: { fd3: { type: "output" } },
                        extendEnv: true,
                        env: {
                          RIKA_INTERNAL_CLIENT_RUNTIME: "1",
                          [ResidentProcessStartup.runtimeRestartFdEnvironment]: String(
                            ResidentProcessStartup.runtimeRestartFd,
                          ),
                          ...restartEnvironment,
                        },
                      }),
                    )
                    const exitCode = Number(yield* handle.exitCode)
                    const restartLine = yield* Stream.runFold(
                      Stream.splitLines(Stream.decodeText(handle.getOutputFd(ResidentProcessStartup.runtimeRestartFd))),
                      () => Option.none<string>(),
                      (first, text) => (Option.isSome(first) ? first : Option.some(text)),
                    ).pipe(
                      Effect.timeoutOrElse({
                        duration: "1 second",
                        orElse: () => Effect.succeed(Option.none<string>()),
                      }),
                      Effect.orElseSucceed(() => Option.none<string>()),
                    )
                    const restart = Option.isSome(restartLine)
                      ? Option.getOrUndefined(
                          yield* ResidentProcessStartup.decodeRuntimeRestart(restartLine.value).pipe(Effect.option),
                        )
                      : undefined
                    const decision = interactiveRuntimeRestartPlan({
                      exitCode,
                      restart,
                      attempt,
                      limit: interactiveRuntimeRestartLimit,
                    })
                    if (decision._tag === "done") return
                    if (decision._tag === "fail")
                      return yield* Operation.OperationUnavailable.make({
                        operation: "Interactive",
                        message: decision.message,
                      })
                    if (interactiveSigintObserved) return
                    attempt += 1
                    restartEnvironment = decision.environment
                  }
                }
                let clientKind: ResidentService.Handshake["clientKind"]
                if (input._tag === "Thread") clientKind = "thread-continue"
                else if (input._tag === "Run") clientKind = "run"
                else if (input._tag === "Review") clientKind = "review"
                else if (input._tag === "Workflow") clientKind = "workflow"
                else clientKind = "product"
                const connected = yield* resident.getOrCreate({
                  profile: "default",
                  dataRoot,
                  clientKind,
                  startHost: () =>
                    ResidentProcessStartup.spawn({
                      executable: runtime.executable,
                      arguments: runtime.prefixArguments,
                      environment: {
                        RIKA_INTERNAL_RESIDENT_HOST: "1",
                        RIKA_INTERNAL_RESIDENT_PROFILE: "default",
                        RIKA_INTERNAL_RESIDENT_DATA_ROOT: dataRoot,
                      },
                    }).pipe(Effect.tap(() => Effect.logInfo("resident.spawned"))),
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

export const run = Effect.fn("ClientMain.run")(function* (argv?: ReadonlyArray<string>) {
  const program = (
    argv === undefined ? Command.run(command, { version }) : Command.runWith(command, { version })(argv)
  ).pipe(
    Effect.catchTags({
      OperationUnavailable: (error: Operation.OperationUnavailable) =>
        Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
      InvalidInput: (error: Operation.InvalidInput) =>
        Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
    }),
    Effect.annotateLogs({
      "rika.process.role": "client",
      "rika.process.pid": process.pid,
      "rika.version": version,
    }),
  )
  return yield* program.pipe(provideLayerScoped(dispatcherLayer(argv).pipe(Layer.provide(residentLayer))))
})

export const clientProcessExitCode = <E, A>(input: {
  readonly exit: Exit.Exit<E, A>
  readonly interruptedBySigint: boolean
}): number => {
  if (input.interruptedBySigint && Exit.isFailure(input.exit) && Cause.hasInterruptsOnly(input.exit.cause)) return 0
  let code = 1
  Runtime.defaultTeardown(input.exit, (value) => {
    code = value
  })
  return code
}

if (import.meta.main) {
  let interruptedBySigint = false
  const markSigint = () => {
    interruptedBySigint = true
    interactiveSigintObserved = true
  }
  process.once("SIGINT", markSigint)
  BunRuntime.runMain(run().pipe(provideLayerScoped(BunServices.layer)), {
    teardown: (exit, onExit) => {
      process.off("SIGINT", markSigint)
      onExit(clientProcessExitCode({ exit, interruptedBySigint }))
    },
  })
}
