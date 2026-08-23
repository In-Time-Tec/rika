#!/usr/bin/env bun
import * as BunServices from "@effect/platform-bun/BunServices"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { isTuiControllerProcessLaunch } from "./private-runtime-role"
import { start as startInteractive } from "./interactive/process/process-start"

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
import { installClientSigintHandler, isInteractiveClientLaunch, run } from "./client/client-process"

const startClient = () => {
  let interruptedBySigint = false
  let rootFiber: ReturnType<typeof Effect.runFork> | undefined
  const removeSigintHandler = installClientSigintHandler({
    inputMode: () => (isInteractiveClientLaunch() ? "child" : "root"),
    rootFiber: () => rootFiber,
    onSignal: () => {
      interruptedBySigint = true
    },
  })
  rootFiber = Effect.runFork(run().pipe(provideLayerScoped(Layer.merge(BunServices.layer, FetchHttpClient.layer))))
  if (interruptedBySigint && !isInteractiveClientLaunch()) rootFiber.interruptUnsafe()
  rootFiber.addObserver((exit) => {
    removeSigintHandler()
    process.exit(
      clientProcessExitCode({
        exit,
        interruptedBySigint,
        successfulExitCode: typeof process.exitCode === "number" ? process.exitCode : undefined,
      }),
    )
  })
}

if (import.meta.main) {
  if (Effect.runSync(isTuiControllerProcessLaunch)) startInteractive()
  else startClient()
}
