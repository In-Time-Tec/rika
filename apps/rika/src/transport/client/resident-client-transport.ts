import * as ResidentService from "@rika/product/resident-service"
import { Layer } from "effect"
import { make } from "./resident-client-startup"

export const layer = Layer.effect(ResidentService.Service, make())
