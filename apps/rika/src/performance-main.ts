#!/usr/bin/env bun
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Console, Effect, Layer } from "effect"
import { performanceEvaluation } from "./platform/application-performance-evaluation"

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(
      Effect.flatMap(Layer.build(BunServices.layer), (context) =>
        Effect.provide(
          performanceEvaluation.pipe(Effect.flatMap((report) => Console.log(JSON.stringify(report)))),
          context,
        ),
      ),
    ),
  )
