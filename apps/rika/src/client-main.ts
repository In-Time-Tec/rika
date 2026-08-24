#!/usr/bin/env bun
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Logging from "./diagnostics/diagnostic-file-logging"
import { version } from "./platform/application-version"

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
import { clientProcessExitCode } from "./client/client-process-exit"
import { installClientSigintHandler, run } from "./client/client-process"

const exitProcess = process.exit

const startClient = () => {
  let interruptedBySigint = false
  let rootFiber: ReturnType<typeof Effect.runFork> | undefined
  const removeSigintHandler = installClientSigintHandler({
    rootFiber: () => rootFiber,
    onSignal: () => {
      interruptedBySigint = true
    },
  })
  const platform = Layer.merge(BunServices.layer, FetchHttpClient.layer)
  const home = Effect.runSync(Config.string("HOME").pipe(Config.withDefault(process.cwd())))
  const logging = Logging.layer({ dataRoot: `${home}/.config/rika`, role: "client", version }).pipe(
    Layer.provide(BunServices.layer),
  )
  rootFiber = Effect.runFork(run().pipe(provideLayerScoped(Layer.merge(platform, logging))))
  if (interruptedBySigint) rootFiber.interruptUnsafe()
  rootFiber.addObserver((exit) => {
    removeSigintHandler()
    exitProcess(
      clientProcessExitCode({
        exit,
        interruptedBySigint,
        successfulExitCode: typeof process.exitCode === "number" ? process.exitCode : undefined,
      }),
    )
  })
}

if (import.meta.main) startClient()
