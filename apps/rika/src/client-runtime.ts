#!/usr/bin/env bun
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Logging from "./diagnostics/file-logging"
import { version } from "./platform/application-version"
import { provideLayerScoped } from "./platform/provide"

import { clientProcessExitCode } from "./client/process-exit"
import { installClientSigintHandler, run } from "./client/process"

const exitProcess = process.exit

interface RootFiberOwner {
  fiber: ReturnType<typeof Effect.runFork> | undefined
}

export const startClient = () => {
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
  const rootFiber = Effect.runFork(run().pipe(Effect.scoped, provideLayerScoped(Layer.merge(platform, logging))))
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
