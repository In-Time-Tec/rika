import * as ServerService from "@rika/product/server-service"
import { Layer } from "effect"
import { make } from "./server-client-startup"

export const layer = Layer.effect(ServerService.Service, make())
