import { Config, Effect, Option } from "effect"

export const serverProcessRole = "--internal-private-server"
export const tuiControllerProcessRole = "--internal-tui-controller"
export const localExecutorProcessRole = "--internal-local-executor"

export interface ServerProcessRuntime {
  readonly executable: string
  readonly arguments: ReadonlyArray<string>
}

export const serverProcessRuntime = (input: {
  readonly packaged: boolean
  readonly executable: string
  readonly packagedEntrypoint: string
  readonly sourceEntrypoint: string
}): ServerProcessRuntime =>
  input.packaged
    ? { executable: input.packagedEntrypoint, arguments: [serverProcessRole] }
    : { executable: input.executable, arguments: [input.sourceEntrypoint, serverProcessRole] }

const isInternalProcessLaunch = (environmentVariable: string) =>
  Config.option(Config.string(environmentVariable)).pipe(
    Effect.map((value) => Option.contains(value, "1")),
    Effect.orDie,
  )

export const isServerProcessLaunch = isInternalProcessLaunch("RIKA_INTERNAL_SERVER_HOST")
export const isTuiControllerProcessLaunch = isInternalProcessLaunch("RIKA_INTERNAL_CLIENT_RUNTIME")
