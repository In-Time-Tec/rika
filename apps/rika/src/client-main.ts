#!/usr/bin/env bun
import * as BunServices from "@effect/platform-bun/BunServices"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

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
import { run } from "./client/client-process"

export const startClient = () => {
  let interruptedBySigint = false
  let rootFiber: ReturnType<typeof Effect.runFork> | undefined
  const onSignal = () => {
    interruptedBySigint = true
    rootFiber?.interruptUnsafe()
  }
  process.on("SIGINT", onSignal)
  rootFiber = Effect.runFork(run().pipe(provideLayerScoped(Layer.merge(BunServices.layer, FetchHttpClient.layer))))
  if (interruptedBySigint) rootFiber.interruptUnsafe()
  rootFiber.addObserver((exit) => {
    process.off("SIGINT", onSignal)
    process.exit(clientProcessExitCode({ exit, interruptedBySigint }))
  })
}

if (import.meta.main) startClient()
