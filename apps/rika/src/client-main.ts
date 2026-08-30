#!/usr/bin/env bun
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Logging from "./diagnostics/file-logging"
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
import { clientProcessExitCode } from "./client/process-exit"
import { installClientSigintHandler, run } from "./client/process"

const exitProcess = process.exit

interface RootFiberOwner {
  fiber: ReturnType<typeof Effect.runFork> | undefined
}

const startClient = () => {
  let interruptedBySigint = false
  const root: RootFiberOwner = { fiber: undefined }
  const removeSigintHandler = installClientSigintHandler({
    rootFiber: () => root.fiber,
    onSignal: () => {
      interruptedBySigint = true
    },
  })
  const platform = Layer.merge(BunServices.layer, FetchHttpClient.layer)
  const home = Effect.runSync(Config.string("HOME").pipe(Config.withDefault(process.cwd())))
  const logging = Logging.layer({ dataRoot: `${home}/.config/rika`, role: "client", version }).pipe(
    Layer.provide(BunServices.layer),
  )
  const rootFiber = Effect.runFork(run().pipe(provideLayerScoped(Layer.merge(platform, logging))))
  root.fiber = rootFiber
  if (interruptedBySigint) rootFiber.interruptUnsafe()
  rootFiber.addObserver((exit) => {
    removeSigintHandler()
    exitProcess(
      clientProcessExitCode({
        exit,
        interruptedBySigint,
        successfulExitCode: Schema.is(Schema.Int)(process.exitCode) ? process.exitCode : undefined,
      }),
    )
  })
}

if (import.meta.main) startClient()
