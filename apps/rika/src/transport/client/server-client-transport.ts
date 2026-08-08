import * as ServerService from "@rika/product/server-service"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import { Layer } from "effect"
import { make } from "./server-client-startup"

export const layer = Layer.effect(ServerService.Service, make()).pipe(
  Layer.provide(BunSocket.layerWebSocketConstructor),
)
