import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Effect } from "effect"
import * as Config from "./bootstrap/config"
import * as ExecutionConfig from "./bootstrap/execution-config"
import * as Execution from "./bootstrap/execution"
import * as Production from "./bootstrap/production"

const program = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* Config.loadApiV2ProductionConfig(Bun.env)
    const execution = yield* ExecutionConfig.loadExecutionConfig(Bun.env, config.identity.production)
    yield* Production.makeProductionApi(config, Execution.makeExecutionDependencies({ config, execution }))
    yield* Effect.logInfo("Rika API is ready")
    return yield* Effect.never
  }),
)

BunRuntime.runMain(program)
