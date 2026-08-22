import { Config, Effect, Option, Path } from "effect"
import { localExecutorProcessRole, tuiControllerProcessRole } from "../private-runtime-role"

export interface RuntimeLaunch {
  readonly executable: string
  readonly prefixArguments: ReadonlyArray<string>
}

export const privateRuntime = Effect.fn("ClientProcess.privateRuntime")(function* (role: "client" | "interactive") {
  const path = yield* Path.Path
  const testExecutable = yield* Config.option(Config.string("RIKA_TEST_RUNTIME_EXECUTABLE"))
  if (Option.isSome(testExecutable)) return { executable: testExecutable.value, prefixArguments: [] }
  if (role === "client")
    return import.meta.path.startsWith("/$bunfs/")
      ? { executable: process.execPath, prefixArguments: [localExecutorProcessRole] }
      : {
          executable: process.execPath,
          prefixArguments: [path.join(import.meta.dir, "..", "client-main.ts"), localExecutorProcessRole],
        }
  return import.meta.path.startsWith("/$bunfs/")
    ? {
        executable: process.execPath,
        prefixArguments: [tuiControllerProcessRole],
      }
    : {
        executable: process.execPath,
        prefixArguments: [path.join(import.meta.dir, "..", "interactive-main.ts")],
      }
})

export const inheritedEnvironment = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
