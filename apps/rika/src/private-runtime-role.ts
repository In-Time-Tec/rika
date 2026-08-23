import { Config, Effect, Option } from "effect"

export const tuiControllerProcessRole = "--internal-tui-controller"
export const runnerExecutorProcessRole = "--internal-runner-executor"

const isInternalProcessLaunch = (environmentVariable: string) =>
  Config.option(Config.string(environmentVariable)).pipe(
    Effect.map((value) => Option.contains(value, "1")),
    Effect.orDie,
  )

export const isTuiControllerProcessLaunch = isInternalProcessLaunch("RIKA_INTERNAL_CLIENT_RUNTIME")
