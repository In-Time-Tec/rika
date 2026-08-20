import { Config, Effect, Option, Path } from "effect"
import { serverProcessRuntime } from "../private-runtime-role"

export interface RuntimeLaunch {
  readonly executable: string
  readonly prefixArguments: ReadonlyArray<string>
  readonly replaceProcess: boolean
}

export const privateRuntime = Effect.fn("ClientProcess.privateRuntime")(function* (role: "interactive" | "server") {
  const path = yield* Path.Path
  const testExecutable = yield* Config.option(Config.string("RIKA_TEST_RUNTIME_EXECUTABLE"))
  if (Option.isSome(testExecutable))
    return { executable: testExecutable.value, prefixArguments: [], replaceProcess: false }
  if (role === "server") {
    const runtime = serverProcessRuntime({
      packaged: import.meta.path.startsWith("/$bunfs/"),
      executable: process.execPath,
      packagedEntrypoint: path.join(path.dirname(process.execPath), "rika"),
      sourceEntrypoint: path.join(import.meta.dir, "..", "client-main.ts"),
    })
    return { executable: runtime.executable, prefixArguments: runtime.arguments, replaceProcess: false }
  }
  return import.meta.path.startsWith("/$bunfs/")
    ? {
        executable: path.join(path.dirname(process.execPath), ".rika-interactive"),
        prefixArguments: [],
        replaceProcess: true,
      }
    : {
        executable: process.execPath,
        prefixArguments: [path.join(import.meta.dir, "..", "interactive-main.ts")],
        replaceProcess: false,
      }
})

export const inheritedEnvironment = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
