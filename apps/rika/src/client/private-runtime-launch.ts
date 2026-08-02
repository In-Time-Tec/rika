import { Config, Effect, Function, Option, Path, Schema } from "effect"

const encodeLaunchArgumentsImpl = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))
export const encodeLaunchArguments: {
  (): (input: ReadonlyArray<string>) => string
  (input: ReadonlyArray<string>): string
} = Function.dual((args) => args.length >= 1, encodeLaunchArgumentsImpl)

export interface RuntimeLaunch {
  readonly executable: string
  readonly prefixArguments: ReadonlyArray<string>
  readonly replaceProcess: boolean
}

export const privateRuntime = Effect.fn("ClientProcess.privateRuntime")(function* (role: "interactive" | "resident") {
  const path = yield* Path.Path
  const testExecutable = yield* Config.option(Config.string("RIKA_TEST_RUNTIME_EXECUTABLE"))
  if (Option.isSome(testExecutable))
    return { executable: testExecutable.value, prefixArguments: [], replaceProcess: false }
  const entrypoint = role === "interactive" ? "interactive-main.ts" : "resident-main.ts"
  return import.meta.path.startsWith("/$bunfs/")
    ? {
        executable: path.join(path.dirname(process.execPath), `.rika-${role}`),
        prefixArguments: [],
        replaceProcess: role === "interactive",
      }
    : {
        executable: process.execPath,
        prefixArguments: [path.join(import.meta.dir, "..", entrypoint)],
        replaceProcess: false,
      }
})

export const inheritedEnvironment = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
