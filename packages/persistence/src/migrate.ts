import { Config } from "@rika/core"
import { Effect, Layer } from "effect"
import { Database, Migration } from "./index"

const databaseLayer = Database.layer.pipe(Layer.provide(Config.layer))
const layer = Layer.mergeAll(databaseLayer, Migration.layer)

await Effect.runPromise(Migration.migrate().pipe(Effect.provide(layer)))
