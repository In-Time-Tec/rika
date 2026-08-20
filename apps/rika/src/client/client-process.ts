#!/usr/bin/env bun
import { Config, Console, Context, Crypto, Effect, FileSystem, Layer, Path } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Command } from "effect/unstable/cli"
import { ChildProcessSpawner } from "effect/unstable/process"
import { command, version } from "../command/root/rika-command"
import * as HostedCommand from "../command/root/hosted-command-dispatch"
import * as HostedCli from "../hosted/hosted-cli"

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

const hostedCommandLayer = Layer.effect(
  HostedCommand.Service,
  Effect.gen(function* () {
    const platform = yield* Effect.context<
      | Crypto.Crypto
      | FileSystem.FileSystem
      | Path.Path
      | HttpClient.HttpClient
      | ChildProcessSpawner.ChildProcessSpawner
    >()
    return HostedCommand.Service.of({
      run: (input) =>
        Effect.gen(function* () {
          const home = yield* Config.string("HOME").pipe(Effect.orElseSucceed(() => process.cwd()))
          return yield* provideLayerScoped(HostedCli.liveLayer(home))(HostedCli.run(input))
        }).pipe(Effect.provide(platform)),
    })
  }),
)

export const run = Effect.fn("ClientMain.run")(function* (argv?: ReadonlyArray<string>) {
  const program = (
    argv === undefined ? Command.run(command, { version }) : Command.runWith(command, { version })(argv)
  ).pipe(
    Effect.catchTag("HostedError", (error) => Console.error(error.message).pipe(Effect.andThen(Effect.fail(error)))),
    Effect.annotateLogs({
      "rika.process.role": "client",
      "rika.process.pid": process.pid,
      "rika.version": version,
    }),
  )
  return yield* program.pipe(provideLayerScoped(hostedCommandLayer))
})
