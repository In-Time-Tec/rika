import { Config, Effect, Option } from "effect"

export const serverProcessRole = "--internal-local-executor"

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

export const isServerProcessLaunch = Config.option(Config.string("RIKA_INTERNAL_SERVER_HOST")).pipe(
  Effect.map((value) => Option.contains(value, "1")),
  Effect.orDie,
)
