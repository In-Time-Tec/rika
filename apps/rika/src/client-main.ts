#!/usr/bin/env bun
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Operation from "@rika/app/operation-contract"
import * as ResidentService from "@rika/app/resident-service"
import { Cause, Config, Console, Context, Crypto, Effect, FileSystem, Layer, Path, Schema, Stdio } from "effect"
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
    input._tag === "Doctor" ||
    input._tag === "Thread"
  )
    return { ...input, clientWorkspace: workspace }
  return input
}

const operationFailure = (input: Operation.Input, error: unknown) =>
  Schema.is(Operation.OperationUnavailable)(error)
    ? error
    : Operation.OperationUnavailable.make({ operation: input._tag, message: String(error) })

const privateRuntime = Effect.fn("ClientMain.privateRuntime")(function* () {
  const path = yield* Path.Path
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
                  const exitCode = yield* spawner.exitCode(
                    ChildProcess.make(runtime.executable, [...runtime.prefixArguments, ...forwardedArguments], {
                      detached: false,
                      stdin: "inherit",
                      stdout: "inherit",
                      stderr: "inherit",
                      extendEnv: true,
                      env: { RIKA_INTERNAL_CLIENT_RUNTIME: "1" },
                    }),
                  )
                  if (Number(exitCode) !== 0)
                    return yield* Operation.OperationUnavailable.make({
                      operation: "Interactive",
                      message: `Rika interactive runtime exited with code ${exitCode}`,
                    })
                  return
                }
                const connected = yield* resident.getOrCreate({
                  profile: "default",
                  dataRoot,
                  clientKind:
                    input._tag === "Thread"
                      ? "thread-continue"
                      : input._tag === "Run"
                        ? "run"
                        : input._tag === "Review"
                          ? "review"
                          : input._tag === "Workflow"
                            ? "workflow"
                            : "product",
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
    Effect.tapCause((cause) =>
      Effect.logError("process.failed").pipe(
        Effect.annotateLogs("rika.failure.kind", Cause.squash(cause) instanceof Error ? "Error" : typeof cause),
      ),
    ),
    Effect.annotateLogs({
      "rika.process.role": "client",
      "rika.process.pid": process.pid,
      "rika.version": version,
    }),
  )
  return yield* program.pipe(provideLayerScoped(dispatcherLayer(argv).pipe(Layer.provide(residentLayer))))
})

if (import.meta.main) BunRuntime.runMain(run().pipe(provideLayerScoped(BunServices.layer)))
