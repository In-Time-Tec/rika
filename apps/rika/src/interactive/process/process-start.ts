#!/usr/bin/env bun
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import * as Operation from "@rika/product/product-operation-service"
import * as ProductOperation from "@rika/product/product-operation"
import { probeNativeAsset } from "@rika/terminal/opentui-surface"
import { Config, Console, Effect, Layer, Option } from "effect"
import { Command } from "effect/unstable/cli"
import { FetchHttpClient } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { command, version } from "../../command/root/rika-command"
import { runHostedInteractive } from "../../hosted/hosted-interactive-controller"
import { CredentialStore, Http, ProfileStore, ThreadClient } from "../../hosted/hosted-contract"
import * as HostedCli from "../../hosted/hosted-cli"
import { LocalRunnerAdmission } from "../../local-executor/local-runner-contract"
import * as LocalRunner from "../../local-executor/local-runner"
import { provideLayerScoped } from "./process-layer"

const main = Command.run(command, { version }).pipe(
  Effect.catchTags({
    OperationUnavailable: (error: ProductOperation.OperationUnavailable) =>
      Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
    InvalidInput: (error: ProductOperation.InvalidInput) =>
      Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
  }),
)

const dispatcherLayer = (editor: string | undefined) =>
  Layer.effect(
    Operation.Service,
    Effect.gen(function* () {
      const context = yield* Effect.context<
        | BunServices.BunServices
        | CredentialStore
        | Http
        | LocalRunnerAdmission
        | ProfileStore
        | Socket.WebSocketConstructor
        | ThreadClient
      >()
      return Operation.Service.of({
        run: (input) =>
          input._tag === "Interactive"
            ? Effect.scoped(runHostedInteractive(input, { editor })).pipe(Effect.provideContext(context))
            : Effect.fail(
                ProductOperation.OperationUnavailable.make({
                  operation: input._tag,
                  message: "The hosted TUI controller accepts only interactive operations",
                }),
              ),
      })
    }),
  )

export const start = () => {
  const nativeProbe = Effect.runSync(Config.option(Config.string("RIKA_INTERNAL_OPENTUI_NATIVE_PROBE")))
  if (Option.contains(nativeProbe, "1")) {
    Effect.runSync(Console.log(probeNativeAsset()))
    process.exit(0)
  }
  const environment = Effect.runSync(
    Config.all({
      home: Config.option(Config.string("HOME")),
      visual: Config.option(Config.string("VISUAL")),
      editor: Config.option(Config.string("EDITOR")),
    }),
  )
  const home = Option.getOrElse(environment.home, () => process.cwd())
  const editor = Option.getOrUndefined(environment.visual) ?? Option.getOrUndefined(environment.editor)
  const platform = Layer.mergeAll(
    BunServices.layer,
    BunCrypto.layer,
    FetchHttpClient.layer,
    BunSocket.layerWebSocketConstructor,
  )
  const hosted = HostedCli.liveLayer(home).pipe(Layer.provide(platform))
  const admission = LocalRunner.liveAdmissionLayer.pipe(Layer.provide(hosted))
  const dependencies = Layer.mergeAll(platform, hosted, admission)
  const program = main.pipe(provideLayerScoped(dispatcherLayer(editor).pipe(Layer.provideMerge(dependencies))))
  BunRuntime.runMain(program)
}
