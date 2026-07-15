import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer } from "effect"
import { uninstallLocal } from "./local-install"

BunRuntime.runMain(
  Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(uninstallLocal(), context))),
)
